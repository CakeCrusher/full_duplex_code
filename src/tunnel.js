import { spawn } from 'node:child_process';

// A temporary Cloudflare quick tunnel to the local bridge, started and stopped by
// the launcher for --public. Cloudflare picks a new random address each run.
export const tunnelAddress = text => text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];

export function startTunnel({ port, command = 'cloudflared', args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], timeoutMs = 30000, log = () => {} }) {
  return new Promise((resolve, reject) => {
    // cloudflared reports everything, including the address, on stderr. Its own
    // process group keeps Ctrl-C in Claude's terminal from stopping the tunnel.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let url, output = '', settled = false;
    const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
    const done = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { stop(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => done(new Error(`The Cloudflare tunnel was not ready within ${timeoutMs / 1000} seconds.`)), timeoutMs);
    child.on('error', error => done(error.code === 'ENOENT' ? new Error('--public needs cloudflared. Install it, for example with: brew install cloudflared') : error));
    child.on('exit', code => done(new Error(`cloudflared exited (${code}) before the tunnel was ready.`)));
    child.stderr.setEncoding('utf8');
    // Keep reading after startup so cloudflared never blocks on a full pipe.
    child.stderr.on('data', chunk => {
      for (const line of chunk.split('\n')) if (line.trim()) log(line.trim());
      if (settled) return;
      output = (output + chunk).slice(-16384);
      url ??= tunnelAddress(output);
      // The address is printed before Cloudflare can route to it.
      if (url && /Registered tunnel connection/.test(output)) done(null, { url, child, stop });
    });
  });
}
