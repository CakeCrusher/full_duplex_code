import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

// The companion's own Codex app server. The terminal attaches to it with
// --remote, and the companion is a second client: it steers turns and runs
// the hooks. Local only, behind a capability token.

// Every hook Codex offers.
export const CODEX_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SessionEnd'];
const MATCHED = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

// Hooks as -c session flags: nothing is written to the project or ~/.codex.
export function hookFlags(command: string): string[] {
  return CODEX_HOOKS.flatMap(event => ['-c', `hooks.${event}=[{${MATCHED.has(event) ? 'matcher="*",' : ''}hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`]);
}

export interface AppServer { url: string; token: string; child: ChildProcess; stop(): Promise<void> }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port));
    });
  });
}

export async function startAppServer({ cwd, env, hooks, log, timeoutMs = 20000 }: { cwd: string; env: NodeJS.ProcessEnv; hooks: string; log: (event: Record<string, unknown>) => void; timeoutMs?: number }): Promise<AppServer> {
  const port = await freePort(), token = randomBytes(32).toString('hex');
  const url = `ws://127.0.0.1:${port}`;
  const child = spawn('codex', ['app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex'), ...hookFlags(hooks)],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout!, child.stderr!]) stream.setEncoding('utf8').on('data', (chunk: string) => { for (const line of chunk.split('\n')) if (line.trim()) log({ type: 'codex.app_server', line: line.trim() }); });
  // Never leave it running if the launcher ends without stop() finishing.
  const orphan = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  process.on('exit', orphan);
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    process.off('exit', orphan);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), 3000); });
    if (await Promise.race([exited, late]) === 'late') { child.kill('SIGKILL'); await exited; }
    clearTimeout(timer);
  };
  const spawnError = new Promise<Error>(resolve => child.once('error', resolve));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failed = await Promise.race([spawnError, exited.then(code => new Error(`codex app-server exited (${code}) before it was ready.`)), new Promise(resolve => setTimeout(resolve, 100, null))]);
    if (failed instanceof Error) {
      await stop();
      throw (failed as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Codex is not installed or not on PATH.') : failed;
    }
    try { if ((await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) { await stop(); throw new Error(`The Codex app server was not ready within ${timeoutMs / 1000} seconds.`); }
  }
  log({ type: 'codex.app_server_started', url, pid: child.pid });
  return { url, token, child, stop };
}
