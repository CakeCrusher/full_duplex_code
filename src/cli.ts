#!/usr/bin/env node
// fdc [options] <agent> [the agent's own arguments]: starts the bridge (and the
// tunnel for --public), prints the links, then runs the agent's own command in
// this terminal until it exits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Harness } from './core/bridge.ts';
import { UsageLedger } from './core/usage-ledger.ts';
import type { AgentArguments, AgentDefinition } from './core/adapter.ts';
import { agents } from './adapters/index.ts';
import { parseLaunchArgs, UsageError, type LaunchCommand } from './launcher/options.ts';
import { startTunnel, type Tunnel } from './launcher/tunnel.ts';
import { confirmStart } from './launcher/launch-prompt.ts';
import { ErrorTail, failureNotice, loud } from './launcher/agent-errors.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const names = Object.keys(agents).join(', ');
// Mistakes in the command line stop everything before anything starts.
function refuse(message: string): never { console.error(loud(`fdc: ${message}`)); process.exit(2); }
function agentNamed(name: string | undefined): AgentDefinition {
  if (!name) refuse(`Name the coding agent to start: fdc [options] <agent> [agent options]. Agents: ${names}. See fdc --help.`);
  if (!Object.hasOwn(agents, name)) refuse(`Unknown agent "${name}". Agents: ${names}.`);
  return agents[name];
}
let launch: LaunchCommand;
try { launch = parseLaunchArgs(process.argv.slice(2)); } catch (error) { if (error instanceof UsageError) refuse(error.message); throw error; }
const { values, command, agentArgs } = launch;
if (values.help) {
  const list = Object.values(agents);
  console.log(`Usage: fdc [options] <agent> [the agent's own arguments]
       npm start -- [options] <agent> [the agent's own arguments]

Runs the agent's usual command in this terminal, with a voice companion in the
browser. Everything after the agent's name reaches the agent unchanged.

Agents:
${list.map(agent => `  ${agent.profile.id.padEnd(22)}${agent.profile.product}`).join('\n')}
Options, before the agent's name:
  --voice marin         GPT Live voice
  --observe MODE        How to observe the agent's text (${list.filter(agent => agent.observationModes.length).map(agent => `${agent.profile.id}: ${agent.observationModes.join(' (default) or ')}`).join('; ')})
  --port 8123           Local port (default 8123; 0 chooses a free port)
  --public              Also reach the companion from a phone, through a temporary
                        Cloudflare tunnel this launcher starts and stops (needs cloudflared)
  -h, --help            Show this help
Commands:
  fdc doctor [agent]    Check local prerequisites without API spending
  fdc usage             Show recorded voice usage and cost estimates

Examples:
${list.flatMap(agent => agent.usage.examples).map(example => `  fdc ${example}`).join('\n')}

Run fdc in your project's folder; the agent works there. Open the companion link
it prints, and click Start voice when the agent is ready. End voice stops API
billing and leaves the agent running.

${list.map(agent => agent.usage.notes).join('\n\n')}`);
  process.exit(0);
}
if (command === 'usage') { console.log(JSON.stringify(new UsageLedger(path.join(root, '.runs/budget.json')).summary(), null, 2)); process.exit(0); }
if (command === 'doctor') {
  // One agent when named; otherwise every agent, and any one of them ready is enough.
  const checked = (launch.agent ? [agentNamed(launch.agent)] : Object.values(agents)).map(agent => agent.doctor());
  const report = { node: process.version, ...Object.assign({}, ...checked.map(result => result.report)), openAIKeyPresent: Boolean(process.env.OPENAI_API_KEY), microphone: 'Browser grants access when you click Start voice', budget: new UsageLedger(path.join(root, '.runs/budget.json')).summary() };
  console.log(JSON.stringify(report, null, 2)); process.exit(checked.some(result => result.ok) && process.env.OPENAI_API_KEY ? 0 : 1);
}
const agent = agentNamed(launch.agent);
const { name, product, transport } = agent.profile;
// The agent works where fdc runs; `npm start` runs in the repository, so use the folder npm was started from.
const cwd = fs.realpathSync(process.env.npm_lifecycle_event && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd());
let session: AgentArguments;
try { session = agent.readArgs(agentArgs); } catch (error) { refuse(`${agent.profile.id} ${agentArgs.join(' ')}: ${(error as Error).message}`); }
if (session.direct) {
  // Help, version and subcommands are not sessions: run the agent's command as is,
  // still without the companion's OpenAI key.
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  const child = spawn(agent.profile.id, agentArgs, { cwd, env, stdio: 'inherit' });
  child.on('error', error => refuse(`${agent.profile.id}: ${error.message}`));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  await run(agent, session);
}

// Whether a command can be started by name, as spawn finds it: a shell alias or function cannot.
function onPath(command: string) {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, command), fs.constants.X_OK); return true; } catch { return false; }
  });
}

async function run(agent: AgentDefinition, session: AgentArguments) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse(`Run fdc in a terminal. The final interface is the normal interactive ${product} chat.`);
  const { id } = agent.profile;
  if (!onPath(id)) refuse(`${id} is not on your PATH, so ${product} cannot start. A shell alias does not count: fdc starts ${id} as a program. Install ${product}, or put a script named ${id} on your PATH that runs it.`);
  if (!process.env.OPENAI_API_KEY) refuse('Add OPENAI_API_KEY to .env or your environment.');
  const modes = agent.observationModes;
  if (values.observe !== undefined && !modes.includes(values.observe)) refuse(modes.length ? `--observe must be ${modes.join(' or ')} for ${agent.profile.id}.` : `--observe does not apply to ${agent.profile.id}.`);
  // A stable address lets Chrome remember microphone access between launches.
  const DEFAULT_PORT = 8123;
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) refuse('--port must be a whole number from 0 to 65535.');
  // A new conversation gets its ID here. A resumed one names its own, or the
  // agent's first event does.
  const sessionId = session.sessionId ?? (session.assignSession ? randomUUID() : undefined);
  const runDir = path.join(root, '.runs', `${new Date().toISOString().replaceAll(':', '-')}-${sessionId?.slice(0, 8) ?? (session.resume ? 'resumed' : agent.profile.id)}`);
  let harness: Harness;
  try { harness = await new Harness({ agent, root, runDir, cwd, sessionId, apiKey: process.env.OPENAI_API_KEY!, port, portFallback: values.port === undefined, voice: values.voice, observation: values.observe, agentArgs }).start(); }
  catch (error) { console.error(loud(`fdc: ${(error as Error).message}`)); process.exit(1); }
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
    try { tunnel = await startTunnel({ port: new URL(harness.baseUrl).port, log: line => harness.log({ type: 'tunnel.log', line }), onAddress: url => harness.setPublicUrl(url) }); }
    catch (error) { console.error(loud(`fdc: ${(error as Error).message}`)); await exit('tunnel failed', 1); }
    const { url, child: tunnelProcess } = tunnel!;
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
  // The agent's error output passes through to the terminal, and a copy is kept.
  child = spawn(launch.command, launch.args, { cwd, env: childEnv, stdio: ['inherit', 'inherit', 'pipe'] });
  const errors = new ErrorTail();
  child.stderr!.on('data', (chunk: Buffer) => { process.stderr.write(chunk); errors.push(chunk); });
  // Ctrl-C belongs to the agent's terminal interaction. Exiting the agent ends the harness.
  process.on('SIGINT', () => {});
  child.on('error', async error => { console.error(loud(`fdc: ${name} failed to start: ${error.message}`)); await exit(`${name} failed to start`, 1); });
  child.on('exit', async (code, signal) => {
    // Our own teardown ends the agent too; only an agent that ends by itself can have failed.
    const byItself = !stopping;
    if (!child!.stderr!.readableEnded) await Promise.race([once(child!.stderr!, 'end'), new Promise(resolve => setTimeout(resolve, 500))]);
    const output = errors.output;
    harness.log({ type: 'agent.exit', code, signal, stderr: output.toString('utf8') });
    await stop(signal ? `${name} ended (${signal})` : `${name} exited (${code})`);
    // Now that the agent has given the terminal back, nothing can hide it.
    const notice = byItself ? failureNotice(name, code, signal, output) : undefined;
    if (notice) {
      process.stderr.write(`\n${loud(notice)}\n`);
      if (output.toString('utf8').trim()) process.stderr.write(output.at(-1) === 0x0a ? output : Buffer.concat([output, Buffer.from('\n')]));
    }
    console.log(`\nFull-Duplex Code stopped${tunnel ? ' and closed the Cloudflare tunnel' : ''}. Usage saved in .runs/budget.json.`);
    process.exit(code ?? 1);
  });
}
