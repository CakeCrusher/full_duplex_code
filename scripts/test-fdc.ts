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
// agent's terminal; a spoken request while the agent works, which is steered into
// the turn or, when Jev finds it can wait, held for the turn's end; then words that
// can't wait, which must arrive mid-turn and bring a held request in before them;
// later a request that says it can wait, which held must arrive when the turn ends;
// both acted on; a spoken question about the work; exit; then the
// session resumed with the agent's own option, and a spoken question its
// history must answer. Spends GPT Live and the agent's own usage.
//   npm run test:fdc -- pi        (or claude, codex, agy)
const agent = process.argv[2];
interface Agent { args: string[]; resume: (sessionId: string) => string[]; quit: (t: pty.IPty) => Promise<void>; /** Its shell tool, as the status names it. */ shell?: string }
const keys = async (t: pty.IPty, ...writes: string[]) => { for (const w of writes) { t.write(w); await delay(500); } };
const AGENTS: Record<string, Agent> = {
  claude: { args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Bash'], resume: id => ['--resume', id, '--permission-mode', 'acceptEdits'], quit: t => keys(t, '/exit', '\r') },
  codex: { args: ['--no-alt-screen', '-s', 'workspace-write', '-a', 'never'], resume: id => ['resume', '--no-alt-screen', id], quit: t => keys(t, '\x03', '\x03') },
  pi: { args: [], resume: () => ['--continue'], quit: t => keys(t, '\x04', '\x03', '\x03') },
  // The test project trusted for this session only (--settings is never saved), so the operator's own list stays as it was.
  agy: { args: ['--dangerously-skip-permissions'], resume: id => ['--conversation', id, '--dangerously-skip-permissions'], quit: t => keys(t, '/exit', '\r'), shell: 'run_command' },
};
const shellUse = new RegExp(` is using ${AGENTS[agent]?.shell ?? 'bash'}$`, 'i');
if (!Object.hasOwn(AGENTS, agent)) { console.error(`Usage: npm run test:fdc -- <${Object.keys(AGENTS).join('|')}>`); process.exit(2); }
// This checkout's own fdc, as its installed command runs it: the one on the PATH may be another checkout's (a worktree
// beside the linked one would test the linked one's code).
const fdc = path.join(root, 'src/cli.ts');

const label = `fdc-${agent}-${Date.now()}`, testDir = path.join(root, '.runs', label), cwd = path.join(testDir, 'project');
fs.mkdirSync(cwd, { recursive: true }); spawnSync('git', ['init', '--quiet'], { cwd });
const evidence: Record<string, any> = { agent, fdc, passed: false };
const work = 'Create five files one at a time, in this order: a.txt, b.txt, c.txt, d.txt, e.txt. Each contains just its letter. Before each file, run the shell command `sleep 15`. Write one short sentence before each file saying which file is next. When all are done, say DONE.';
const request = synthesize('fdc-request', 'Please also create one more file, named voice dot txt, containing the word voice.');
// Words that change the work under way and name no file: a transcript that drops a word must not leave the agent asking which one.
// Said twice over, what matters first: heard as "From now, instead of sleep fifteen" (twice, Nov 15 and 16), the agent
// stopped to ask what was meant, and the check waited six minutes of voice for work that never came.
const pressing = synthesize('fdc-pressing-2', 'Wait, this cannot wait: use sleep five. From now on sleep five seconds, not fifteen.');
const question = synthesize('fdc-question', 'Which files have been created so far?');
// Words that say themselves they can wait: held while the agent works, they must reach it when its turn ends.
const waiting = synthesize('fdc-waiting', 'No rush on this one. Once you have finished what you are doing, create a file named later dot txt containing the word later.');
const recall = synthesize('fdc-recall', 'Which files were created earlier in this session?');

// One fdc run in a terminal, as a user starts it. Accepts the agent's own first-run prompts.
async function launch(name: string, args: string[]) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' };
  // Run from inside Claude Code, a child Claude would belong to that session and
  // never save its own conversation, so resuming it would find nothing.
  for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
  // Run with npm run, npm's variables would make fdc work in this checkout
  // (it honors INIT_CWD for npm start) instead of the test project.
  for (const name of Object.keys(env)) if (/^(npm_|INIT_CWD$)/.test(name)) delete env[name];
  // A question asked while the agent works would open a fork in a new terminal window on this desktop (forks.ts): here
  // the window can't open, so the question goes to the main session, as it does for an agent that can't fork.
  const bin = path.join(testDir, 'bin'); fs.mkdirSync(bin, { recursive: true });
  for (const name of ['open', 'osascript']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "no windows in this test" >&2\nexit 1\n', { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const trust = agent === 'agy' ? ['--settings', JSON.stringify({ trustedWorkspaces: [cwd] })] : [];
  const terminal = pty.spawn(fdc, ['--port', '0', agent, ...trust, ...args], { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
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
// A file named as the voice says it ("a.txt", "a dot txt", "a dot t-x-t"): the greeting's own "voice companion" is no answer.
// As the voice says it and the transcript spells it: "a.txt", "a dot txt", "a-dot-txt", "a through e", "a, b, c, d, and e".
const namesFile = (text: string) => /\b[a-e](\.|[ -]dot[ -])t(xt|-x-t)\b/i.test(text) || /\ba\b[^.]{0,30}\b(through|to)\b[^.]{0,12}\be\b/i.test(text) || /\ba, b, c, d,? (and )?e\b/i.test(text);

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
  const commandsStarted = () => run!.events().filter(e => e.type === 'agent.status' && shellUse.test(e.detail ?? '')).length;
  const started = commandsStarted();
  await until(() => commandsStarted() > started, { label: `${agent} started a long command`, timeout: 90000 });
  await delay(2500); await voice.quiet();
  assert.equal((await run.status()).agent, 'working', `${agent} is still working when the request is spoken`);
  await voice.speak(request);
  // The request is on its way: steered into the running turn, or (with Jev) held until the turn ends when it can wait.
  const task = await until(() => run!.events().find(e => e.type === 'task' && ['held', 'sent'].includes(e.state)), { label: 'the request went, or is held for the end of the turn', timeout: 60000 });
  // Words that can't wait reach the agent mid-turn. A request still held goes with them, as one request (they join it,
  // outbox.ts); one already steered in is followed by them as a request of their own.
  await delay(1500); await voice.quiet();
  assert.equal((await run.status()).agent, 'working', `${agent} is still working when the pressing words are spoken`);
  await voice.speak(pressing);
  const urgent = await until(() => run!.events().find(e => e.type === 'task' && e.state === 'sent' && (e.id !== task.id || e.joined?.length)), { label: 'the words that cannot wait were sent', timeout: 60000 });
  const arrival = (id: string) => until(() => run!.events().find(e => e.type === 'agent.input' && String(e.text).includes(id)), { label: `${agent} received request ${id.slice(0, 8)}`, timeout: 120000 });
  const received = await arrival(task.id), pressed = await arrival(urgent.id);
  const idles = () => run!.events().filter(e => e.type === 'agent.status' && e.state === 'idle' && e.at >= typedAt);
  await until(() => {
    if (fs.existsSync(path.join(cwd, 'voice.txt')) && files().length >= 6) return true;
    // The agent stopped with work left (it asked what was meant): nothing more comes, and voice is billed while this waits.
    const idle = idles().at(-1);
    if (idle && Date.now() - idle.at > 30000 && !run!.events().some(e => e.type === 'agent.status' && e.state === 'working' && e.at > idle.at)) throw new Error(`${agent} stopped before the work was done: ${String(run!.events().findLast(e => e.type === 'agent.text')?.text ?? '').slice(-200)}`);
    return false;
  }, { label: 'the work and the request done', timeout: 360000 });
  await waitFor(async () => (await run!.status()).agent === 'idle', `${agent} idle`, 120000);
  const firstIdle = idles()[0];
  assert.ok(pressed.at < firstIdle.at, 'the words that cannot wait arrived mid-turn, before the agent first finished');
  assert.ok(received.at <= pressed.at, 'the first request arrived before them: steered in itself, or brought in by them');
  evidence.firstRequest = task.state !== 'held' ? 'steered into the turn' : urgent.id === task.id ? 'held for the end of the turn, then taken along by words that could not wait, as one request' : 'held, and delivered when the turn ended';
  evidence.shorterSleepUsed = run.events().some(e => e.type === 'agent.hook' && e.at > pressed.at && /sleep 5\b/.test(JSON.stringify(e.tool_input ?? '')));
  assert.match(fs.readFileSync(path.join(cwd, 'voice.txt'), 'utf8'), /voice/i);
  await delay(4000); await voice.quiet();
  const asked = Date.now();
  await voice.speak(question);
  const answer = await until(() => { const text = said(voice!, asked); return /voice/i.test(text) && namesFile(text) ? text : ''; }, { label: 'an answer naming the files', timeout: 45000 });
  // A request that can wait, spoken while the agent works on something else: held, it reaches the agent when its turn
  // ends (by the agent's own report of the end), and is done then.
  const again = Date.now();
  // Two short sleeps: Claude runs a long one in the background and ends its turn, or declines to wait in the foreground.
  run.terminal.write('Run the shell command `sleep 15`, then run it once more, then say READY.'); await delay(500); run.terminal.write('\r');
  await until(() => run!.events().some(e => e.type === 'agent.status' && e.at >= again && shellUse.test(e.detail ?? '')), { label: `${agent} started the second piece of work`, timeout: 90000 });
  await delay(2500); await voice.quiet();
  const spoke = Date.now();
  await voice.speak(waiting);
  const later = await until(() => run!.events().find(e => e.type === 'task' && e.at >= again && ['held', 'sent'].includes(e.state)), { label: 'the request that can wait went, or is held', timeout: 60000 });
  await until(() => fs.existsSync(path.join(cwd, 'later.txt')), { label: 'the request that could wait was done', timeout: 300000 });
  if (later.state === 'held') {
    const released = run.events().find(e => e.type === 'task.released' && e.id === later.id), ended = run.events().find(e => e.type === 'agent.status' && e.state === 'idle' && e.at >= again);
    assert.ok(released && !released.pressed, 'the held request was released by the end of the turn, not pressed');
    assert.ok(ended && Math.abs(released.at - ended.at) < 2000, `released as the agent finished (${released.at - ended!.at} ms from its going idle)`);
    evidence.waitingRequest = `held ${released.heldSeconds} s, delivered when the turn ended, and done`;
  } else {
    // Delivered at once. Between turns that is right (the agent ended its turn early, with the command left running in
    // the background); in the middle of one, Jev read words that say they can wait as needed now.
    const asked = run.events().findLast(e => e.type === 'turn.job' && e.at >= spoke && e.at <= later.at + 500)?.now;
    assert.equal(asked, undefined, `words that say they can wait were steered into the turn (Jev read now at ${asked})`);
    evidence.waitingRequest = 'delivered at once and done: the agent was between turns, so holding was not exercised';
  }
  await delay(3000); await voice.close(); voice = undefined;
  Object.assign(evidence, { sessionId: run.sessionId, request: task.id, receivedMidTurn: true, files: files(), answer });
  await run.quit();
  evidence.exitCode = run.exited();

  // The same session, resumed with the agent's own option: its history answers.
  run = await launch('resumed', AGENTS[agent].resume(evidence.sessionId));
  assert.equal(run.sessionId, evidence.sessionId, 'fdc resumed the same session');
  voice = await connectVoice({ baseUrl: run.baseUrl, browserToken: run.browserToken, runDir: run.runDir });
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting after resume', timeout: 30000 });
  await delay(1500); await voice.quiet();
  const recalled = Date.now();
  await voice.speak(recall);
  evidence.recall = await until(() => { const text = said(voice!, recalled); return namesFile(text) ? text : ''; }, { label: 'history recalled after resume', timeout: 45000 });
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
