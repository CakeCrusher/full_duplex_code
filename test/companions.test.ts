import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Harness } from '../src/core/bridge.ts';
import { CompanionRegistry, type CompanionEntry } from '../src/core/companions.ts';
import { claude } from '../src/adapters/claude/index.ts';

const temporary = (t: TestContext) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-companions-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const entry = (fields: Partial<CompanionEntry> = {}): CompanionEntry => ({ pid: process.pid, port: 4321, token: randomBytes(32).toString('hex'), cwd: '/work/app', agent: 'Codex', startedAt: Date.now(), ...fields });
// A process that has ended, like a companion that crashed without removing its entry.
const endedPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
// Companions running side by side share one root, and so one registry.
function companions(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-companions-')), running: Harness[] = [];
  t.after(async () => { for (const harness of running) await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return async (folder: string) => {
    const cwd = path.join(root, folder); fs.mkdirSync(cwd, { recursive: true });
    const harness = await new Harness({ agent: claude, root, runDir: path.join(root, `run-${folder}`), cwd, sessionId: randomUUID(), apiKey: 'unused-test-key' }).start();
    running.push(harness); return harness;
  };
}
// GET /api/companions as a page asks for it: from this computer, or through the tunnel with its Host and forwarding headers.
function request(h: Harness, headers: Record<string, string> = {}, token = h.browserToken) {
  return new Promise<{ status: number; body: string; list: any[] }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: new URL(h.baseUrl).port, path: '/api/companions', headers: { Authorization: `Bearer ${token}`, ...headers } }, response => {
      let body = ''; response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode!, body, list: response.statusCode === 200 ? JSON.parse(body).companions : [] }));
    }).on('error', reject);
  });
}
const tunnel = (publicUrl: string) => ({ Host: new URL(publicUrl).host, 'Cf-Connecting-Ip': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7' });

test('the registry is private to this user and drops companions whose process has ended', t => {
  const dir = path.join(temporary(t), '.runs', 'companions'), registry = new CompanionRegistry(dir);
  const running = entry(), crashed = entry({ pid: endedPid(), port: 4322 });
  registry.register(running); registry.register(crashed);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(registry.file(running)), 0o600);
  fs.writeFileSync(path.join(dir, '1-2.json'), 'not an entry');
  fs.writeFileSync(path.join(dir, '3-4.json'), JSON.stringify({ ...running, pid: 3, port: 4, token: 'short' }));
  assert.deepEqual(registry.list(), [running], 'unreadable entries are skipped, not fatal');
  assert.equal(fs.existsSync(registry.file(crashed)), false, 'the crashed companion is pruned');
  // A directory others could read is made private again before anything is written to it.
  fs.chmodSync(dir, 0o755);
  registry.register({ ...running, sessionId: 'learned-later' });
  assert.equal(mode(dir), 0o700);
  assert.equal(registry.list()[0].sessionId, 'learned-later');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  registry.remove(running);
  assert.equal(fs.existsSync(registry.file(running)), false);
});

test('each bridge registers while it runs, and a local page gets every companion with its local link', async t => {
  const start = companions(t), alpha = await start('alpha'), beta = await start('beta');
  assert.equal((await request(alpha, {}, beta.browserToken)).status, 403, "another companion's token is refused");
  beta.agentReady = true;
  const { status, list } = await request(alpha);
  assert.equal(status, 200);
  assert.deepEqual(list.map(c => [c.folder, c.agent, c.sessionId, c.current, c.reachable, c.agentReady, c.agentState, c.voice, c.public, c.link]), [
    ['alpha', 'Claude Code', alpha.sessionId!.slice(0, 8), true, true, false, 'starting', 'none', false, alpha.browserUrl],
    ['beta', 'Claude Code', beta.sessionId!.slice(0, 8), false, true, true, 'starting', 'none', false, beta.browserUrl],
  ]);
  // Voice running in the other companion, as its own status reports it.
  beta.live = Object.assign(new EventEmitter(), { state: 'active', id: 'voice-beta', usageSeconds: 0, instructions: '', close: async () => {} }) as any;
  assert.equal((await request(alpha)).list[1].voice, 'active');
  await beta.close();
  assert.deepEqual((await request(alpha)).list.map(c => c.folder), ['alpha'], 'a stopped companion removes its entry');
});

test('through the tunnel, a page gets only the public links of public companions', async t => {
  const start = companions(t), alpha = await start('alpha'), beta = await start('beta');
  alpha.setPublicUrl('https://alpha-sample.trycloudflare.com');
  const remote = await request(alpha, tunnel(alpha.publicOrigin!));
  assert.equal(remote.status, 200);
  assert.deepEqual(remote.list.map(c => [c.folder, c.public, c.link]), [['alpha', true, alpha.publicBrowserUrl], ['beta', false, null]]);
  assert.ok(!remote.body.includes(beta.browserToken), "a local-only companion's token never leaves through the tunnel");
  assert.ok(!remote.body.includes('127.0.0.1'));
  beta.setPublicUrl('https://beta-sample.trycloudflare.com');
  assert.deepEqual((await request(alpha, tunnel(alpha.publicOrigin!))).list.map(c => c.link), [alpha.publicBrowserUrl, beta.publicBrowserUrl]);
  // Locally, the same companions are reached by their local links.
  assert.deepEqual((await request(alpha)).list.map(c => c.link), [alpha.browserUrl, beta.browserUrl]);
  // A forwarded request is never local, whatever Host it names.
  assert.equal((await request(alpha, { 'X-Forwarded-For': '203.0.113.7' })).status, 403);
});

test('a companion that does not answer is listed as unreachable, and an ended one not at all', async t => {
  const alpha = await companions(t)('alpha');
  const closed = await new Promise<number>(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
  const quiet = entry({ port: closed, cwd: '/work/quiet', startedAt: alpha.startedAt + 1 }), gone = entry({ pid: endedPid(), port: closed + 1, cwd: '/work/gone' });
  alpha.companions.register(quiet); alpha.companions.register(gone);
  const { list } = await request(alpha);
  assert.deepEqual(list.map(c => [c.folder, c.agent, c.reachable, c.agentReady, c.voice, c.link]), [
    ['alpha', 'Claude Code', true, false, 'none', alpha.browserUrl],
    ['quiet', 'Codex', false, false, 'none', `http://127.0.0.1:${closed}/#${quiet.token}`],
  ]);
  assert.equal(fs.existsSync(alpha.companions.file(gone)), false);
});
