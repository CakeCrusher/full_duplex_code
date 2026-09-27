import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { channelNotification } from '../src/adapters/claude/channel-message.ts';
import { LineReader } from '../src/core/line-reader.ts';

const until = async <T>(check: () => T) => {
  for (let i = 0; i < 300; i++) { const result = check(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for channel');
};
test('real MCP channel exposes no tools and delivers each notification once', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const events: any[] = []; let socket!: WebSocket;
  server.on('connection', ws => { socket = ws; ws.on('message', raw => events.push(JSON.parse(raw.toString()))); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/adapters/claude/channel-server.ts', import.meta.url))], {
    env: { ...process.env, FD_BRIDGE_URL: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/channel`, FD_BRIDGE_TOKEN: 'local-test-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  const messages: any[] = []; const reader = new LineReader(e => messages.push(e));
  child.stdout.on('data', chunk => reader.push(chunk));
  const send = (event: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...event }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const initialized = await until(() => messages.find(e => e.id === 1));
  assert.ok(initialized.result.capabilities.experimental['claude/channel']);
  assert.equal(initialized.result.capabilities.tools, undefined);
  assert.doesNotMatch(initialized.result.instructions, /acknowledge|reply|companion|GPT Live/);
  send({ method: 'notifications/initialized' });
  await until(() => events.some(e => e.type === 'channel.ready'));
  send({ id: 2, method: 'tools/call', params: { name: 'reply', arguments: { message_id: 'one', text: 'fake' } } });
  assert.equal((await until(() => messages.find(e => e.id === 2))).error.code, -32601);
  const content = 'User request (transcribed speech):\nMake “世界” blue.\n\nEarlier voice conversation for reference only:\nintermediary: Use \"blue\".\n';
  for (let i = 0; i < 2; i++) socket.send(JSON.stringify({ type: 'channel.deliver', id: 'one', content }));
  await until(() => events.filter(e => e.type === 'channel.sent').length === 2);
  const notifications = messages.filter(e => e.method === 'notifications/claude/channel');
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], channelNotification({ id: 'one', content }), 'actual MCP stdout matches inspector JSON, including every newline and metadata field');
});
