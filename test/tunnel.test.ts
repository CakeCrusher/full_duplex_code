import test from 'node:test';
import assert from 'node:assert/strict';
import { startTunnel, tunnelAddress, waitUntilReachable, Unverifiable, type ReachabilityChecks } from '../src/launcher/tunnel.ts';

// Stand-in for cloudflared: prints its startup lines on stderr, then waits.
const fake = (lines: string[]) => ['-e', `for (const l of ${JSON.stringify(lines)}) process.stderr.write(l + '\\n'); setInterval(() => {}, 1000);`];
const banner = ['INF Requesting new quick Tunnel on trycloudflare.com...', '|  https://quiet-river-sample.trycloudflare.com  |'];
// These tests stand in for cloudflared, so nothing is reachable: skip that check.
const reachable = async () => {};

test('finds the quick-tunnel address in cloudflared output', () => {
  assert.equal(tunnelAddress('|  https://quiet-river-sample.trycloudflare.com   |'), 'https://quiet-river-sample.trycloudflare.com');
  assert.equal(tunnelAddress('INF Starting metrics server on 127.0.0.1:20241/metrics'), undefined);
});

test('resolves only once the tunnel connection is registered, and stops it on request', async () => {
  const logged: string[] = [];
  const tunnel = await startTunnel({ port: 1, command: process.execPath, args: fake([...banner, 'INF Registered tunnel connection connIndex=0']), log: line => logged.push(line), reachable });
  assert.equal(tunnel.url, 'https://quiet-river-sample.trycloudflare.com');
  assert.ok(logged.some(line => line.includes('Registered')));
  await tunnel.stop();
  assert.equal(tunnel.child.signalCode, 'SIGTERM', 'a well-behaved tunnel stops on SIGTERM');
});

test('an address without a registered connection times out and stops the process', async () => {
  await assert.rejects(startTunnel({ port: 1, command: process.execPath, args: fake(banner), timeoutMs: 300, reachable }), /not ready within 0.3 seconds/);
});

test('a missing cloudflared explains how to install it', async () => {
  await assert.rejects(startTunnel({ port: 1, command: 'cloudflared-not-installed-here' }), /needs cloudflared/);
});

test('cloudflared exiting early is reported', async () => {
  await assert.rejects(startTunnel({ port: 1, command: process.execPath, args: ['-e', 'process.exit(3)'] }), /exited \(3\)/);
});

test('a tunnel that ignores SIGTERM is force-stopped after the grace period', async () => {
  const stubborn = ['-e', `process.on('SIGTERM', () => {}); ${JSON.stringify([...banner, 'INF Registered tunnel connection connIndex=0'])}.forEach(l => process.stderr.write(l + '\\n')); setInterval(() => {}, 1000);`];
  const tunnel = await startTunnel({ port: 1, command: process.execPath, args: stubborn, reachable });
  const started = Date.now();
  await tunnel.stop(300);
  assert.equal(tunnel.child.signalCode, 'SIGKILL');
  assert.ok(Date.now() - started < 3000);
  await tunnel.stop(); // Stopping again is harmless.
});

test('the address is given out only once the page loads through the tunnel', async () => {
  const calls: string[] = []; let lookups = 0, loads = 0;
  const checks: ReachabilityChecks = {
    resolve: async host => { calls.push(`resolve ${host}`); return ++lookups < 3 ? [] : ['104.16.0.1']; },
    status: async (host, address) => { calls.push(`status ${address}`); return ++loads < 2 ? 530 : 200; },
  };
  await waitUntilReachable('https://quiet-river-sample.trycloudflare.com', { checks });
  assert.deepEqual(calls, ['resolve quiet-river-sample.trycloudflare.com', 'resolve quiet-river-sample.trycloudflare.com', 'resolve quiet-river-sample.trycloudflare.com', 'status 104.16.0.1', 'status 104.16.0.1']);
  let registered = false, released!: () => void, announced: string | undefined;
  const started = startTunnel({ port: 1, command: process.execPath, args: fake([...banner, 'INF Registered tunnel connection connIndex=0']),
    onAddress: url => { announced = url; },
    reachable: () => { registered = true; return new Promise<void>(resolve => { released = resolve; }); } });
  while (!registered) await new Promise(resolve => setTimeout(resolve, 10));
  const early = await Promise.race([started.then(() => 'resolved'), new Promise(resolve => setTimeout(resolve, 100, 'waiting'))]);
  assert.equal(early, 'waiting', 'registered, but not yet reachable');
  assert.equal(announced, 'https://quiet-river-sample.trycloudflare.com', 'the bridge learns the address before it is checked');
  released();
  await (await started).stop();
});

test('where the nameservers cannot be asked, the launcher waits instead; a check past the deadline is abandoned', async () => {
  const logged: string[] = [];
  const unverifiable: ReachabilityChecks = { resolve: async () => { throw new Unverifiable('Cloudflare\'s nameservers did not answer (ETIMEOUT).'); }, status: async () => 200 };
  const started = Date.now();
  await waitUntilReachable('https://quiet-river-sample.trycloudflare.com', { checks: unverifiable, fallbackMs: 200, log: line => logged.push(line) });
  assert.ok(Date.now() - started >= 190);
  assert.match(logged[0], /did not answer \(ETIMEOUT\)\. Waiting 0\.2 seconds for the address instead\./);
  let signal!: AbortSignal;
  await assert.rejects(startTunnel({ port: 1, command: process.execPath, args: fake([...banner, 'INF Registered tunnel connection connIndex=0']), timeoutMs: 300,
    reachable: (_url, options) => { signal = options.signal; return new Promise(() => {}); } }), /not ready within 0.3 seconds/);
  assert.equal(signal.aborted, true, 'the check stops with the tunnel');
});
