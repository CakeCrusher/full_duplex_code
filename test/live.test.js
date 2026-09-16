import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Budget, RATE_PER_SECOND } from '../src/budget.js';
import { LiveSession } from '../src/live.js';

async function fixture(t, onCommand) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-live-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  server.on('connection', ws => ws.on('message', raw => {
    const event = JSON.parse(raw);
    if (event.type === 'session.start') {
      assert.equal(event.session.model, 'gpt-live-1'); assert.equal(event.session.delegation.type, 'client');
      ws.send(JSON.stringify({ type: 'session.started', session: { id: 'test-live' } }));
    } else onCommand(ws, event);
  }));
  const budget = new Budget(path.join(dir, 'budget.json'));
  const live = new LiveSession({ apiKey: 'fake-test-key', budget, maxSeconds: 15, url: `ws://127.0.0.1:${server.address().port}` });
  t.after(async () => { live.abort('test cleanup'); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { live, budget };
}
test('final usage reconciles reservation and expected shutdown append errors do not surface as new faults', async t => {
  let pending;
  const { live, budget } = await fixture(t, (ws, e) => {
    if (e.type === 'session.thinking.append') pending = e.event_id;
    if (e.type === 'session.close') {
      ws.send(JSON.stringify({ type: 'error', error: { message: 'Session closed before context injection', client_event_id: pending } }));
      ws.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 7 }, reason: 'close_requested', session: { id: 'test-live' } }));
    }
  });
  const faults = []; live.on('fault', e => faults.push(e.message));
  await live.start();
  const append = live.append('thinking', 'facts').catch(error => error.message);
  const result = await live.close();
  assert.match(await append, /closed/); assert.equal(result.finalized, true);
  assert.equal(budget.summary().committedUsd, 7 * RATE_PER_SECOND); assert.deepEqual(faults, []);
});
test('a transport loss preserves the full reservation without inventing final usage', async t => {
  const { live, budget } = await fixture(t, () => {});
  await live.start(); const reserved = budget.summary().committedUsd; live.ws.terminate();
  const result = await live.closed;
  assert.equal(result.finalized, false); assert.equal(budget.summary().committedUsd, reserved);
});
test('accelerated audio cannot outrun the reserved duration', async t => {
  const { live } = await fixture(t, (ws, event) => {
    if (event.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 0 }, reason: 'close_requested', session: { id: 'test-live' } }));
  });
  await live.start(); assert.throws(() => live.audio(Buffer.alloc(24000 * 2 * 4)), /real-time speed/);
  assert.equal((await live.closed).finalized, true);
});

test('a budget rejection closes without opening a connection or leaving shutdown pending', async t => {
  const { live, budget } = await fixture(t, () => {});
  budget.reserve(29990, 'existing usage');
  let closed = 0; live.on('closed', () => closed++);
  await assert.rejects(live.start(), /requires \$0\.04, but \$0\.01 remains.*--max-minutes/);
  assert.equal(live.state, 'closed');
  assert.equal(live.ws, undefined);
  const result = await live.close();
  assert.equal(result.reserved, false);
  assert.equal(closed, 1);
  assert.equal(budget.summary().runs.length, 1, 'failed startup adds no reservation');
});

test('missing credentials and closing an unstarted session both settle shutdown', async t => {
  const { live, budget } = await fixture(t, () => {});
  live.apiKey = '';
  await assert.rejects(live.start(), /OPENAI_API_KEY is missing/);
  assert.equal((await live.close()).reserved, false);
  const unstarted = new LiveSession({ apiKey: 'unused', budget });
  assert.equal((await unstarted.close()).reserved, false);
  assert.equal(unstarted.state, 'closed');
  assert.equal(budget.summary().runs.length, 0);
});
