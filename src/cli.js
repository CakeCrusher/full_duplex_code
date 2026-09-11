#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Harness } from './server.js';
import { Budget } from './budget.js';
import { claudeArgs } from './agent.js';

const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  cwd: { type: 'string', default: process.cwd() }, resume: { type: 'string' },
  'no-open': { type: 'boolean', default: false }, 'max-minutes': { type: 'string', default: '30' },
  voice: { type: 'string', default: 'marin' }, observe: { type: 'string', default: 'hooks' },
  port: { type: 'string', default: '0' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log(`Usage: npm start -- [--cwd /project] [--resume SESSION_ID] [--no-open]
  --max-minutes 30       Maximum voice connection duration; Claude stays open
  --voice marin         GPT Live voice
  --observe hooks       Live display hooks (default), or transcript file tail
  --port 0              Local port (0 chooses a free port)
  npm run doctor        Check local prerequisites without API spending
  npm run usage         Show the local $25 voice spending budget

Claude opens in your terminal. Open the companion URL and click Start voice once
to enable the microphone and speaker. Ordinary Claude permission prompts remain
in the terminal. End voice stops API billing while leaving Claude available.`);
  process.exit(0);
}
if (positionals[0] === 'usage') { console.log(JSON.stringify(new Budget(path.join(root, '.runs/budget.json')).summary(), null, 2)); process.exit(0); }
if (positionals[0] === 'doctor') {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  let loggedIn = false; try { loggedIn = JSON.parse(auth.stdout).loggedIn; } catch {}
  const report = { node: process.version, claude: version.stdout?.trim() || 'not found', claudeLoggedIn: loggedIn, openAIKeyPresent: Boolean(process.env.OPENAI_API_KEY), microphone: 'Browser grants access when you click Start voice', budget: new Budget(path.join(root, '.runs/budget.json')).summary() };
  console.log(JSON.stringify(report, null, 2)); process.exit(version.status === 0 && loggedIn && process.env.OPENAI_API_KEY ? 0 : 1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Launch npm start in a terminal. The final interface is the normal interactive Claude Code chat.');
if (!process.env.OPENAI_API_KEY) throw new Error('Add OPENAI_API_KEY to .env or your environment.');
if (!['hooks', 'transcript'].includes(values.observe)) throw new Error('--observe must be hooks or transcript');
const maxSeconds = Number(values['max-minutes']) * 60; const port = Number(values.port);
if (!Number.isFinite(maxSeconds) || maxSeconds < 15 || maxSeconds > 14400) throw new Error('--max-minutes must be between 0.25 and 240');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const cwd = fs.realpathSync(values.cwd);
const sessionId = values.resume ?? randomUUID();
if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId)) throw new Error('--resume must be a Claude session UUID');
const runDir = path.join(root, '.runs', `${new Date().toISOString().replaceAll(':', '-')}-${sessionId.slice(0, 8)}`);
const harness = await new Harness({ root, runDir, cwd, sessionId, apiKey: process.env.OPENAI_API_KEY, maxSeconds, port, voice: values.voice, observation: values.observe }).start();
console.log(`\nFull-Duplex Code: ${harness.browserUrl}\nClaude will open here. Click Start voice in the browser when the channel is ready.\nLocal run: ${runDir}\n`);
if (!values['no-open']) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
  if (opener) spawn(opener, process.platform === 'darwin' ? ['-a', 'Google Chrome', harness.browserUrl] : [harness.browserUrl], { stdio: 'ignore' }).on('error', () => {});
}
const childEnv = { ...process.env, FD_BRIDGE_TOKEN: harness.channelToken };
delete childEnv.OPENAI_API_KEY;
const child = spawn('claude', claudeArgs({ config: harness.config, sessionId, resume: Boolean(values.resume) }), { cwd, env: childEnv, stdio: 'inherit' });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await harness.close();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
// Ctrl-C belongs to Claude's terminal interaction. Exiting Claude ends the harness.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop());
child.on('error', async error => { console.error(error.message); await stop(); process.exitCode = 1; });
child.on('exit', async code => { await stop(); console.log('\nFull-Duplex Code stopped. Usage saved in .runs/budget.json.'); process.exitCode = code ?? 0; });
