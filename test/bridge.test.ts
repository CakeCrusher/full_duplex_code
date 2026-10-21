import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Harness } from '../src/core/bridge.ts';
import { EventEmitter } from 'node:events';
import { Mediator } from '../src/core/mediator.ts';
import { voiceProvenance, voiceRequest } from '../src/core/prompts.ts';
import { claude } from '../src/adapters/claude/index.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-server-'));
  const harness = await new Harness({ agent: claude, root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused-test-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return harness;
}

test('ledger failure allows repeated start attempts and does not hang harness shutdown', async t => {
  const h = await fixture(t); h.agentReady = true;
  h.ledger.reserve(29990, 'existing usage');
  fs.writeFileSync(`${h.ledger.file}.lock`, '');
  await assert.rejects(h.startLive(), /Usage ledger locked/);
  const first = h.live;
  assert.equal(h.status().live, 'closed');
  await assert.rejects(h.startLive(), /Usage ledger locked/);
  assert.notEqual(h.live, first, 'retry creates a fresh session instead of silently returning');
  assert.equal(h.live!.state, 'closed');
  assert.equal(h.ledger.summary().runs.length, 1);
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
  const channelHeaders = { Authorization: `Bearer ${h.agentToken}` };
  assert.equal((await fetch(h.baseUrl + '/hook', { method: 'POST', headers: channelHeaders, body: JSON.stringify({ ...hook, session_id: randomUUID() }) })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await fetch(h.baseUrl + '/hook', { method: 'POST', headers: channelHeaders, body: JSON.stringify(hook) })).status, 200);
  assert.equal(h.observer.text, 'Hello', 'duplicate display batches are not repeated');
});

test('hook context keeps flowing during continuous microphone and speaker activity', async t => {
  const h = await fixture(t), sent: { kind: string; content: string }[] = [], pending: (() => void)[] = [];
  const live: any = h.live = new EventEmitter() as any;
  Object.assign(live, { state: 'active', id: 'offline-duplex',
    append: (kind: string, content: string) => new Promise<void>(resolve => { sent.push({ kind, content }); pending.push(resolve); }),
    close: async () => { live.state = 'closed'; },
  });
  h.mediator = new Mediator({ live, observer: h.observer, deliver: () => {}, log: h.log, publish: e => h.publish(e), clean: h.clean });
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${h.browserToken}` } });
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  async function audio(inputRms: number, outputRms: number) {
    ws.send(JSON.stringify({ type: 'audio_level', at: Date.now(), durationMs: 100, inputRms, outputRms, gateThreshold: 0 }));
    // The pong arrives after the preceding audio-level message was handled.
    await new Promise(resolve => { ws.once('pong', resolve); ws.ping(); });
  }
  const observations: any[] = [];
  for (const [index, name] of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'MessageDisplay', 'Stop'].entries()) {
    await audio(.0016, .12); // Gate off: quiet background noise stays nonzero.
    const hook = { session_id: h.sessionId, hook_event_name: name, message_id: 'reply', index,
      prompt: 'Inspect the whole file.', tool_name: 'Edit', tool_response: { stdout: '世界👋'.repeat(120) },
      delta: 'The edit is complete.', last_assistant_message: 'Done.', future_field: 'retained',
    };
    observations.push(hook);
    const response = await fetch(h.baseUrl + '/hook', { method: 'POST', headers: { Authorization: `Bearer ${h.agentToken}` }, body: JSON.stringify(hook) });
    assert.equal(response.status, 200);
  }
  assert.ok(sent.length >= 1, 'context reaches Live while audio is active and ACKs are pending');
  assert.equal(h.mediator!.context.queue.length, 0);
  let fragment = 0;
  while (pending.length || h.mediator!.feed.pending.length) {
    await audio(fragment++ % 2 ? 0 : .0016, .12);
    pending.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
    h.mediator!.feed.flush();
  }
  assert.equal(h.mediator!.context.queue.length, 0, 'continuous audio cannot starve context');
  assert.equal(h.mediator!.context.inFlight, 0);
  assert.ok(sent.every(e => e.kind === 'thinking'));
  const reconstructed = sent.map(e => e.content.replace(/^\[[^\n]+\]\n\[Claude [^\n]+\]\n/, '')).join('');
  for (const hook of observations) assert.equal(reconstructed.includes(`"hook":"${hook.hook_event_name}"`), hook.hook_event_name !== 'Stop', 'every hook but Stop reaches Live');
  assert.match(reconstructed, /future_field.*retained/);
  assert.deepEqual(h.observer.observations.map(o => JSON.parse(o.text)), observations, 'all original observations stay intact locally');
});

test('channel delivery ends at sent and does not depend on Claude calling a tool', async t => {
  const h = await fixture(t);
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/channel', { headers: { Authorization: `Bearer ${h.agentToken}` } });
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  const delivery = new Promise<any>(resolve => ws.once('message', data => resolve(JSON.parse(data.toString()))));
  ws.send(JSON.stringify({ type: 'channel.ready' }));
  const content = voiceRequest([{ role: 'intermediary', text: 'Yes.' }, { role: 'operator', text: 'Hello 世界.' }]) + '\n';
  h.deliver({ id: 'one', content });
  const delivered = await delivery;
  assert.equal(delivered.id, 'one');
  const shown = h.uiEvents.filter(e => e.type === 'task').at(-1)!;
  assert.equal(shown.text, delivered.content);
  assert.equal(shown.notification.params.content, delivered.content);
  assert.equal(shown.state, 'dispatching');
  assert.equal(h.outbox.get('one')!.state, 'dispatching');
  ws.send(JSON.stringify({ type: 'channel.sent', id: 'one' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.outbox.get('one')!.state, 'sent');
  assert.ok(h.uiEvents.some(e => e.type === 'task' && e.id === 'one' && e.state === 'sent'));
  assert.equal(h.observer.state, 'starting', 'transport delivery does not invent agent progress');
  const prompt = `<channel source="voice" message_id="one" source_kind="voice_operator">\n${content}\n</channel>`;
  h.observer.hook({ session_id: h.sessionId, hook_event_name: 'UserPromptSubmit', prompt });
  const item = h.timeline.snapshot().items.find(i => i.requestId === 'one')!;
  assert.equal(item.contentMatches, true);
  assert.equal(item.observedPrompt, prompt);
  assert.equal(item.text, content);
});

test('the delivery confirmation follows channel success once, independently of hook context', async t => {
  const h = await fixture(t), appends: { kind: string; content: string; delegationId?: string | null }[] = [];
  h.live = { id: 'voice-one', state: 'active', append: async (kind: string, content: string, delegationId?: string | null) => appends.push({ kind, content, delegationId }), close: async () => { h.live!.state = 'closed'; } } as any;
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/channel', { headers: { Authorization: `Bearer ${h.agentToken}` } });
  t.after(() => ws.terminate()); await new Promise(resolve => ws.on('open', resolve));
  async function event(data: Record<string, unknown>) {
    ws.send(JSON.stringify(data));
    await new Promise(resolve => { ws.once('pong', resolve); ws.ping(); });
  }
  h.deliver({ id: 'request-one', content: 'Build the game.', voiceSessionId: 'voice-one', delegationId: 'delegation-one' });
  assert.equal(h.outbox.get('request-one')!.state, 'queued');
  assert.equal(appends.length, 0, 'queuing is not confirmed delivery');
  await event({ type: 'channel.ready' });
  assert.equal(h.outbox.get('request-one')!.state, 'dispatching');
  assert.equal(appends.length, 0, 'writing to the channel socket is not channel success');
  await event({ type: 'channel.sent', id: 'request-one' });
  assert.deepEqual(appends, [{ kind: 'thinking', content: 'The request has been delivered to Claude Code. Confirm it briefly, unless the operator asked you not to.', delegationId: 'delegation-one' }], 'quietly: GPT Live confirms as its instructions say');
  await event({ type: 'channel.sent', id: 'request-one' });
  assert.equal(appends.length, 1, 'a duplicate receipt cannot repeat the spoken confirmation');
  h.deliver({ id: 'old-request', content: 'Earlier request.', voiceSessionId: 'old-voice', delegationId: 'old-delegation' });
  await event({ type: 'channel.sent', id: 'old-request' });
  assert.equal(appends.length, 1, 'a new voice connection must not receive an old delegation ID or confirmation');
  h.live!.append = async () => { throw new Error('test refusal'); };
  h.deliver({ id: 'refused-speech', content: 'Still sent.', voiceSessionId: 'voice-one' });
  await event({ type: 'channel.sent', id: 'refused-speech' });
  assert.equal(h.outbox.get('refused-speech')!.state, 'sent', 'failure to announce is not failure to deliver');
  assert.ok(h.uiEvents.some(e => e.type === 'fault' && /request was sent.*voice confirmation failed/i.test(e.message)));
});

test('every delivered request is confirmed once', async t => {
  const h = await fixture(t), appends: { kind: string; content: string }[] = [];
  h.live = { id: 'voice-one', state: 'active', append: async (kind: string, content: string) => appends.push({ kind, content }), close: async () => { h.live!.state = 'closed'; } } as any;
  const channel = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/channel', { headers: { Authorization: `Bearer ${h.agentToken}` } });
  t.after(() => channel.terminate());
  await new Promise(resolve => channel.on('open', resolve));
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  channel.send(JSON.stringify({ type: 'channel.ready' }));
  h.deliver({ id: 'build', content: 'Build.', voiceSessionId: 'voice-one' });
  channel.send(JSON.stringify({ type: 'channel.sent', id: 'build' })); await settle();
  channel.send(JSON.stringify({ type: 'channel.sent', id: 'build' })); await settle();
  assert.deepEqual(appends.map(a => a.content), ['The request has been delivered to Claude Code. Confirm it briefly, unless the operator asked you not to.']);
});

test('the actual command hook relays a typed prompt into observer history and browser activity', async t => {
  const h = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/core/hook-relay.ts', import.meta.url)), h.baseUrl + '/hook'], {
    env: { ...process.env, FD_BRIDGE_TOKEN: h.agentToken }, stdio: ['pipe', 'pipe', 'pipe'],
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

test('the command hook tells Claude that a voice request the bridge delivered is the operator\'s own speech, and nothing else', async t => {
  const h = await fixture(t);
  const relay = async (event: Record<string, unknown>) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/core/hook-relay.ts', import.meta.url)), h.baseUrl + '/hook'], { env: { ...process.env, FD_BRIDGE_TOKEN: h.agentToken }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    const done = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ session_id: h.sessionId, ...event }));
    assert.equal(await done, 0);
    return JSON.parse(stdout);
  };
  const id = randomUUID();
  h.deliver({ id, content: 'Please also create voice.txt.', delegationId: null });
  const channel = (messageId: string) => `<channel source="voice" message_id="${messageId}" source_kind="voice_operator">\nPlease also create voice.txt.\n</channel>`;
  assert.deepEqual(await relay({ hook_event_name: 'UserPromptSubmit', prompt: channel(id) }),
    { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: voiceProvenance() } });
  assert.deepEqual(await relay({ hook_event_name: 'UserPromptSubmit', prompt: channel(randomUUID()) }), {}, 'a channel message this bridge did not send gets no word for it');
  assert.deepEqual(await relay({ hook_event_name: 'UserPromptSubmit', prompt: 'typed here' }), {});
  assert.deepEqual(await relay({ hook_event_name: 'PostToolUse', tool_name: 'Read' }), {});
});

test('the command hook preserves large structured results, new fields, and UTF-8 while redacting credentials', async t => {
  const h = await fixture(t);
  const observed: any[] = []; h.observer.on('observation', e => observed.push(e));
  const tool = { session_id: h.sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'one',
    tool_input: { command: 'node check.mjs' }, duration_ms: 854,
    tool_response: { stdout: 'HEAD\n' + '世界👋\n'.repeat(120000) + 'TAIL', stderr: h.apiKey },
    future_field: { nested: ['retained', h.agentToken] },
  };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/core/hook-relay.ts', import.meta.url)), h.baseUrl + '/hook'], {
    env: { ...process.env, FD_BRIDGE_TOKEN: h.agentToken }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end(JSON.stringify(tool));
  assert.equal(await done, 0); assert.equal(stderr, '');
  assert.equal(observed.length, 1);
  assert.deepEqual(JSON.parse(observed[0].text), { ...tool, tool_response: { ...tool.tool_response, stderr: '[redacted]' }, future_field: { nested: ['retained', '[redacted]'] } });
});

test('starting voice greets once and appends no extra instructions', async t => {
  const { LiveSession } = await import('../src/core/live-session.ts');
  const appends: { kind: string; text: string }[] = []; let greetings = 0;
  t.mock.method(LiveSession.prototype, 'start', async function (this: any) {
    this.state = 'active'; this.id = this.reservation = 'offline-startup'; this.startedAt = Date.now();
    this.emit('event', { type: 'session.started' });
  });
  t.mock.method(LiveSession.prototype, 'append', async function (kind: string, text: string) { appends.push({ kind, text }); });
  t.mock.method(LiveSession.prototype, 'greet', async () => { greetings++; });
  t.mock.method(LiveSession.prototype, 'close', async function (this: any) {
    this.state = 'closed'; this.emit('closed', { finalized: true });
  });
  const h = await fixture(t); h.agentReady = true;
  await h.startLive();
  assert.match(h.live!.instructions, /When to speak/);
  assert.equal(appends.length, 0); assert.equal(greetings, 1);
  await h.live!.close(); await h.startLive();
  assert.equal(appends.length, 0); assert.equal(greetings, 2, 'each voice connection greets once');
});

test('pages get GPT Live’s usage reports for the voice session, also when they connect later', async t => {
  const { LiveSession } = await import('../src/core/live-session.ts');
  t.mock.method(LiveSession.prototype, 'start', async function (this: any) {
    this.state = 'active'; this.id = this.reservation = 'offline-usage'; this.startedAt = Date.now();
    this.emit('event', { type: 'session.started' });
  });
  t.mock.method(LiveSession.prototype, 'append', async () => {});
  t.mock.method(LiveSession.prototype, 'greet', async () => {});
  t.mock.method(LiveSession.prototype, 'close', async function (this: any) {
    this.state = 'closed'; this.emit('closed', { finalized: true });
  });
  const h = await fixture(t); h.agentReady = true;
  const reports: any[] = [], publish = h.publish;
  h.publish = (event, page) => { if (event.type === 'live_usage') reports.push(event); publish(event, page); };
  await h.startLive();
  assert.deepEqual([reports.length, reports[0].voiceSessionId, reports[0].ratio], [1, 'offline-usage', null]);
  h.live!.emit('event', { type: 'session.usage.updated', usage: { seconds: 15 }, context_window: { usage_ratio: .034 } });
  assert.deepEqual([reports.at(-1).ratio, reports.at(-1).seconds, reports.at(-1).points.length], [.034, 15, 1]);
  assert.deepEqual(h.status().liveUsage!.points.map(([, ratio]) => ratio), [.034], 'the status carries it for a page that connects now');
  await h.live!.close();
  assert.ok(reports.at(-1).endedAt >= reports.at(-1).startedAt, 'the meters stop where the session ended');
  assert.equal(h.status().liveUsage!.endedAt, reports.at(-1).endedAt);
});

test('a voice session that ends sends the unsent speech to the agent with the reason', async t => {
  const { LiveSession } = await import('../src/core/live-session.ts');
  t.mock.method(LiveSession.prototype, 'start', async function (this: any) {
    this.state = 'active'; this.id = this.reservation = 'offline-handoff'; this.startedAt = Date.now();
    this.emit('event', { type: 'session.started' });
  });
  t.mock.method(LiveSession.prototype, 'append', async () => {});
  t.mock.method(LiveSession.prototype, 'greet', async () => {});
  t.mock.method(LiveSession.prototype, 'close', async function (this: any, reason: string) {
    this.state = 'closed'; this.emit('closed', { finalized: true, reserved: true, usageSeconds: 1, reason });
  });
  const h = await fixture(t); h.agentReady = true;
  await h.startLive();
  h.live!.emit('event', { type: 'session.input_transcript.delta', delta: 'Rename the file to notes', start_ms: 0, end_ms: 900 });
  await h.live!.close('Microphone audio stream stopped');
  const sent = [...h.outbox.values()];
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^\[Voice session ended: Microphone audio stream stopped\]/);
  assert.match(sent[0].content, /user: Rename the file to notes$/);
});

test('additional instructions preserve the base, show exact text, and wait for an ACK', async t => {
  const h = await fixture(t);
  await h.appendInstruction('Explain unfamiliar terms.');
  assert.equal(h.status().prompt.additional[0].state, 'next_session');
  assert.match(h.status().prompt.instructions, /Delegation policy:/);
  assert.match(h.status().prompt.instructions, /Explain unfamiliar terms\./);
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void; const sent: { kind: string; text: string }[]=[];
  const live: any=h.live={id:'one',state:'active',instructions:h.instructions(),append:(kind: string,text: string)=>{
    sent.push({kind,text});return new Promise((yes,no)=>{resolve=yes;reject=no;});
  },close:async()=>{live.state='closed';}} as any;
  const startup=live.instructions;
  const pending=h.appendInstruction('Use an example about paper airplanes.');
  assert.deepEqual(sent,[{kind:'instructions',text:'Use an example about paper airplanes.'}]);
  assert.equal(h.status().prompt.additional.at(-1)!.state,'pending');
  resolve();await pending;
  assert.equal(h.status().prompt.additional.at(-1)!.state,'acknowledged');
  assert.equal(live.instructions,startup,'startup prompt remains an exact record');
  assert.equal(h.status().prompt.instructions,`${startup}\n\nUse an example about paper airplanes.`,'the acknowledged instruction shows as part of the prompt');
  const failed=h.appendInstruction('Use metric units.');reject(new Error('test rejection'));await failed;
  assert.equal(h.status().prompt.additional.at(-1)!.state,'failed');
  const late=h.appendInstruction('Finish the explanation.');await live.close();resolve();await late;
  assert.equal(h.status().prompt.additional.at(-1)!.state,'next_session','late ACK cannot confirm a closed session');
  assert.match(h.instructions(),/Finish the explanation\./,'retained for the next connection');
  await assert.rejects(h.appendInstruction(' '),/Enter/);
  await assert.rejects(h.appendInstruction('x'.repeat(441)),/shorten/);
});

test('receiver diagnostics retain concealment over time and reject stale voice sessions', async t => {
  const h = await fixture(t);
  h.live = { id: 'current-voice', state: 'active', reservation: 'audit-run', close: async () => {} } as any;
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${h.browserToken}` } });
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  h.voiceSessions.page = [...h.pages.all.values()][0]; // The voice session belongs to this page.
  const send = async (voiceSessionId: string, stats: Record<string, unknown>) => {
    ws.send(JSON.stringify({ type: 'audio_transport', at: Date.now(), voiceSessionId, stats }));
    await new Promise(resolve => { ws.once('pong', resolve); ws.ping(); });
  };
  await send('current-voice', { clockRate: 48000, packetsLost: 2, concealedSamples: 2400 });
  await send('current-voice', { clockRate: 48000, packetsLost: 0, concealedSamples: 4800, jitter: 'invalid', unrelated: 'not retained' });
  await send('old-voice', { concealedSamples: 999999 });
  const events = fs.readFileSync(path.join(h.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'audio.transport');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.stats.packetsLost), [2, 0], 'late packets may reduce the final loss count');
  assert.deepEqual(events.map(e => e.stats.concealedSamples), [2400, 4800], 'earlier audible repairs remain visible');
  assert.deepEqual(events[1].stats, { clockRate: 48000, packetsLost: 0, concealedSamples: 4800 });
  assert.ok(events.every(e => e.liveRun === 'audit-run' && e.voiceSessionId === 'current-voice'));
});

test('the default port yields to a busy port only when fallback is allowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-port-'));
  const options = { agent: claude, root: path.resolve(fileURLToPath(new URL('..', import.meta.url))), cwd: dir, sessionId: randomUUID(), apiKey: 'test-key-unused' };
  const first = await new Harness({ ...options, runDir: path.join(dir, 'a') }).start();
  const port = Number(new URL(first.baseUrl).port);
  const second = await new Harness({ ...options, runDir: path.join(dir, 'b'), port, portFallback: true }).start();
  assert.equal(second.portFellBack, true);
  assert.notEqual(new URL(second.baseUrl).port, String(port));
  await assert.rejects(new Harness({ ...options, runDir: path.join(dir, 'c'), port }).start(), { code: 'EADDRINUSE' });
  await second.close(); await first.close();
});

test('a tunnel public URL admits the page and /voice, but never hooks or the channel', async t => {
  const http = await import('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-server-'));
  // The repository root, so the real page files are served; nothing is written there.
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const h = await new Harness({ agent: claude, root: repo, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused-test-key', publicUrl: 'https://voice.example.com' }).start();
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(h.publicBrowserUrl, `https://voice.example.com/#${h.browserToken}`);
  const port = new URL(h.baseUrl).port;
  // Node's fetch cannot set Host, so send raw requests as the tunnel would.
  const request = (pathName: string, headers: Record<string, string>, method = 'GET', body?: string) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
  const tunnel = { Host: 'voice.example.com', 'X-Forwarded-For': '203.0.113.9', 'Cf-Connecting-Ip': '203.0.113.9' };
  assert.equal(await request('/', tunnel), 200, 'the page loads through the tunnel');
  assert.equal(await request('/api/status', { ...tunnel, Origin: 'https://voice.example.com', Authorization: `Bearer ${h.browserToken}` }), 200);
  assert.equal(await request('/api/status', { ...tunnel, Origin: 'https://evil.example', Authorization: `Bearer ${h.browserToken}` }), 403);
  assert.equal(await request('/', { Host: 'other.example.com' }), 403, 'unknown hosts are still refused');
  const hook = JSON.stringify({ session_id: h.sessionId, hook_event_name: 'Stop' });
  const hookHeaders = { Authorization: `Bearer ${h.agentToken}`, 'Content-Type': 'application/json' };
  assert.equal(await request('/hook', { ...tunnel, ...hookHeaders }, 'POST', hook), 403, 'hooks never arrive through the tunnel');
  assert.equal(await request('/hook', { Host: new URL(h.baseUrl).host, 'X-Forwarded-For': '203.0.113.9', ...hookHeaders }, 'POST', hook), 403, 'even with a rewritten Host header');
  assert.equal(await request('/hook', { Host: new URL(h.baseUrl).host, ...hookHeaders }, 'POST', hook), 200, 'the local command hook still works');
  const open = (headers: Record<string, string>, route = '/voice', protocols = ['fd-voice', h.browserToken]) => new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`, protocols, { headers });
    ws.on('open', () => { ws.terminate(); resolve('open'); }); ws.on('error', () => resolve('refused'));
  });
  assert.equal(await open({ ...tunnel, Origin: 'https://voice.example.com' }), 'open', 'the phone page reaches /voice');
  assert.equal(await open({ ...tunnel, Origin: 'https://evil.example' }), 'refused');
  assert.equal(await open({ ...tunnel, Authorization: `Bearer ${h.agentToken}` }, '/channel', []), 'refused', 'the channel is local only');
});

test('pages get agent observations without their binary data, which stays in the local log', async t => {
  const h = await fixture(t);
  const image = 'iVBORw0KGgo' + 'A'.repeat(1_400_000), published: any[] = [];
  const publish = h.publish; h.publish = (event, page) => { published.push(event); publish(event, page); };
  const hook = { session_id: h.sessionId, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { file: { base64: image } } };
  assert.equal((await fetch(h.baseUrl + '/hook', { method: 'POST', headers: { Authorization: `Bearer ${h.agentToken}` }, body: JSON.stringify(hook) })).status, 200);
  const observation = published.find(e => e.type === 'agent_observation');
  assert.ok(observation.text.length < 2000, 'a 1.4 MB image does not reach the page');
  assert.match(observation.text, /\[omitted: 1,400,011 chars\]/);
  assert.equal(observation.raw, undefined);
  assert.ok(h.observer.observations[0].text.includes(image), 'the local record keeps every byte');
});
