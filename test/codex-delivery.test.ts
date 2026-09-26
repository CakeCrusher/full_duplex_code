import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexDelivery, receivedRequest, turnText } from '../src/adapters/codex/delivery.ts';
import { CodexAdapter, codex } from '../src/adapters/codex/index.ts';

const thread = 'thread-1', token = 'capability-token';
// A stand-in for Codex's app server: the JSON-RPC calls the adapter makes.
async function fakeServer(t: TestContext, { steerError, hooks = [] }: { steerError?: string; hooks?: any[] } = {}) {
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
      else if (method === 'thread/resume') reply({ thread: { id: params.threadId } });
      else if (method === 'turn/steer') steerError ? ws.send(JSON.stringify({ id, error: { code: -32600, message: steerError } })) : reply({ turnId: params.expectedTurnId });
      else if (method === 'turn/start') reply({ turn: { id: 'turn-new' } });
      else if (method === 'hooks/list') reply({ data: [{ cwd: '/p', hooks, errors: [], warnings: [] }] });
    });
  });
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  const notify = (method: string, params: unknown) => client.send(JSON.stringify({ method, params }));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, notify, request: (method: string, params: unknown) => client.send(JSON.stringify({ id: 99, method, params })) };
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

test('the app server requires the capability token; attaching to the thread makes requests deliverable', async t => {
  const server = await fakeServer(t);
  await assert.rejects(new CodexDelivery({ log: () => {}, turnHint: () => null }).connect(server.url, 'wrong'));
  const { delivery, connection } = await connected(t);
  assert.deepEqual(await delivery.deliver(request), { state: 'uncertain', error: new Error('Codex has not started its session yet.') });
  await delivery.attach(thread);
  assert.deepEqual(connection, [true]);
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

test('Codex refuses to start when any hook but the companion\'s awaits review', async t => {
  const session = { root: '/repo', runDir: '/run', cwd: '/p', observation: '', agentArgs: [], clean: String, log: () => {} };
  const hook = (source: string, trustStatus: string, sourcePath = '/p/.codex/hooks.json') => ({ source, trustStatus, sourcePath, eventName: 'preToolUse', enabled: true });
  const check = async (hooks: any[]) => {
    const server = await fakeServer(t, { hooks });
    const adapter = new CodexAdapter(session); t.after(() => adapter.delivery.close());
    await adapter.delivery.connect(server.url, token);
    return adapter.refuseUnreviewedHooks('/p');
  };
  await check([hook('sessionFlags', 'untrusted'), hook('user', 'trusted'), hook('mdm', 'managed')]);
  await assert.rejects(check([hook('sessionFlags', 'untrusted'), hook('project', 'untrusted')]), /\/p\/\.codex\/hooks\.json \(preToolUse\).*Review them with \/hooks/);
  await assert.rejects(check([hook('user', 'modified', '/home/.codex/hooks.json')]), /home\/\.codex\/hooks\.json/);
});
