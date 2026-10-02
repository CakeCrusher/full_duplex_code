import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Harness } from '../src/core/bridge.ts';
import { voiceRequest } from '../src/core/prompts.ts';
import { pi } from '../src/adapters/pi/index.ts';
import { readPiArgs } from '../src/adapters/pi/arguments.ts';
import { piArgs } from '../src/adapters/pi/launch.ts';
import { PiObserver } from '../src/adapters/pi/observer.ts';
import { receivedRequest, turnText } from '../src/adapters/pi/message.ts';
import companion, { OBSERVED_EVENTS } from '../src/adapters/pi/extension.ts';

const until = async <T>(check: () => T, label = 'condition') => {
  for (let i = 0; i < 300; i++) { const result = check(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`Timed out waiting for ${label}`);
};

test("Pi's arguments: subcommands and help run without the companion; one-shot modes are refused", () => {
  for (const args of [['install', 'npm:x'], ['mcp', 'list'], ['config'], ['--version'], ['-h'], ['--list-models'], ['--export', 'a.jsonl']]) {
    assert.equal(readPiArgs(args).direct, true, args.join(' '));
  }
  assert.throws(() => readPiArgs(['-p', 'hello']), /answers once and exits/);
  assert.throws(() => readPiArgs(['--print']), /answers once and exits/);
  assert.throws(() => readPiArgs(['--mode', 'json']), /no interactive session/);
  assert.throws(() => readPiArgs(['--mode=rpc']), /no interactive session/);
  assert.deepEqual(readPiArgs(['--mode', 'text', '--model', 'sonnet:high', 'fix the tests']), { direct: false, resume: false, sessionId: undefined, assignSession: false });
  for (const args of [['-c'], ['--continue'], ['--resume'], ['--session', 'abc'], ['--fork', 'abc']]) assert.equal(readPiArgs(args).resume, true, args.join(' '));
  assert.equal(readPiArgs(['--name', '-p']).direct, false, 'an option value is never read as an option');
  assert.equal(readPiArgs(['--', '-p looks like an option']).direct, false, 'everything after -- is the prompt');
  assert.deepEqual(piArgs('/fdc', ['--no-extensions', '--continue']), ['-e', '/fdc/src/adapters/pi/extension.ts', '--no-extensions', '--continue'], "the extension first, then the operator's arguments unchanged");
});

test('a voice request is labeled for Pi and recognized when Pi reports it as input', () => {
  const id = randomUUID(), content = voiceRequest([{ role: 'operator', text: 'Make “世界” blue. <|stream' }]);
  assert.deepEqual(receivedRequest(turnText({ id, content })), { id, content });
  assert.equal(receivedRequest('Make it blue'), undefined, 'typed input is not a voice request');
});

// The companion's extension, loaded as Pi would load it, against a real bridge.
async function bridged(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-pi-'));
  const harness = await new Harness({ agent: pi, root, runDir: path.join(root, 'run'), cwd: root, apiKey: 'unused-test-key' }).start();
  const launch = harness.agentLaunch!, saved = { url: process.env.FD_BRIDGE_URL, token: process.env.FD_BRIDGE_TOKEN };
  Object.assign(process.env, launch.env);
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: any) => void>(), sent: { content: string; options: unknown }[] = [];
  companion({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (content, options) => { sent.push({ content, options }); } });
  process.env.FD_BRIDGE_URL = saved.url; process.env.FD_BRIDGE_TOKEN = saved.token;
  if (saved.url === undefined) delete process.env.FD_BRIDGE_URL;
  if (saved.token === undefined) delete process.env.FD_BRIDGE_TOKEN;
  let session: string = randomUUID(), file = path.join(root, `2026-10-02T00-00-00-000Z_${session}.jsonl`);
  const ctx = { sessionManager: { getSessionId: () => session, getSessionFile: () => file } };
  const fire = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  t.after(async () => { fire('session_shutdown', { reason: 'quit' }); await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { harness, root, sent, fire, handlers, get session() { return session; }, switchTo(id: string) { session = id; file = path.join(root, `2026-10-02T00-00-01-000Z_${id}.jsonl`); } };
}

test('the extension forwards events in order to the bridge, which learns the session from the first one', async t => {
  const run = await bridged(t);
  assert.deepEqual([...run.handlers.keys()], OBSERVED_EVENTS, 'it listens only to the events it forwards');
  run.fire('session_start', { reason: 'startup' });
  await until(() => run.harness.agentReady, 'the request socket');
  assert.equal(run.harness.sessionId, run.session);
  run.fire('agent_start');
  run.fire('input', { text: 'List the files', source: 'interactive' });
  run.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
  run.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'README.md\n' }] }, isError: false });
  run.fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'One file.', textSignature: '{"v":1}' }], stopReason: 'stop' } });
  run.fire('agent_settled');
  const observer = run.harness.observer;
  await until(() => observer.state === 'idle' && observer.observations.length === 7, 'every event observed');
  assert.deepEqual(observer.observations.map(o => o.name), ['session_start', 'agent_start', 'input', 'tool_execution_start', 'tool_execution_end', 'message_end', 'agent_settled']);
  assert.deepEqual(observer.observations.map(o => o.state), ['unknown', 'working', 'working', 'working', 'working', 'working', 'turn_finished']);
  assert.deepEqual(observer.conversation, [{ role: 'input', text: 'List the files' }, { role: 'output', text: 'One file.' }]);
  assert.equal(observer.observations.at(-1)!.kind, 'turn_end');
});

test('a request reaches Pi once, as a steer, and is confirmed; a switched session keeps the companion attached', async t => {
  const run = await bridged(t);
  run.fire('session_start', { reason: 'startup' });
  await until(() => run.harness.agentReady, 'the request socket');
  const request = { id: randomUUID(), content: voiceRequest([{ role: 'intermediary', text: 'Sure.' }, { role: 'operator', text: 'Add a dark mode.' }]) };
  run.harness.deliver(request);
  const entry = run.harness.outbox.get(request.id)!;
  await until(() => entry.state === 'sent', 'delivery confirmed');
  assert.deepEqual(run.sent, [{ content: turnText(request), options: { deliverAs: 'steer' } }]);
  // A repeat of the same request on the socket is confirmed, never sent to Pi again.
  const confirmed: unknown[] = [];
  run.harness.adapter.on('delivery', event => confirmed.push(event));
  (run.harness.adapter as any).delivery.socket.send(JSON.stringify({ type: 'pi.deliver', id: request.id, content: request.content }));
  await until(() => confirmed.length === 1, 'second confirmation');
  assert.equal(run.sent.length, 1);
  // Pi reports the request as input; the timeline matches it to the request.
  run.fire('input', { text: turnText(request), source: 'extension' });
  await until(() => run.harness.timeline.requests.get(request.id)?.state === 'observed', 'request observed');
  assert.equal(run.harness.timeline.requests.get(request.id)!.contentMatches, true);
  // /new: Pi replaces the runtime, and the new session's first event moves the companion.
  run.fire('session_shutdown', { reason: 'new' });
  await until(() => !run.harness.agentReady, 'old socket closed');
  const next = randomUUID(); run.switchTo(next);
  run.fire('session_start', { reason: 'new' });
  await until(() => run.harness.sessionId === next && run.harness.agentReady, 'attached to the new session');
});

test("events from another Pi session are refused", async t => {
  const h = (await bridged(t)).harness;
  const headers = { Authorization: `Bearer ${h.agentToken}` };
  const post = (body: unknown) => fetch(h.baseUrl + '/hook', { method: 'POST', headers, body: JSON.stringify(body) }).then(r => r.status);
  const id = randomUUID();
  assert.equal(await post({ type: 'session_start', reason: 'startup', session_id: id }), 200);
  assert.equal(await post({ type: 'input', text: 'not ours', session_id: randomUUID() }), 409);
  assert.equal(await post({ type: 'input', text: 'no session' }), 409);
  assert.equal(h.observer.conversation.length, 0);
});

test('a failed or interrupted run, and a question waiting in the terminal, each show in the turn state', () => {
  const o = new PiObserver({}), id = randomUUID();
  const hook = (type: string, data: Record<string, unknown> = {}) => o.hook({ type, session_id: id, ...data });
  hook('session_start', { reason: 'startup' });
  hook('agent_start');
  hook('ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm', title: 'Allow?' });
  assert.equal(o.state, 'needs_attention'); assert.equal(o.turn, 'needs_operator');
  hook('ui_prompt_end', { reason: 'ui_prompt', kind: 'confirm' });
  assert.equal(o.turn, 'working');
  hook('message_end', { message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'rate limited' } });
  hook('agent_settled');
  assert.equal(o.state, 'failed'); assert.equal(o.turn, 'failed'); assert.equal(o.observations.at(-1)!.kind, 'turn_failed');
  hook('agent_start');
  hook('message_end', { message: { role: 'assistant', content: [], stopReason: 'aborted' } });
  hook('agent_settled');
  assert.equal(o.state, 'idle'); assert.equal(o.turn, 'turn_finished'); assert.equal(o.observations.at(-1)!.kind, 'turn_end');
  hook('session_shutdown', { reason: 'quit' });
  assert.equal(o.state, 'exited'); assert.equal(o.observations.at(-1)!.kind, 'session_end');
});

test("a resumed session's saved messages become history in the shapes Pi forwards live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-pi-session-')), id = randomUUID();
  const file = path.join(dir, `2026-10-02T04-58-33-988Z_${id}.jsonl`);
  const entries = [
    { type: 'session', version: 3, id, cwd: dir },
    { type: 'message', message: { role: 'system', content: '', sections: { preamble: 'You are an expert coding assistant' } } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'please write that to a temp file' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', thinkingSignature: 'x'.repeat(2000) }, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls /tmp' } }], stopReason: 'toolUse' } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'a.txt\n' }], isError: false } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Wrote it.' }], stopReason: 'stop' } },
  ];
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  try {
    const o = new PiObserver({}), live: unknown[] = [];
    o.on('observation', observation => live.push(observation));
    o.hook({ type: 'session_start', reason: 'startup', session_id: id, session_file: file });
    assert.deepEqual(o.conversation, [{ role: 'input', text: 'please write that to a temp file' }, { role: 'output', text: 'Wrote it.' }]);
    assert.deepEqual(o.observations.map(x => x.name), ['input', 'message_end', 'tool_execution_start', 'tool_execution_end', 'message_end', 'session_start']);
    assert.equal(live.length, 1, 'history is never sent as live context');
    assert.deepEqual(JSON.parse(o.observations[2].text).args, { command: 'ls /tmp' }, "a saved call's arguments arrive as a tool start, as live");
    o.hook({ type: 'session_start', reason: 'reload', session_id: id, session_file: file });
    assert.equal(o.conversation.length, 2, 'a session file is restored once');
    const other = new PiObserver({});
    other.hook({ type: 'session_start', reason: 'startup', session_id: randomUUID(), session_file: file });
    assert.equal(other.conversation.length, 0, "another session's file is never read");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
