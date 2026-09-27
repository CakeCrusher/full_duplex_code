import dns from 'node:dns/promises';
import https from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';

// A temporary Cloudflare quick tunnel to the local bridge, started and stopped by
// the launcher for --public. Cloudflare picks a new random address each run.
export const tunnelAddress = (text: string) => text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];

export interface Tunnel { url: string; child: ChildProcess; stop(graceMs?: number): Promise<void> }

/** How the launcher checks that the tunnel's address works; replaced in tests. */
export interface ReachabilityChecks {
  /** The name's IPv4 addresses, or none while it does not exist yet. Throws when it cannot be checked at all. */
  resolve(host: string): Promise<string[]>;
  /** The HTTP status of the page through the tunnel, reached at this address. */
  status(host: string, address: string): Promise<number>;
}
export class Unverifiable extends Error {}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Asks Cloudflare's own nameservers for the tunnel's name, and loads the page
// through the tunnel at the address they give. Neither step uses this
// computer's resolver, so no cache here or elsewhere records a failure.
export function cloudflareChecks(zone = 'trycloudflare.com'): ReachabilityChecks {
  let resolver: Promise<dns.Resolver> | undefined, unreachable = 0;
  const authoritative = async () => {
    const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
    try { resolver.setServers((await Promise.all((await dns.resolveNs(zone)).map(ns => dns.resolve4(ns)))).flat()); }
    catch (error) { throw new Unverifiable(`Cloudflare's nameservers could not be found (${(error as Error).message}).`); }
    return resolver;
  };
  return {
    async resolve(host) {
      try { const addresses = await (await (resolver ??= authoritative())).resolve4(host); unreachable = 0; return addresses; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (error instanceof Unverifiable) throw error;
        // Some networks allow DNS only through their own resolver.
        if (['ETIMEOUT', 'ECONNREFUSED'].includes(code!) && ++unreachable >= 3) throw new Unverifiable(`Cloudflare's nameservers did not answer (${code}).`);
        return [];
      }
    },
    status: (host, address) => new Promise((resolve, reject) => {
      const request = https.request({ host: address, servername: host, headers: { Host: host }, path: '/', method: 'GET', timeout: 4000 }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on('timeout', () => request.destroy(new Error('timed out')));
      request.on('error', reject);
      request.end();
    }),
  };
}

// Cloudflare names a quick tunnel seconds before the name resolves. A device
// that looks it up in that window is told it does not exist and may keep that
// answer for a minute, so the address is given out only once the page loads
// through it. Where the nameservers cannot be asked directly, it waits instead.
export async function waitUntilReachable(url: string, { checks = cloudflareChecks(), signal, log = () => {}, fallbackMs = 10000 }: {
  checks?: ReachabilityChecks; signal?: AbortSignal; log?: (line: string) => void; fallbackMs?: number;
} = {}) {
  const host = new URL(url).host;
  let address: string | undefined;
  while (!signal?.aborted) {
    try {
      address ??= (await checks.resolve(host))[0];
      if (address && await checks.status(host, address) === 200) return;
    } catch (error) {
      if (error instanceof Unverifiable) { log(`${error.message} Waiting ${fallbackMs / 1000} seconds for the address instead.`); await sleep(fallbackMs); return; }
      // Not routed yet: the edge refuses or fails the request. Try again.
    }
    await sleep(250);
  }
}

export function startTunnel({ port, command = 'cloudflared', args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], timeoutMs = 30000, log = () => {}, onAddress = () => {}, reachable = waitUntilReachable }: {
  port: number | string; command?: string; args?: string[]; timeoutMs?: number; log?: (line: string) => void;
  /** The address, once registered and before it is checked: the bridge must accept it by then. */
  onAddress?: (url: string) => void;
  reachable?: (url: string, options: { signal: AbortSignal; log: (line: string) => void }) => Promise<void>;
}): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    // cloudflared reports everything, including the address, on stderr. Its own
    // process group keeps Ctrl-C in the agent's terminal from stopping the tunnel.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let url: string | undefined, output = '', settled = false, checking = false;
    const checks = new AbortController();
    const running = () => child.exitCode === null && child.signalCode === null;
    const exited = new Promise(resolve => child.once('exit', resolve));
    // Ask cloudflared to shut down, and force it if it has not exited in time.
    const stop = async (graceMs = 5000) => {
      if (!running()) return;
      child.kill('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), graceMs); });
      if (await Promise.race([exited, late]) === 'late' && running()) { child.kill('SIGKILL'); await exited; }
      clearTimeout(timer);
    };
    const done = (error: Error | null, value?: Tunnel) => {
      if (settled) return; settled = true; clearTimeout(timer); checks.abort();
      if (error) { stop(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error(`The Cloudflare tunnel was not ready within ${timeoutMs / 1000} seconds.`)), timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => done(error.code === 'ENOENT' ? new Error('--public needs cloudflared. Install it, for example with: brew install cloudflared') : error));
    child.on('exit', code => done(new Error(`cloudflared exited (${code}) before the tunnel was ready.`)));
    child.stderr!.setEncoding('utf8');
    // Keep reading after startup so cloudflared never blocks on a full pipe.
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) log(line.trim());
      if (settled || checking) return;
      output = (output + chunk).slice(-16384);
      url ??= tunnelAddress(output);
      // The address is printed before Cloudflare can route to it.
      if (url && /Registered tunnel connection/.test(output)) {
        checking = true;
        const tunnel = { url, child, stop };
        onAddress(url);
        reachable(url, { signal: checks.signal, log }).then(() => done(null, tunnel), error => done(error));
      }
    });
  });
}
