import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Harness } from '../src/server.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-server-'));
  const harness = await new Harness({ root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused-test-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return harness;
}

test('budget failure allows repeated start attempts and does not hang harness shutdown', async t => {
  const h = await fixture(t); h.channelReady = true;
  h.budget.reserve(29990, 'existing usage');
  await assert.rejects(h.startLive(), /budget would be exceeded/);
  const first = h.live;
  assert.equal(h.status().live, 'closed');
  assert.equal(h.status().speakingUpdate.state, 'next_session');
  await assert.rejects(h.startLive(), /budget would be exceeded/);
  assert.notEqual(h.live, first, 'retry creates a fresh session instead of silently returning');
  assert.equal(h.live.state, 'closed');
  assert.equal(h.budget.summary().runs.length, 1);
  await h.close();
});
test('local endpoints require the correct capability and reject foreign origins and sessions', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(h.baseUrl + '/api/status')).status, 403);
  const headers = { Authorization: `Bearer ${h.browserToken}` };
  assert.equal((await fetch(h.baseUrl + '/api/status', { headers })).status, 200);
  assert.equal((await fetch(h.baseUrl + '/api/status', { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
  const hook = { session_id: h.sessionId, hook_event_name: 'MessageDisplay', message_id: 'a', index: 0, final: true, delta: 'Hello' };
  assert.equal((await fetch(h.baseUrl + '/hook', { method: 'POST', headers, body: JSON.stringify(hook) })).status, 403);
  const channelHeaders = { Authorization: `Bearer ${h.channelToken}` };
  assert.equal((await fetch(h.baseUrl + '/hook', { method: 'POST', headers: channelHeaders, body: JSON.stringify({ ...hook, session_id: randomUUID() }) })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await fetch(h.baseUrl + '/hook', { method: 'POST', headers: channelHeaders, body: JSON.stringify(hook) })).status, 200);
  assert.equal(h.observer.text, 'Hello', 'duplicate display batches are not repeated');
});

test('speaking preference updates the active model through instructions and validates values', async t => {
  const h=await fixture(t), appends=[];
  const ws=new WebSocket(h.baseUrl.replace('http:','ws:')+'/voice',{headers:{Authorization:`Bearer ${h.browserToken}`}});
  t.after(()=>ws.terminate());await new Promise(resolve=>ws.on('open',resolve));
  h.live={state:'active',append:async(kind,text)=>appends.push({kind,text}),close:async()=>{h.live.state='closed';}};
  ws.send(JSON.stringify({type:'speaking_level',level:0}));await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.speakingLevel,0);assert.equal(appends[0].kind,'instructions');assert.match(appends[0].text,/Quiet:/);
  ws.send(JSON.stringify({type:'speaking_level',level:20}));await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.speakingLevel,0);assert.equal(appends.length,1);
});
test('channel delivery ends at sent and does not depend on Claude calling a tool', async t => {
  const h = await fixture(t);
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/channel', { headers: { Authorization: `Bearer ${h.channelToken}` } });
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  const delivery = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data))));
  ws.send(JSON.stringify({ type: 'channel.ready' }));
  const content = 'User request (transcribed speech):\nHello 世界.\n\nEarlier voice conversation for reference only:\nintermediary: Yes.\n';
  h.deliver({ id: 'one', text: 'lossy short preview', content });
  const delivered = await delivery;
  assert.equal(delivered.id, 'one');
  const shown = h.uiEvents.filter(e => e.type === 'task').at(-1);
  assert.equal(shown.text, delivered.content);
  assert.equal(shown.notification.params.content, delivered.content);
  assert.equal(shown.state, 'dispatching');
  assert.equal(h.outbox.get('one').state, 'dispatching');
  ws.send(JSON.stringify({ type: 'channel.sent', id: 'one' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.outbox.get('one').state, 'sent');
  assert.ok(h.uiEvents.some(e => e.type === 'task' && e.id === 'one' && e.state === 'sent'));
  assert.equal(h.observer.state, 'starting', 'transport delivery does not invent agent progress');
  const prompt = `<channel source="voice" message_id="one" source_kind="voice_operator">\n${content}\n</channel>`;
  h.observer.hook({ session_id: h.sessionId, hook_event_name: 'UserPromptSubmit', prompt });
  const item = h.timeline.snapshot().items.find(i => i.requestId === 'one');
  assert.equal(item.contentMatches, true);
  assert.equal(item.observedPrompt, prompt);
  assert.equal(item.text, content);
});

test('the actual command hook relays a typed prompt into observer history and browser activity', async t => {
  const h = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/hook.js', import.meta.url)), h.baseUrl + '/hook'], {
    env: { ...process.env, FD_BRIDGE_TOKEN: h.channelToken }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end(JSON.stringify({ session_id: h.sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'Remember ORCHID ' + h.apiKey }));
  assert.equal(await done, 0); assert.equal(stderr, ''); assert.equal(stdout, '{}\n');
  assert.deepEqual(JSON.parse(h.observer.conversationContext()), [{ role: 'input', text: 'Remember ORCHID [redacted]' }]);
  assert.ok(h.uiEvents.some(e => e.type === 'agent_input' && e.text === 'Remember ORCHID [redacted]'));
  assert.equal(h.outbox.size, 0, 'observing an existing prompt does not send a channel request');
});

test('the command hook preserves large structured results, new fields, and UTF-8 while redacting credentials', async t => {
  const h = await fixture(t);
  const observed = []; h.observer.on('observation', e => observed.push(e));
  const tool = { session_id: h.sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'one',
    tool_input: { command: 'node check.mjs' }, duration_ms: 854,
    tool_response: { stdout: 'HEAD\n' + '世界👋\n'.repeat(120000) + 'TAIL', stderr: h.apiKey },
    future_field: { nested: ['retained', h.channelToken] },
  };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/hook.js', import.meta.url)), h.baseUrl + '/hook'], {
    env: { ...process.env, FD_BRIDGE_TOKEN: h.channelToken }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end(JSON.stringify(tool));
  assert.equal(await done, 0); assert.equal(stderr, '');
  assert.equal(observed.length, 1);
  assert.deepEqual(JSON.parse(observed[0].text), { ...tool, tool_response: { ...tool.tool_response, stderr: '[redacted]' }, future_field: { nested: ['retained', '[redacted]'] } });
});

test('preference status waits for the matching acknowledgment and reports failures and offline changes', async t => {
  const h = await fixture(t), pending = [];
  assert.equal(h.speakingLevel, 2, 'Walkthrough is the default');
  assert.equal(h.status().speakingUpdate.state, 'next_session');
  await h.setSpeakingLevel(0);
  assert.equal(h.status().speakingUpdate.level, 0);
  const live = h.live = { id: 'offline', state: 'active',
    append: (kind, text) => new Promise((resolve, reject) => pending.push({ kind, text, resolve, reject })),
    close: async () => { live.state = 'closed'; },
  };
  const first = h.setSpeakingLevel(1);
  assert.equal(h.status().speakingUpdate.state, 'pending');
  const second = h.setSpeakingLevel(2);
  pending[0].resolve(); await first;
  assert.equal(h.status().speakingUpdate.state, 'pending', 'the earlier ACK cannot confirm the newest selection');
  assert.equal(h.status().speakingUpdate.level, 2);
  pending[1].resolve(); await second;
  assert.equal(h.status().speakingUpdate.state, 'acknowledged');
  assert.equal(h.status().speakingUpdate.confirmedLevel, 2);
  const failed = h.setSpeakingLevel(0);
  pending[2].reject(new Error('append timed out')); await failed;
  assert.equal(h.status().speakingUpdate.state, 'failed');
  assert.equal(h.status().speakingUpdate.confirmedLevel, 2);
  assert.match(h.status().speakingUpdate.error, /timed out/);
  const late = h.setSpeakingLevel(1);
  await live.close();
  assert.equal(h.status().speakingUpdate.state, 'next_session');
  pending[3].resolve(); await late;
  assert.equal(h.status().speakingUpdate.state, 'next_session', 'closed-session ACK does not claim to be active');
});

test('a preference changed during startup reaches the new conversation; Quiet has no unsolicited greeting', async t => {
  const { LiveSession } = await import('../src/live.js');
  let release; const ready = new Promise(resolve => { release = resolve; });
  const appends = []; let greetings = 0;
  t.mock.method(LiveSession.prototype, 'start', async function () {
    this.state = 'connecting'; await ready;
    this.state = 'active'; this.id = this.reservation = 'offline-startup'; this.startedAt = Date.now();
    this.emit('event', { type: 'session.started' });
  });
  t.mock.method(LiveSession.prototype, 'append', async function (kind, text) { appends.push({ kind, text }); });
  t.mock.method(LiveSession.prototype, 'greet', async () => { greetings++; });
  t.mock.method(LiveSession.prototype, 'close', async function () {
    this.state = 'closed'; this.emit('closed', { finalized: true });
  });
  const h = await fixture(t); h.channelReady = true;
  const starting = h.startLive();
  assert.equal(h.status().speakingUpdate.state, 'starting');
  await h.setSpeakingLevel(0);
  assert.equal(h.status().speakingUpdate.state, 'starting');
  release(); await starting;
  assert.equal(appends.length, 1); assert.equal(appends[0].kind, 'instructions');
  assert.match(appends[0].text, /Quiet:/);
  assert.equal(h.status().speakingUpdate.state, 'acknowledged');
  assert.equal(h.status().speakingUpdate.confirmedLevel, 0);
  assert.equal(greetings, 0);
  await h.live.close(); await h.startLive();
  assert.equal(appends.length, 1, 'preselected mode is already in startup instructions');
  assert.equal(h.status().speakingUpdate.source, 'startup');
  assert.equal(greetings, 0);
});
