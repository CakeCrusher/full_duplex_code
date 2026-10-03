import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { root, synthesize, connectVoice, until, delay } from './test-support.ts';

// The required end-to-end run (CONTRIBUTING.md), through the fdc command a user
// runs, found on the PATH as the shell finds it, never through the bridge
// directly: fdc <agent> in a new project folder, Enter, voice; work typed in the
// agent's terminal; a spoken request while the agent works, which must arrive
// mid-turn and be acted on; a spoken question about the work; exit; then the
// session resumed with the agent's own option, and a spoken question its
// history must answer. Spends GPT Live and the agent's own usage.
//   npm run test:fdc -- pi        (or claude, codex)
const agent = process.argv[2];
interface Agent { args: string[]; resume: (sessionId: string) => string[]; quit: (t: pty.IPty) => Promise<void> }
const keys = async (t: pty.IPty, ...writes: string[]) => { for (const w of writes) { t.write(w); await delay(500); } };
const AGENTS: Record<string, Agent> = {
  claude: { args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Bash'], resume: id => ['--resume', id, '--permission-mode', 'acceptEdits'], quit: t => keys(t, '/exit', '\r') },
  codex: { args: ['--no-alt-screen', '-s', 'workspace-write', '-a', 'never'], resume: id => ['resume', '--no-alt-screen', id], quit: t => keys(t, '\x03', '\x03') },
  pi: { args: [], resume: () => ['--continue'], quit: t => keys(t, '\x04', '\x03', '\x03') },
};
if (!Object.hasOwn(AGENTS, agent)) { console.error(`Usage: npm run test:fdc -- <${Object.keys(AGENTS).join('|')}>`); process.exit(2); }
const fdc = spawnSync('sh', ['-c', 'command -v fdc'], { encoding: 'utf8' }).stdout.trim();
if (!fdc) { console.error('fdc is not on the PATH: run npm link first.'); process.exit(2); }

const label = `fdc-${agent}-${Date.now()}`, testDir = path.join(root, '.runs', label), cwd = path.join(testDir, 'project');
fs.mkdirSync(cwd, { recursive: true }); spawnSync('git', ['init', '--quiet'], { cwd });
const evidence: Record<string, any> = { agent, fdc, passed: false };
const work = 'Create three files one at a time, in this order: a.txt, b.txt, c.txt. Each contains just its letter. Before each file, run the shell command `sleep 15`. Write one short sentence before each file saying which file is next. When all are done, say DONE.';
const request = synthesize('fdc-request', 'Please also create one more file, named voice dot txt, containing the word voice.');
const question = synthesize('fdc-question', 'Which files have been created so far?');
const recall = synthesize('fdc-recall', 'Which files were created earlier in this session?');

// One fdc run in a terminal, as a user starts it. Accepts the agent's own first-run prompts.
async function launch(name: string, args: string[]) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' };
  // Run from inside Claude Code, a child Claude would belong to that session and
  // never save its own conversation, so resuming it would find nothing.
  for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
  const terminal = pty.spawn(fdc, ['--port', '0', agent, ...args], { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
  let raw = '', exited: number | null = null, entered = false, trusted = false, channel = false, update = false;
  terminal.onData(data => {
    fs.appendFileSync(path.join(testDir, `${name}.terminal.log`), data);
    raw = (raw + data).slice(-60000);
    const compact = stripVTControlCharacters(raw).replace(/[^A-Za-z]/g, '');
    if (!entered && raw.includes('Press Enter to start')) { entered = true; setTimeout(() => terminal.write('\r'), 300); }
    if (entered && !trusted && /YesItrustthisfolder|trustthecontents|Doyoutrust/i.test(compact)) {
      trusted = true; setTimeout(() => terminal.write(agent === 'claude' ? '\x1b[B' : '\r'), 300); if (agent === 'claude') setTimeout(() => terminal.write('\r'), 600);
    }
    // Codex offers an update before it starts: skip it, as the next option.
    if (entered && !update && compact.includes('Updateavailable') && compact.includes('Updatenow')) { update = true; setTimeout(() => terminal.write('\x1b[B'), 300); setTimeout(() => terminal.write('\r'), 700); }
    if (entered && !channel && compact.includes('Iamusingthisforlocaldevelopment')) { channel = true; for (let i = 1; i <= 4; i++) setTimeout(() => terminal.write('\r'), 700 * i); }
  });
  terminal.onExit(({ exitCode }) => { exited = exitCode; });
  const text = () => stripVTControlCharacters(raw);
  const link = await until(() => text().match(/Full-Duplex Code: (http:\/\/127\.0\.0\.1:\d+)\/#([0-9a-f]{64})/), { label: 'the companion link', timeout: 30000 });
  const runDir = (await until(() => text().match(/Local run: (\S+)/), { label: 'the run folder' }))[1];
  const baseUrl = link[1], browserToken = link[2];
  const status = async () => (await fetch(`${baseUrl}/api/status`, { headers: { Authorization: `Bearer ${browserToken}` } })).json();
  const events = () => { try { return fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  let ready: any;
  for (const start = Date.now(); Date.now() - start < 120000 && exited === null; await delay(500)) {
    const s = await status().catch(() => undefined);
    if (s?.agentReady && !['starting', 'exited'].includes(s.agent)) { ready = s; break; }
  }
  if (!ready) throw new Error(`${agent} did not become ready through fdc${exited !== null ? ` (fdc exited ${exited})` : ''}: ${text().slice(-600)}`);
  console.log(`${name}: ${runDir}`);
  return { terminal, runDir, baseUrl, browserToken, status, events, sessionId: ready.sessionId as string, exited: () => exited,
    async quit() { await AGENTS[agent].quit(terminal); await until(() => exited !== null, { label: 'fdc exited with the agent', timeout: 30000 }).catch(() => terminal.kill()); } };
}
// until() for checks that must ask the bridge.
async function waitFor(check: () => Promise<boolean>, label: string, timeout: number) {
  for (const start = Date.now(); Date.now() - start < timeout; await delay(500)) if (await check().catch(() => false)) return;
  throw new Error(`Timed out waiting for ${label}`);
}
const said = (voice: Awaited<ReturnType<typeof connectVoice>>, since: number) => voice.events.filter(e => e.type === 'caption' && e.role === 'intermediary' && e.at >= since).map(e => e.text).join('');
const files = () => fs.readdirSync(cwd).filter(f => f.endsWith('.txt')).sort();

let run: Awaited<ReturnType<typeof launch>> | undefined, voice: Awaited<ReturnType<typeof connectVoice>> | undefined;
try {
  run = await launch('first', AGENTS[agent].args);
  const command = run.events().find(e => e.type === 'launcher.command');
  evidence.command = command && { command: command.command, via: command.via };
  // Typed work, then a spoken request while the agent works on it.
  run.terminal.write(work); await delay(500); run.terminal.write('\r');
  await waitFor(async () => (await run!.status()).agent === 'working', `${agent} working on the typed work`, 60000);
  const typedAt = Date.now();
  voice = await connectVoice({ baseUrl: run.baseUrl, browserToken: run.browserToken, runDir: run.runDir });
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting', timeout: 30000 });
  // Speak just after the agent starts its next command, when its events pause:
  // events arriving while Live answers can keep it from delegating (USAGE.md).
  const commandsStarted = () => run!.events().filter(e => e.type === 'agent.status' && / is using bash$/i.test(e.detail ?? '')).length;
  const started = commandsStarted();
  await until(() => commandsStarted() > started, { label: `${agent} started a long command`, timeout: 90000 });
  await delay(2500);
  assert.equal((await run.status()).agent, 'working', `${agent} is still working when the request is spoken`);
  await voice.speak(request);
  const task = await until(() => run!.events().find(e => e.type === 'task' && e.state === 'sent'), { label: 'Live delegated the request and it was sent', timeout: 60000 });
  const received = await until(() => run!.events().find(e => e.type === 'agent.input' && String(e.text).includes(task.id)), { label: `${agent} received the request`, timeout: 120000 });
  const idles = () => run!.events().filter(e => e.type === 'agent.status' && e.state === 'idle' && e.at >= typedAt);
  await until(() => fs.existsSync(path.join(cwd, 'voice.txt')) && files().length >= 4, { label: 'the work and the request done', timeout: 360000 });
  await waitFor(async () => (await run!.status()).agent === 'idle', `${agent} idle`, 120000);
  const firstIdle = idles()[0];
  assert.ok(received.at < firstIdle.at, 'the request arrived mid-turn, before the agent first finished');
  assert.match(fs.readFileSync(path.join(cwd, 'voice.txt'), 'utf8'), /voice/i);
  await delay(4000);
  const asked = Date.now();
  await voice.speak(question);
  const answer = await until(() => { const text = said(voice!, asked); return /voice/i.test(text) && /\b[abc]\b|[abc]\.txt|three/i.test(text) ? text : ''; }, { label: 'an answer naming the files', timeout: 45000 });
  await delay(3000); await voice.close(); voice = undefined;
  Object.assign(evidence, { sessionId: run.sessionId, request: task.id, receivedMidTurn: true, files: files(), answer });
  await run.quit();
  evidence.exitCode = run.exited();

  // The same session, resumed with the agent's own option: its history answers.
  run = await launch('resumed', AGENTS[agent].resume(evidence.sessionId));
  assert.equal(run.sessionId, evidence.sessionId, 'fdc resumed the same session');
  voice = await connectVoice({ baseUrl: run.baseUrl, browserToken: run.browserToken, runDir: run.runDir });
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting after resume', timeout: 30000 });
  await delay(1500);
  const recalled = Date.now();
  await voice.speak(recall);
  evidence.recall = await until(() => { const text = said(voice!, recalled); return /voice/i.test(text) ? text : ''; }, { label: 'history recalled after resume', timeout: 45000 });
  await delay(3000); await voice.close(); voice = undefined;
  await run.quit(); run = undefined;
  evidence.passed = true;
  console.log(`\nFDC END TO END PASSED: ${agent}`);
} catch (error) { evidence.error = (error as Error).message; process.exitCode = 1; }
finally {
  if (voice) await voice.close().catch(() => {});
  if (run && run.exited() === null) { await run.quit().catch(() => {}); if (run.exited() === null) run.terminal.kill(); }
  fs.writeFileSync(path.join(testDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
