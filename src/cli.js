#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Harness } from './server.js';
import { Budget } from './budget.js';
import { claudeArgs } from './agent.js';
import { parseLaunchArgs } from './cli-options.js';
import qrcode from 'qrcode-terminal';
import { startTunnel } from './tunnel.js';
import { confirmStart } from './launch-prompt.js';

const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const { values, extraArgs, command } = parseLaunchArgs(process.argv.slice(2));
if (values.help) {
  console.log(`Usage: npm start -- [companion options] [Claude Code arguments]
  --cwd /project        Folder where Claude works (default: current directory)
  --resume SESSION_ID   Resume a Claude conversation by its full UUID
  --session-id UUID     Choose the UUID for a new Claude conversation
  --voice marin         GPT Live voice
  --observe hooks       Live display hooks (default), or transcript file tail
  --port 8123           Local port (default 8123; 0 chooses a free port)
  --public              Also reach the companion from a phone, through a temporary
                        Cloudflare tunnel this launcher starts and stops (needs cloudflared)
  npm run doctor        Check local prerequisites without API spending
  npm run usage         Show recorded voice usage and cost estimates

Other arguments are forwarded unchanged after the generated Claude options.
Claude applies its normal override/merge rules. Examples:
  npm start -- --dangerously-skip-permissions
  npm start -- --cwd /project --resume UUID --model opus --permission-mode plan
Use an extra -- to pass a launcher option name to Claude instead:
  npm start -- -- --help

Claude opens in your terminal. Open the companion URL and click Start voice once
to enable the microphone and speaker. Claude's permission mode controls tool
approvals. End voice stops API billing while leaving Claude available.`);
  process.exit(0);
}
if (command === 'usage') { console.log(JSON.stringify(new Budget(path.join(root, '.runs/budget.json')).summary(), null, 2)); process.exit(0); }
if (command === 'doctor') {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  let loggedIn = false; try { loggedIn = JSON.parse(auth.stdout).loggedIn; } catch {}
  const report = { node: process.version, claude: version.stdout?.trim() || 'not found', claudeLoggedIn: loggedIn, openAIKeyPresent: Boolean(process.env.OPENAI_API_KEY), microphone: 'Browser grants access when you click Start voice', budget: new Budget(path.join(root, '.runs/budget.json')).summary() };
  console.log(JSON.stringify(report, null, 2)); process.exit(version.status === 0 && loggedIn && process.env.OPENAI_API_KEY ? 0 : 1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Launch npm start in a terminal. The final interface is the normal interactive Claude Code chat.');
if (!process.env.OPENAI_API_KEY) throw new Error('Add OPENAI_API_KEY to .env or your environment.');
if (!['hooks', 'transcript'].includes(values.observe)) throw new Error('--observe must be hooks or transcript');
// A stable address lets Chrome remember microphone access between launches.
const DEFAULT_PORT = 8123;
const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const cwd = fs.realpathSync(values.cwd);
const sessionId = values.resume ?? values['session-id'] ?? randomUUID();
if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId)) throw new Error('--resume and --session-id require a Claude session UUID');
const runDir = path.join(root, '.runs', `${new Date().toISOString().replaceAll(':', '-')}-${sessionId.slice(0, 8)}`);
const harness = await new Harness({ root, runDir, cwd, sessionId, apiKey: process.env.OPENAI_API_KEY, port, portFallback: values.port === undefined, voice: values.voice, observation: values.observe }).start();
if (harness.portFellBack) console.log(`\nPort ${DEFAULT_PORT} is in use, probably by another companion. This one uses ${new URL(harness.baseUrl).port}; Chrome may ask for microphone access again.`);
let tunnel, child, stopping = false;
// One ordered teardown for every way the launcher can end: Claude exiting or
// failing to start, quitting at the prompt, the terminal closing, or a crash.
// The bridge closes first (ending the voice session and its sockets), then the
// tunnel, which runs in its own process group and would otherwise outlive us.
async function stop(reason) {
  if (stopping) return; stopping = true;
  harness.log({ type: 'launcher.stopping', reason });
  await harness.close().catch(error => console.error(`Stopping the companion: ${error.message}`));
  await tunnel?.stop().catch(error => console.error(`Stopping the tunnel: ${error.message}`));
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
async function exit(reason, code) { await stop(reason); process.exit(code); }
// Last resort if the process ends without stop() finishing: never leave the tunnel running.
process.on('exit', () => { if (tunnel?.child.exitCode === null) tunnel.child.kill('SIGKILL'); });
process.on('SIGTERM', () => exit('SIGTERM', 143));
process.on('SIGHUP', () => exit('terminal closed', 129));
process.on('uncaughtException', error => { console.error(error); exit('crash', 1); });
process.on('unhandledRejection', error => { console.error(error); exit('crash', 1); });
if (values.public) {
  // Claude takes over the terminal next, so wait here until the address works.
  console.log('\nStarting a Cloudflare tunnel for --public…');
  try { tunnel = await startTunnel({ port: new URL(harness.baseUrl).port, log: line => harness.log({ type: 'tunnel.log', line }) }); }
  catch (error) { console.error(error.message); await exit('tunnel failed', 1); }
  harness.setPublicUrl(tunnel.url);
  harness.log({ type: 'tunnel.started', url: tunnel.url });
  tunnel.child.on('exit', code => { if (!stopping) harness.fault(new Error(`The Cloudflare tunnel stopped (${code}); the phone link no longer works.`)); });
  console.log(`\nFrom your phone: ${harness.publicBrowserUrl}\nScan with your phone's camera:`);
  qrcode.generate(harness.publicBrowserUrl, { small: true }, code => console.log(code));
  console.log("Anyone with this link can direct Claude on this computer. Don't share it. The tunnel closes when you exit Claude.");
}
// The launcher only prints the link; open it in Chrome or another Chromium browser.
console.log(`\nFull-Duplex Code: ${harness.browserUrl}\nOpen this link in Chrome, then click Start voice when the channel is ready.\nLocal run: ${runDir}\n`);
if (!(await confirmStart())) await exit('quit before Claude started', 0);
const childEnv = { ...process.env, FD_BRIDGE_TOKEN: harness.channelToken };
delete childEnv.OPENAI_API_KEY;
child = spawn('claude', claudeArgs({ config: harness.config, sessionId, resume: Boolean(values.resume), extraArgs }), { cwd, env: childEnv, stdio: 'inherit' });
// Ctrl-C belongs to Claude's terminal interaction. Exiting Claude ends the harness.
process.on('SIGINT', () => {});
child.on('error', async error => { console.error(error.message); await exit('Claude failed to start', 1); });
child.on('exit', async (code, signal) => {
  await stop(signal ? `Claude ended (${signal})` : `Claude exited (${code})`);
  console.log(`\nFull-Duplex Code stopped${tunnel ? ' and closed the Cloudflare tunnel' : ''}. Usage saved in .runs/budget.json.`);
  process.exit(code ?? 1);
});
