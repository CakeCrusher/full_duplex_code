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
import { EventEmitter } from 'node:events';
import { Mediator } from '../src/mediator.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-server-'));
  const harness = await new Harness({ root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused-test-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return harness;
}

test('ledger failure allows repeated start attempts and does not hang harness shutdown', async t => {
  const h = await fixture(t); h.channelReady = true;
  h.budget.reserve(29990, 'existing usage');
  fs.writeFileSync(`${h.budget.file}.lock`, '');
  await assert.rejects(h.startLive(), /Usage ledger locked/);
  const first = h.live;
  assert.equal(h.status().live, 'closed');
  assert.equal(h.status().speakingUpdate.state, 'next_session');
  await assert.rejects(h.startLive(), /Usage ledger locked/);
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

test('hook context keeps flowing during continuous microphone and speaker activity', async t => {
  const h = await fixture(t), sent = [], pending = [];
  const live = h.live = new EventEmitter();
  Object.assign(live, { state: 'active', id: 'offline-duplex',
    append: (kind, content) => new Promise(resolve => { sent.push({ kind, content }); pending.push(resolve); }),
    close: async () => { live.state = 'closed'; },
  });
  h.mediator = new Mediator({ live, observer: h.observer, deliver: () => {}, log: h.log, publish: e => h.publish(e), clean: h.clean });
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${h.browserToken}` } });
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  async function audio(inputRms, outputRms) {
    ws.send(JSON.stringify({ type: 'audio_level', at: Date.now(), durationMs: 100, inputRms, outputRms, gateThreshold: 0 }));
    // The pong arrives after the preceding audio-level message was handled.
    await new Promise(resolve => { ws.once('pong', resolve); ws.ping(); });
  }
  const observations = [];
  for (const [index, name] of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'MessageDisplay', 'Stop'].entries()) {
    await audio(.0016, .12); // Gate off: quiet background noise stays nonzero.
    const hook = { session_id: h.sessionId, hook_event_name: name, message_id: 'reply', index,
      prompt: 'Inspect the whole file.', tool_name: 'Edit', tool_response: { stdout: '世界👋'.repeat(120) },
      delta: 'The edit is complete.', last_assistant_message: 'Done.', future_field: 'retained',
    };
    observations.push(hook);
    const response = await fetch(h.baseUrl + '/hook', { method: 'POST', headers: { Authorization: `Bearer ${h.channelToken}` }, body: JSON.stringify(hook) });
    assert.equal(response.status, 200);
  }
  assert.ok(sent.length > 5, 'all hook fragments reach Live while audio is active and ACKs are pending');
  assert.equal(h.mediator.context.queue.length, 0);
  let fragment = 0;
  while (pending.length) {
    await audio(fragment++ % 2 ? 0 : .0016, .12);
    pending.shift()();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(h.mediator.context.queue.length, 0, 'continuous audio cannot starve context');
  assert.equal(h.mediator.context.inFlight, 0);
  assert.ok(sent.every(e => e.kind === 'thinking'));
  const reconstructed = sent.map(e => e.content.replace(/^\[[^\n]+\]\n\[Claude [^\n]+\]\n/, '')).join('');
  assert.equal(reconstructed, observations.map(e => `Claude Code observation:\n${JSON.stringify(e)}\n`).join(''), 'every normal field and fragment arrives intact and in order');
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

test('spoken delivery confirmation follows channel success once, independently of hook context', async t => {
  const h = await fixture(t), appends = [];
  h.live = { id: 'voice-one', state: 'active', append: async (kind, content, delegationId) => appends.push({ kind, content, delegationId }), close: async () => { h.live.state = 'closed'; } };
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/channel', { headers: { Authorization: `Bearer ${h.channelToken}` } });
  t.after(() => ws.terminate()); await new Promise(resolve => ws.on('open', resolve));
  async function event(data) {
    ws.send(JSON.stringify(data));
    await new Promise(resolve => { ws.once('pong', resolve); ws.ping(); });
  }
  h.deliver({ id: 'request-one', content: 'Build the game.', voiceSessionId: 'voice-one', delegationId: 'delegation-one' });
  assert.equal(h.outbox.get('request-one').state, 'queued');
  assert.equal(appends.length, 0, 'queuing is not confirmed delivery');
  await event({ type: 'channel.ready' });
  assert.equal(h.outbox.get('request-one').state, 'dispatching');
  assert.equal(appends.length, 0, 'writing to the channel socket is not channel success');
  await event({ type: 'channel.sent', id: 'request-one' });
  assert.deepEqual(appends, [{ kind: 'commentary', content: 'Your request has been sent to Claude Code.', delegationId: 'delegation-one' }]);
  await event({ type: 'channel.sent', id: 'request-one' });
  assert.equal(appends.length, 1, 'a duplicate receipt cannot repeat the spoken confirmation');
  h.deliver({ id: 'old-request', content: 'Earlier request.', voiceSessionId: 'old-voice', delegationId: 'old-delegation' });
  await event({ type: 'channel.sent', id: 'old-request' });
  assert.equal(appends.length, 1, 'a new voice connection must not receive an old delegation ID or confirmation');
  h.live.append = async () => { throw new Error('test refusal'); };
  h.deliver({ id: 'refused-speech', content: 'Still sent.', voiceSessionId: 'voice-one' });
  await event({ type: 'channel.sent', id: 'refused-speech' });
  assert.equal(h.outbox.get('refused-speech').state, 'sent', 'failure to announce is not failure to deliver');
  assert.ok(h.uiEvents.some(e => e.type === 'fault' && /request was sent.*voice confirmation failed/i.test(e.message)));
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

test('additional instructions preserve the base, show exact text, and wait for an ACK', async t => {
  const h = await fixture(t);
  await h.appendInstruction('Explain unfamiliar terms.');
  assert.equal(h.status().prompt.additional[0].state, 'next_session');
  assert.match(h.status().prompt.instructions, /Conversation priority:/);
  assert.match(h.status().prompt.instructions, /Explain unfamiliar terms\./);
  let resolve, reject; const sent=[];
  const live=h.live={id:'one',state:'active',instructions:h.instructions(),append:(kind,text)=>{
    sent.push({kind,text});return new Promise((yes,no)=>{resolve=yes;reject=no;});
  },close:async()=>{live.state='closed';}};
  const startup=live.instructions;
  const pending=h.appendInstruction('Use an example about paper airplanes.');
  assert.deepEqual(sent,[{kind:'instructions',text:'Use an example about paper airplanes.'}]);
  assert.equal(h.status().prompt.additional.at(-1).state,'pending');
  resolve();await pending;
  assert.equal(h.status().prompt.additional.at(-1).state,'acknowledged');
  assert.equal(h.status().prompt.instructions,startup,'startup prompt remains an exact record');
  const failed=h.appendInstruction('Use metric units.');reject(new Error('test rejection'));await failed;
  assert.equal(h.status().prompt.additional.at(-1).state,'failed');
  const late=h.appendInstruction('Finish the explanation.');await live.close();resolve();await late;
  assert.equal(h.status().prompt.additional.at(-1).state,'next_session','late ACK cannot confirm a closed session');
  assert.match(h.instructions(),/Finish the explanation\./,'retained for the next connection');
  await assert.rejects(h.appendInstruction(' '),/Enter/);
  await assert.rejects(h.appendInstruction('x'.repeat(441)),/shorten/);
});

test('the default port yields to a busy port only when fallback is allowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-port-'));
  const options = { root: path.resolve(fileURLToPath(new URL('..', import.meta.url))), cwd: dir, sessionId: randomUUID(), apiKey: 'test-key-unused' };
  const first = await new Harness({ ...options, runDir: path.join(dir, 'a') }).start();
  const port = Number(new URL(first.baseUrl).port);
  const second = await new Harness({ ...options, runDir: path.join(dir, 'b'), port, portFallback: true }).start();
  assert.equal(second.portFellBack, true);
  assert.notEqual(new URL(second.baseUrl).port, String(port));
  await assert.rejects(new Harness({ ...options, runDir: path.join(dir, 'c'), port }).start(), { code: 'EADDRINUSE' });
  await second.close(); await first.close();
});
