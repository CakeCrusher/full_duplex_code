import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { Harness } from '../src/core/bridge.ts';
import { voiceRequest } from '../src/core/prompts.ts';
import { askAgent } from '../src/core/instruction-distiller.ts';
import { agy, type AgyAdapter } from '../src/adapters/agy/index.ts';
import { root, until, delay } from './test-support.ts';

// Antigravity (agy) through fdc, for real and without voice (it spends Antigravity's own usage, no GPT Live): a new
// session opens with fdc's greeting; a request reaches it at rest (woken through its language server) and while it works
// (at its next model call); a tool that waits for approval is reported and followed; a question goes to a fork of the
// session, in a pseudo-terminal standing for its window; the session resumed with --conversation remembers; and agy's
// one-off mode writes a reply. The record goes to the run's folder (evidence.json).
//   node --env-file=.env scripts/test-agy.ts [agy options, such as --model gemini-3.8-flash-low]
const extra = process.argv.slice(2);
const label = `agy-live-${Date.now()}`, testDir = path.join(root, '.runs', label), cwd = path.join(testDir, 'project');
fs.mkdirSync(cwd, { recursive: true }); spawnSync('git', ['init', '--quiet'], { cwd });
fs.writeFileSync(path.join(cwd, 'README.md'), '# Notes\n\nA small project for trying things.\n');
const evidence: Record<string, any> = { passed: false, extra, steps: {} };
const helper = path.join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
const env = () => { const e: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete e.OPENAI_API_KEY; delete e.TYPESAFE_API_KEY; return e; };
// The test project is trusted for this session only (--settings is never saved).
const trust = ['--settings', JSON.stringify({ trustedWorkspaces: [cwd] })];

async function start(name: string, agentArgs: string[]) {
  const runDir = path.join(testDir, name);
  const harness = await new Harness({ agent: agy, root, runDir, cwd, apiKey: process.env.OPENAI_API_KEY ?? 'unused', agentArgs: [...trust, ...agentArgs, ...extra] }).start();
  const launch = harness.agentLaunch!;
  let raw = '', exited: number | null = null;
  const terminal = pty.spawn(launch.command, launch.args, { name: 'xterm-256color', cols: 140, rows: 45, cwd, env: { ...env(), ...launch.env } });
  terminal.onData(data => { fs.appendFileSync(path.join(runDir, 'terminal.log'), data); raw = (raw + data).slice(-60000); });
  terminal.onExit(({ exitCode }) => { exited = exitCode; });
  const events = () => { try { return fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  const screen = () => stripVTControlCharacters(raw);
  const type = async (text: string) => { terminal.write(text); await delay(400); terminal.write('\r'); };
  const say = (text: string, target?: 'fork') => { const request = { id: randomUUID(), content: voiceRequest([{ role: 'operator', text }]), ...target && { target } }; harness.deliver(request); return request; };
  // The first status after `since` in a state, and the agent's text since.
  const status = (state: string, since: number) => events().find(e => e.type === 'agent.status' && e.state === state && e.at >= since && !e.fork);
  const text = (since: number, fork?: boolean) => events().filter(e => e.type === 'agent.text' && e.at >= since && Boolean(e.fork) === Boolean(fork)).map(e => e.text).join(' ');
  const received = (id: string) => events().find(e => e.type === 'agent.input' && String(e.text).includes(id));
  const quit = async () => { if (exited !== null) return; terminal.write('/exit'); await delay(600); terminal.write('\r'); await until(() => exited !== null, { label: 'agy exited', timeout: 20000 }).catch(() => terminal.kill()); };
  return { harness, terminal, runDir, events, screen, type, say, status, text, received, quit, exited: () => exited };
}

let run: Awaited<ReturnType<typeof start>> | undefined, fork: pty.IPty | undefined;
try {
  // 1. A new session: fdc's greeting opens its conversation, and the companion connects.
  const began = Date.now();
  run = await start('first', []);
  await until(() => run!.harness.agentReady && run!.harness.sessionId, { label: 'agy connected through fdc', timeout: 90000 });
  const sessionId = run.harness.sessionId!;
  await until(() => run!.status('idle', began) && run!.text(began), { label: 'the greeting answered', timeout: 90000 });
  evidence.steps.started = { sessionId, connectedAfterMs: run.events().find(e => e.type === 'agy.server')?.at - began, greeting: run.text(began).slice(0, 80) };

  // 2. At rest: woken through its language server, it takes the request at its first model call.
  let since = Date.now();
  const idle = run.say('Create a file named idle.txt in the project containing the word idle. Then reply with one short sentence.');
  await until(() => fs.existsSync(path.join(cwd, 'idle.txt')), { label: 'idle.txt made from a request sent at rest', timeout: 120000 });
  const idleIn = await until(() => run!.received(idle.id), { label: 'the request observed as the operator\'s message', timeout: 30000 });
  await until(() => run!.status('idle', idleIn.at), { label: 'the turn ended', timeout: 120000 });
  evidence.steps.atRest = { receivedAfterMs: idleIn.at - since, woken: run.events().some(e => e.type === 'agy.woken' && e.at >= since), reply: run.text(since).slice(0, 160) };

  // 3. While it works: steered in at its next model call, before the turn ends.
  since = Date.now();
  await run.type('Run the shell command `sleep 3` three times, one after another, each in the foreground. Before each run, say which run is next. Then reply FINISHED.');
  await until(() => run!.events().some(e => e.type === 'agent.status' && e.at >= since && / is using run_command$/.test(e.detail ?? '')), { label: 'agy running its first command', timeout: 90000 });
  const steer = run.say('Also, while you are at it, create a file named steer.txt containing the word steer.');
  const steerIn = await until(() => run!.received(steer.id), { label: 'the request taken mid-turn', timeout: 120000 });
  await until(() => fs.existsSync(path.join(cwd, 'steer.txt')), { label: 'steer.txt made', timeout: 120000 });
  const endedAfter = await until(() => run!.status('idle', since), { label: 'the turn ended', timeout: 180000 });
  const injected = run.events().find(e => e.type === 'agy.injected' && e.ids?.includes(steer.id));
  assert.ok(injected && injected.invocation > 0, 'taken at a later model call of the running turn');
  assert.ok(steerIn.at < endedAfter.at, 'received before the turn ended');
  evidence.steps.midTurn = { invocation: injected.invocation, receivedBeforeTurnEndMs: endedAfter.at - steerIn.at, woken: run.events().some(e => e.type === 'agy.woken' && e.at >= since) };

  // 4. A tool that waits for the operator's approval: reported as needing attention, then followed once answered.
  since = Date.now();
  const outside = run.say('Read the file /etc/hosts and tell me how many lines it has.');
  const asked = await until(() => run!.status('needs_attention', since), { label: 'approval reported', timeout: 120000 });
  const attention = run.harness.observer.observations.findLast(o => o.kind === 'attention');
  await delay(1500); run.terminal.write('1'); await delay(300); run.terminal.write('\r');
  await until(() => run!.events().some(e => e.type === 'agent.status' && e.at > asked.at && e.state === 'working'), { label: 'working again once approved', timeout: 30000 });
  await until(() => run!.status('idle', asked.at), { label: 'the turn ended', timeout: 120000 });
  evidence.steps.approval = { detail: asked.detail, record: attention?.text.slice(0, 200), request: outside.id, reply: run.text(asked.at).slice(0, 160) };

  // 5. A question asked aside: a fork of the session, opened in a pseudo-terminal standing for its window.
  run.harness.forks.open = script => {
    const forkEnv = env(); delete forkEnv.FD_BRIDGE_TOKEN;
    fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 140, rows: 45, cwd, env: forkEnv });
    fork.onData(data => fs.appendFileSync(path.join(testDir, 'fork-terminal.log'), data));
    return 'test terminal';
  };
  since = Date.now();
  const told = await run.harness.forks.start('What files are in the project?');
  assert.ok(told && run.harness.forks.focus === 'fork', `the fork opened: ${told}`);
  await until(() => run!.harness.forks.ready, { label: "the fork's agy connected", timeout: 90000 });
  const forkId = (run.harness.forks.adapter as AgyAdapter).observations.sessionId;
  assert.ok(forkId && forkId !== sessionId, 'a conversation of its own');
  const aside = run.say('Which files are in the project folder? Answer in one line, without changing anything.', 'fork');
  await until(() => run!.events().some(e => e.type === 'agent.input' && e.fork && String(e.text).includes(aside.id)), { label: 'the fork took the question', timeout: 120000 });
  const forkAnswer = await until(() => { const t = run!.text(since, true); return /idle\.txt/.test(t) && /steer\.txt/.test(t) ? t : ''; }, { label: "the fork's answer, from the session's history and files", timeout: 120000 });
  assert.equal(run.harness.sessionId, sessionId, 'the main session is still the one followed');
  run.harness.forks.back('the test is done with the fork');
  evidence.steps.fork = { conversation: forkId, forkedAt: run.events().find(e => e.type === 'agy.forked')?.step, answer: forkAnswer.slice(0, 200) };
  fork?.write('/exit'); await delay(600); fork?.write('\r');

  // 6. Resumed with --conversation: the conversation, named by agy's log as it starts, remembers.
  await run.quit(); await run.harness.close(); run = undefined;
  const resumedAt = Date.now();
  run = await start('resumed', ['--conversation', sessionId]);
  await until(() => run!.harness.agentReady, { label: 'the resumed session connected', timeout: 90000 });
  assert.equal(run.harness.sessionId, sessionId, 'the same conversation');
  assert.ok(!run.events().some(e => e.type === 'agent.input' && e.at >= resumedAt && /Voice is on/.test(String(e.text))), 'no greeting on resume');
  since = Date.now();
  run.say('Which files did you create earlier in this conversation? Answer in one line.');
  const recall = await until(() => { const t = run!.text(since); return /idle\.txt/.test(t) && /steer\.txt/.test(t) ? t : ''; }, { label: 'history recalled', timeout: 120000 });
  evidence.steps.resumed = { connectedAfterMs: run.events().find(e => e.type === 'agy.server')?.at - resumedAt, recall: recall.slice(0, 200) };
  await run.quit(); await run.harness.close(); run = undefined;

  // 7. Its one-off mode, for a short piece of writing (a learned instruction).
  const reply = await askAgent(agy, 'Reply with exactly: <instruction>Answer in short sentences.</instruction>', { cwd });
  assert.match(reply, /<instruction>Answer in short sentences\.<\/instruction>/);
  evidence.steps.ask = reply;
  evidence.passed = true;
  console.log('\nAGY THROUGH FDC PASSED');
} catch (error) { evidence.error = (error as Error).message; process.exitCode = 1; }
finally {
  if (run) { evidence.screen = run.screen().slice(-1500); await run.quit().catch(() => {}); await run.harness.close().catch(() => {}); }
  fork?.kill();
  fs.writeFileSync(path.join(testDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
