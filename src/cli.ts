#!/usr/bin/env node
// The launcher: starts the bridge (and the tunnel for --public), prints the
// links, then runs the agent's own command in this terminal until it exits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Harness } from './core/bridge.ts';
import { UsageLedger } from './core/usage-ledger.ts';
import { agents, defaultAgent } from './adapters/index.ts';
import { parseLaunchArgs } from './launcher/options.ts';
import { startTunnel, type Tunnel } from './launcher/tunnel.ts';
import { confirmStart } from './launcher/launch-prompt.ts';

const agent = agents[defaultAgent];
const { name, product, transport } = agent.profile;
const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const { values, extraArgs, command } = parseLaunchArgs(process.argv.slice(2));
if (values.help) {
  console.log(`Usage: npm start -- [companion options] [${product} arguments]
  --cwd /project        Folder where ${name} works (default: current directory)
  --resume SESSION_ID   Resume a ${name} conversation by its full UUID
  --session-id UUID     Choose the UUID for a new ${name} conversation
  --voice marin         GPT Live voice
  --observe hooks       Live display hooks (default), or transcript file tail
  --port 8123           Local port (default 8123; 0 chooses a free port)
  --public              Also reach the companion from a phone, through a temporary
                        Cloudflare tunnel this launcher starts and stops (needs cloudflared)
  npm run doctor        Check local prerequisites without API spending
  npm run usage         Show recorded voice usage and cost estimates

Other arguments are forwarded unchanged after the generated ${name} options.
${name} applies its normal override/merge rules. Examples:
${agent.usage.examples.map(example => `  npm start -- ${example}`).join('\n')}
Use an extra -- to pass a launcher option name to ${name} instead:
  npm start -- -- --help

${agent.usage.afterStart}`);
  process.exit(0);
}
if (command === 'usage') { console.log(JSON.stringify(new UsageLedger(path.join(root, '.runs/budget.json')).summary(), null, 2)); process.exit(0); }
if (command === 'doctor') {
  const checked = agent.doctor();
  const report = { node: process.version, ...checked.report, openAIKeyPresent: Boolean(process.env.OPENAI_API_KEY), microphone: 'Browser grants access when you click Start voice', budget: new UsageLedger(path.join(root, '.runs/budget.json')).summary() };
  console.log(JSON.stringify(report, null, 2)); process.exit(checked.ok && process.env.OPENAI_API_KEY ? 0 : 1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Launch npm start in a terminal. The final interface is the normal interactive ${product} chat.`);
if (!process.env.OPENAI_API_KEY) throw new Error('Add OPENAI_API_KEY to .env or your environment.');
if (!['hooks', 'transcript'].includes(values.observe)) throw new Error('--observe must be hooks or transcript');
// A stable address lets Chrome remember microphone access between launches.
const DEFAULT_PORT = 8123;
const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const cwd = fs.realpathSync(values.cwd);
const sessionId = values.resume ?? values['session-id'] ?? randomUUID();
if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId)) throw new Error(`--resume and --session-id require a ${name} session UUID`);
const runDir = path.join(root, '.runs', `${new Date().toISOString().replaceAll(':', '-')}-${sessionId.slice(0, 8)}`);
const harness = await new Harness({ agent, root, runDir, cwd, sessionId, apiKey: process.env.OPENAI_API_KEY, port, portFallback: values.port === undefined, voice: values.voice, observation: values.observe, agentArgs: extraArgs, resume: Boolean(values.resume) }).start();
if (harness.portFellBack) console.log(`\nPort ${DEFAULT_PORT} is in use, probably by another companion. This one uses ${new URL(harness.baseUrl).port}; Chrome may ask for microphone access again.`);
let tunnel: Tunnel | undefined, child: ChildProcess | undefined, stopping = false;
// One ordered teardown for every way the launcher can end: the agent exiting or
// failing to start, quitting at the prompt, the terminal closing, or a crash.
// The bridge closes first (ending the voice session and its sockets), then the
// tunnel, which runs in its own process group and would otherwise outlive us.
async function stop(reason: string) {
  if (stopping) return; stopping = true;
  harness.log({ type: 'launcher.stopping', reason });
  await harness.close().catch(error => console.error(`Stopping the companion: ${error.message}`));
  await tunnel?.stop().catch(error => console.error(`Stopping the tunnel: ${error.message}`));
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
async function exit(reason: string, code: number) { await stop(reason); process.exit(code); }
// Last resort if the process ends without stop() finishing: never leave the tunnel running.
process.on('exit', () => { if (tunnel?.child.exitCode === null) tunnel.child.kill('SIGKILL'); });
process.on('SIGTERM', () => exit('SIGTERM', 143));
process.on('SIGHUP', () => exit('terminal closed', 129));
process.on('uncaughtException', error => { console.error(error); exit('crash', 1); });
process.on('unhandledRejection', error => { console.error(error); exit('crash', 1); });
if (values.public) {
  // The agent takes over the terminal next, so wait here until the address works.
  console.log('\nStarting a Cloudflare tunnel for --public…');
  try { tunnel = await startTunnel({ port: new URL(harness.baseUrl).port, log: line => harness.log({ type: 'tunnel.log', line }) }); }
  catch (error) { console.error((error as Error).message); await exit('tunnel failed', 1); }
  const { url, child: tunnelProcess } = tunnel!;
  harness.setPublicUrl(url);
  harness.log({ type: 'tunnel.started', url });
  tunnelProcess.on('exit', code => { if (!stopping) harness.fault(new Error(`The Cloudflare tunnel stopped (${code}); the phone link no longer works.`)); });
  console.log(`\nFrom your phone: ${harness.publicBrowserUrl}\nScan with your phone's camera:`);
  qrcode.generate(harness.publicBrowserUrl!, { small: true }, code => console.log(code));
  console.log(`Anyone with this link can direct ${name} on this computer. Don't share it. The tunnel closes when you exit ${name}.`);
}
// The launcher only prints the link; open it in Chrome or another Chromium browser.
console.log(`\nFull-Duplex Code: ${harness.browserUrl}\nOpen this link in Chrome, then click Start voice when the ${transport} is ready.\nLocal run: ${runDir}\n`);
if (!(await confirmStart({ profile: agent.profile }))) await exit(`quit before ${name} started`, 0);
const launch = harness.agentLaunch!;
const childEnv: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
delete childEnv.OPENAI_API_KEY;
child = spawn(launch.command, launch.args, { cwd, env: childEnv, stdio: 'inherit' });
// Ctrl-C belongs to the agent's terminal interaction. Exiting the agent ends the harness.
process.on('SIGINT', () => {});
child.on('error', async error => { console.error(error.message); await exit(`${name} failed to start`, 1); });
child.on('exit', async (code, signal) => {
  await stop(signal ? `${name} ended (${signal})` : `${name} exited (${code})`);
  console.log(`\nFull-Duplex Code stopped${tunnel ? ' and closed the Cloudflare tunnel' : ''}. Usage saved in .runs/budget.json.`);
  process.exit(code ?? 1);
});
