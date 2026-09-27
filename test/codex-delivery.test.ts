import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexDelivery, receivedRequest, turnText } from '../src/adapters/codex/delivery.ts';
import { CodexAdapter, codex } from '../src/adapters/codex/index.ts';
import { CODEX_HOOKS, trustFlags, type ListedHook } from '../src/adapters/codex/app-server.ts';

const thread = 'thread-1', token = 'capability-token';
// A stand-in for Codex's app server: the JSON-RPC calls the adapter makes. An
// unsaved thread, like a new one before its first message, cannot be resumed.
async function fakeServer(t: TestContext, { steerError, hooks = [], saved = true, threads = {} }: { steerError?: string; hooks?: any[]; saved?: boolean; threads?: Record<string, any> } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: ({ req }: any) => req.headers.authorization === `Bearer ${token}` });
  await new Promise(resolve => server.once('listening', resolve));
  const calls: { method: string; params: any }[] = []; let client!: WebSocket;
  server.on('connection', ws => {
    client = ws;
    ws.on('message', raw => {
      const { id, method, params } = JSON.parse(raw.toString());
      if (id === undefined) return;
      calls.push({ method, params });
      const reply = (result: unknown) => ws.send(JSON.stringify({ id, result }));
      if (method === 'initialize') reply({ userAgent: 'fake' });
      else if (method === 'thread/resume' && !saved) ws.send(JSON.stringify({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } }));
      else if (method === 'thread/resume') reply({ thread: { id: params.threadId } });
      else if (method === 'thread/read' && threads[params.threadId]) reply({ thread: threads[params.threadId] });
      else if (method === 'thread/read') ws.send(JSON.stringify({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } }));
      else if (method === 'turn/steer') steerError ? ws.send(JSON.stringify({ id, error: { code: -32600, message: steerError } })) : reply({ turnId: params.expectedTurnId });
      else if (method === 'turn/start') reply({ turn: { id: 'turn-new' } });
      else if (method === 'hooks/list') reply({ data: [{ cwd: '/p', hooks, errors: [], warnings: [] }] });
    });
  });
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  const notify = (method: string, params: unknown) => client.send(JSON.stringify({ method, params }));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, notify, request: (method: string, params: unknown) => client.send(JSON.stringify({ id: 99, method, params })), save: () => { saved = true; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
async function connected(t: TestContext, options?: Parameters<typeof fakeServer>[1], turnHint: () => string | null = () => null) {
  const server = await fakeServer(t, options), log: any[] = [];
  const delivery = new CodexDelivery({ log: e => log.push(e), turnHint });
  t.after(() => delivery.close());
  const connection: boolean[] = []; delivery.on('connection', ready => connection.push(ready));
  await delivery.connect(server.url, token);
  return { server, delivery, log, connection };
}
const request = { id: '3f1e2d4c-5b6a-4978-8a9b-0c1d2e3f4a5b', content: 'User request (transcribed speech):\nAlso add seconds.' };
const session = { root: '/repo', runDir: '/run', cwd: '/p', observation: '', agentArgs: [], clean: String, log: () => {} };

test('the app server requires the capability token; attaching to the thread makes requests deliverable', async t => {
  const server = await fakeServer(t);
  await assert.rejects(new CodexDelivery({ log: () => {}, turnHint: () => null }).connect(server.url, 'wrong'));
  const { delivery, connection } = await connected(t);
  assert.deepEqual(await delivery.deliver(request), { state: 'uncertain', error: new Error('Codex has not started its session yet.') });
  await delivery.attach(thread);
  assert.deepEqual(connection, [true]);
});

test('the terminal\'s thread is taken when Codex announces it, so a request can be its first message; title, subagent and later threads are not', async t => {
  const server = await fakeServer(t, { saved: false });
  const adapter = new CodexAdapter(session);
  t.after(() => adapter.close());
  const named: string[] = [], ready: boolean[] = [], faults: Error[] = [];
  adapter.on('session', id => named.push(id)); adapter.on('connection', value => ready.push(value)); adapter.on('fault', error => faults.push(error));
  await adapter.delivery.connect(server.url, token);
  server.notify('thread/started', { thread: { id: 'title-thread', ephemeral: true, parentThreadId: null } });
  server.notify('thread/started', { thread: { id: 'subagent-thread', ephemeral: false, parentThreadId: thread } });
  server.notify('thread/started', { thread: { id: thread, ephemeral: false, parentThreadId: null } });
  server.notify('thread/started', { thread: { id: 'thread-2', ephemeral: false, parentThreadId: null } });
  await settle();
  assert.deepEqual(named, [thread]); assert.deepEqual(ready, [true]); assert.equal(adapter.observations.state, 'idle');
  assert.deepEqual(faults, [], 'a thread not saved yet is no fault');
  assert.deepEqual(await adapter.deliver(request), { state: 'sent' });
  assert.deepEqual(server.calls.filter(c => c.method.startsWith('turn/')).map(c => [c.method, c.params.threadId]), [['turn/start', thread]]);
});

test('a resumed thread is taken as the terminal loads it, with its conversation as history', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-codex-resume-')), transcript = path.join(dir, 'rollout.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const message = (type: string, text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: thread, turn_id: 't0', item: { type, id: text, content: [{ type: 'text', text }] } } }) + '\n';
  fs.writeFileSync(transcript, message('UserMessage', 'Build a clock') + message('AgentMessage', 'Clock built.'));
  const server = await fakeServer(t, { threads: { [thread]: { id: thread, ephemeral: false, parentThreadId: null, path: transcript } } });
  const adapter = new CodexAdapter(session); t.after(() => adapter.close());
  const named: string[] = [], texts: string[] = []; adapter.on('session', id => named.push(id)); adapter.observations.on('text', e => texts.push(e.text));
  await adapter.delivery.connect(server.url, token);
  server.notify('thread/status/changed', { threadId: 'unsaved', status: { type: 'idle' } });
  server.notify('thread/status/changed', { threadId: thread, status: { type: 'idle' } }); await settle();
  assert.deepEqual(named, [thread]); assert.equal(adapter.observations.state, 'idle');
  assert.deepEqual(adapter.observations.conversation, [{ role: 'input', text: 'Build a clock' }, { role: 'output', text: 'Clock built.' }]);
  assert.deepEqual(texts, [], 'history is context, not new events');
  fs.appendFileSync(transcript, message('AgentMessage', 'Seconds added.'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(texts, ['Seconds added.']);
});

test('an unsaved thread takes requests at once, and is subscribed to once its first message is saved', async t => {
  const { server, delivery, log, connection } = await connected(t, { saved: false }, () => 'turn-from-hooks');
  await delivery.attach(thread);
  assert.deepEqual(connection, [true]); assert.equal(delivery.subscription, 'waiting');
  // Until then, the hooks tell which turn runs.
  assert.deepEqual(await delivery.deliver(request), { state: 'sent' });
  assert.equal(server.calls.find(c => c.method === 'turn/steer')!.params.expectedTurnId, 'turn-from-hooks');
  server.save(); server.notify('thread/status/changed', { threadId: thread, status: { type: 'active', activeFlags: [] } }); await settle();
  assert.equal(delivery.subscription, 'done');
  assert.deepEqual(log.filter(e => e.type.startsWith('codex.subscribe')).map(e => e.type), ['codex.subscribe_failed', 'codex.subscribed']);
  server.notify('turn/started', { threadId: thread, turn: { id: 'turn-2' } }); await settle();
  assert.equal(delivery.runningTurn(), 'turn-2');
});

test('a request steers the running turn, labeled so Codex and the timeline can tell it from typing', async t => {
  const { server, delivery, log } = await connected(t);
  await delivery.attach(thread);
  server.notify('turn/started', { threadId: thread, turn: { id: 'turn-1' } }); await settle();
  assert.deepEqual(await delivery.deliver(request), { state: 'sent' });
  const steer = server.calls.find(c => c.method === 'turn/steer')!;
  assert.deepEqual(steer.params, { threadId: thread, expectedTurnId: 'turn-1', input: [{ type: 'text', text: turnText(request), text_elements: [] }] });
  assert.equal(server.calls.some(c => c.method === 'turn/start'), false);
  assert.deepEqual(receivedRequest(turnText(request)), { id: request.id, content: request.content });
  assert.deepEqual(codex.wire(request), { input: [{ type: 'text', text: turnText(request), text_elements: [] }] });
  assert.equal(log.find(e => e.type === 'codex.delivery').via, 'turn/steer');
});

test('a refused steer, or no running turn, starts a new turn instead', async t => {
  const refused = await connected(t, { steerError: 'no active turn to steer' });
  await refused.delivery.attach(thread);
  refused.server.notify('turn/started', { threadId: thread, turn: { id: 'turn-1' } }); await settle();
  assert.deepEqual(await refused.delivery.deliver(request), { state: 'sent' });
  assert.deepEqual(refused.server.calls.filter(c => c.method.startsWith('turn/')).map(c => c.method), ['turn/steer', 'turn/start']);
  const idle = await connected(t);
  await idle.delivery.attach(thread);
  idle.server.notify('turn/started', { threadId: thread, turn: { id: 'turn-1' } });
  idle.server.notify('turn/completed', { threadId: thread, turn: { id: 'turn-1' } }); await settle();
  assert.deepEqual(await idle.delivery.deliver(request), { state: 'sent' });
  assert.deepEqual(idle.server.calls.filter(c => c.method.startsWith('turn/')).map(c => c.method), ['turn/start']);
  assert.deepEqual(idle.server.calls.find(c => c.method === 'turn/start')!.params.input[0].text, turnText(request));
});

test('before the app server reports a turn, the hooks\' running turn is steered; approvals are left to the terminal', async t => {
  const { server, delivery, log } = await connected(t, {}, () => 'turn-from-hooks');
  await delivery.attach(thread);
  await delivery.deliver(request);
  assert.equal(server.calls.find(c => c.method === 'turn/steer')!.params.expectedTurnId, 'turn-from-hooks');
  server.request('item/commandExecution/requestApproval', { threadId: thread }); await settle();
  assert.deepEqual(log.filter(e => e.type === 'codex.server_request').map(e => e.method), ['item/commandExecution/requestApproval']);
});

test('Codex starts only if it will run every companion hook; the operator\'s own hooks keep their review', async t => {
  const hook = (source: string, trustStatus: string, enabled = true) => ({ source, trustStatus, enabled, key: `${source}:${Math.random()}`, currentHash: 'sha256:x', sourcePath: '/p/.codex/hooks.json', eventName: 'preToolUse' });
  const ours = (count: number, trustStatus = 'trusted', enabled = true) => Array.from({ length: count }, () => hook('sessionFlags', trustStatus, enabled));
  const check = async (hooks: any[]) => {
    const server = await fakeServer(t, { hooks });
    const adapter = new CodexAdapter(session); t.after(() => adapter.delivery.close());
    await adapter.delivery.connect(server.url, token);
    return adapter.confirmHooks('/p');
  };
  await check([...ours(CODEX_HOOKS.length), hook('project', 'untrusted'), hook('user', 'trusted')]);
  await assert.rejects(check([...ours(CODEX_HOOKS.length - 1), ...ours(1, 'untrusted')]), new RegExp(`run only ${CODEX_HOOKS.length - 1} of the companion's ${CODEX_HOOKS.length} hooks`));
  await assert.rejects(check(ours(CODEX_HOOKS.length, 'trusted', false)), /run only 0 of/);
});

test('the companion trusts exactly its own hooks for the run, as one session flag', () => {
  const listed = [{ key: '/<session-flags>/config.toml:stop:0:0', currentHash: 'sha256:ab', source: 'sessionFlags' }, { key: '/home/.codex/config.toml:stop:0:0', currentHash: 'sha256:cd', source: 'user' }] as ListedHook[];
  assert.deepEqual(trustFlags(listed), ['-c', 'hooks.state={"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:ab"}}']);
  assert.deepEqual(trustFlags(listed.slice(1)), []);
});
