import test from 'node:test';
import assert from 'node:assert/strict';
import { startTunnel, tunnelAddress } from '../src/tunnel.js';

// Stand-in for cloudflared: prints its startup lines on stderr, then waits.
const fake = lines => ['-e', `for (const l of ${JSON.stringify(lines)}) process.stderr.write(l + '\\n'); setInterval(() => {}, 1000);`];
const banner = ['INF Requesting new quick Tunnel on trycloudflare.com...', '|  https://quiet-river-sample.trycloudflare.com  |'];

test('finds the quick-tunnel address in cloudflared output', () => {
  assert.equal(tunnelAddress('|  https://quiet-river-sample.trycloudflare.com   |'), 'https://quiet-river-sample.trycloudflare.com');
  assert.equal(tunnelAddress('INF Starting metrics server on 127.0.0.1:20241/metrics'), undefined);
});

test('resolves only once the tunnel connection is registered, and stops it on request', async () => {
  const logged = [];
  const tunnel = await startTunnel({ port: 1, command: process.execPath, args: fake([...banner, 'INF Registered tunnel connection connIndex=0']), log: line => logged.push(line) });
  assert.equal(tunnel.url, 'https://quiet-river-sample.trycloudflare.com');
  assert.ok(logged.some(line => line.includes('Registered')));
  const exited = new Promise(resolve => tunnel.child.on('exit', resolve));
  tunnel.stop(); await exited;
});

test('an address without a registered connection times out and stops the process', async () => {
  await assert.rejects(startTunnel({ port: 1, command: process.execPath, args: fake(banner), timeoutMs: 300 }), /not ready within 0.3 seconds/);
});

test('a missing cloudflared explains how to install it', async () => {
  await assert.rejects(startTunnel({ port: 1, command: 'cloudflared-not-installed-here' }), /needs cloudflared/);
});

test('cloudflared exiting early is reported', async () => {
  await assert.rejects(startTunnel({ port: 1, command: process.execPath, args: ['-e', 'process.exit(3)'] }), /exited \(3\)/);
});
