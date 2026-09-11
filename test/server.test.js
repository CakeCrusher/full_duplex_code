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
test('channel transport confirmation differs from Claude acknowledgment', async t => {
  const h = await fixture(t);
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/channel', { headers: { Authorization: `Bearer ${h.channelToken}` } });
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  const delivery = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data))));
  ws.send(JSON.stringify({ type: 'channel.ready' }));
  h.deliver({ id: 'one', content: 'hello' });
  assert.equal((await delivery).id, 'one');
  assert.equal(h.outbox.get('one').state, 'dispatching');
  ws.send(JSON.stringify({ type: 'channel.sent', id: 'one' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.outbox.get('one').state, 'sent');
  ws.send(JSON.stringify({ type: 'channel.acknowledge', message_id: 'one' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.outbox.get('one').state, 'acknowledged');
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
