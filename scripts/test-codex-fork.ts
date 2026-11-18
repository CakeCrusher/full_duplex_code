import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { startCodexTestHarness, until, delay } from './test-support.ts';

// Forks with real Codex, without voice (uses the operator's Codex usage, no GPT Live spending): a request to the main
// session, which starts a long job; a fork opened for a tangent while it works, run here in a terminal of its own instead
// of a window, where nothing is typed; a request that goes to the fork, which knows the main session's history and is
// told it is a fork; then back to the main session, and a request that goes there; then a second fork whose window closes.
const test = await startCodexTestHarness('codex-fork');
const { harness, cwd } = test;
const evidence: Record<string, unknown> = { passed: false };
let fork: pty.IPty | undefined;
const send = (said: string) => { const id = randomUUID(); harness.deliver({ id, content: `User request (transcribed speech).\n\nuser: ${said}`, said }); return id; };
const file = (name: string) => path.join(cwd, name);
const events = () => fs.readFileSync(path.join(harness.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
// Who received a request: the main session's input, or the fork's (logged with its number).
const receivedBy = (id: string) => events().find(e => e.type === 'agent.input' && String(e.text).includes(id));
try {
  // The main session starts a long job: the tangent comes while it works, as in real use.
  const first = send('Create a file named main.txt containing the word main. Then run the shell command `sleep 75` in the foreground, and after it finishes create a file named slow-done.txt containing the word done. Nothing else.');
  await until(() => fs.existsSync(file('main.txt')), { label: 'main.txt', timeout: 120000 });
  assert.equal(receivedBy(first)?.fork, undefined, 'the first request reached the main session');
  await until(() => harness.observer.state === 'working', { label: 'the main session at work', timeout: 30000 });
  await delay(3000);
  // The fork, in a terminal of its own, as its window would run it: a new window's shell, without fdc's OpenAI key.
  harness.forks.open = script => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
    const log = path.join(harness.runDir, `fork-terminal-${harness.forks.count}.log`);
    const term = fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
    term.onData(data => fs.appendFileSync(log, data));
    return 'test terminal';
  };
  const openedAt = Date.now();
  evidence.told = await harness.forks.start('By the way, unrelated: make a tangent file.');
  assert.equal(harness.forks.focus, 'fork');
  await until(() => harness.forks.ready, { label: "the fork's session attached", timeout: 90000 });
  evidence.attachedAfterMs = Date.now() - openedAt;
  const forkSession = (await until(() => events().find(e => e.type === 'fork.session'), { label: "the fork's session ID" })).sessionId;
  assert.ok(forkSession && forkSession !== harness.sessionId, 'the fork is a session of its own');
  const tangent = send('Two things, then stop. First: in this session, which file did you create first? Write its exact name into a new file named history.txt. Second: were you told that this session is a fork of another session? Write yes or no into a new file named fork.txt. Do not wait for anything else.');
  await until(() => fs.existsSync(file('history.txt')) && fs.existsSync(file('fork.txt')), { label: 'the fork did the tangent', timeout: 180000 });
  assert.ok(receivedBy(tangent)?.fork, 'the tangent reached the fork, not the main session');
  assert.match(fs.readFileSync(file('history.txt'), 'utf8'), /main\.txt/, "the fork knows the main session's history");
  assert.match(fs.readFileSync(file('fork.txt'), 'utf8'), /yes/i, 'the fork was told it is one');
  assert.equal(fs.existsSync(file('slow-done.txt')), false, 'the fork finished its tangent while the main session still worked');
  // Both sessions' hooks reached fdc meanwhile, each on its own route.
  await until(() => events().some(e => e.at >= openedAt && e.fork && e.type === 'agent.hook' && e.name === 'Stop'), { label: "the fork's turn end", timeout: 60000 });
  const during = events().filter(e => e.at >= openedAt && e.type === 'agent.hook');
  evidence.hooks = { fork: [...new Set(during.filter(e => e.fork).map(e => e.name))], main: [...new Set(during.filter(e => !e.fork).map(e => e.name))] };
  assert.ok(during.some(e => e.fork && e.name === 'PostToolUse'), "the fork's tool calls reached fdc");
  evidence.forkSaid = events().filter(e => e.type === 'agent.text' && e.fork).map(e => String(e.text).slice(0, 200));
  evidence.delivery = events().filter(e => e.type === 'codex.delivery').map(e => ({ fork: e.fork, via: e.via, error: e.error }));
  // Settled while the main session still works: the next request goes to it.
  evidence.back = harness.forks.back('the tangent is settled');
  const again = send('Also create a file named back.txt containing the word back.');
  // The fork left behind keeps its window: Codex there still has its app server.
  await delay(12000);
  const firstServer = events().find(e => e.type === 'codex.app_server_started' && e.fork === 1).pid;
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const shown = () => stripVTControlCharacters(fs.readFileSync(path.join(harness.runDir, 'fork-terminal-1.log'), 'utf8'));
  assert.ok(running(firstServer) && !/Reconnecting/.test(shown()), "the fork left behind still runs in its window");
  await until(() => fs.existsSync(file('back.txt')) && fs.existsSync(file('slow-done.txt')), { label: 'back.txt and the long job', timeout: 240000 });
  assert.equal(receivedBy(again)?.fork, undefined, 'after the tangent, requests reach the main session');
  await until(() => events().some(e => !e.fork && e.type === 'agent.hook' && e.name === 'Stop' && e.at > openedAt), { label: "the main session's turn end", timeout: 120000 });
  // A second fork, whose window the operator closes: the focus comes back by itself.
  const firstFork = fork!;
  evidence.second = await harness.forks.start('Another aside: what does the README say?');
  assert.equal(harness.forks.focus, 'fork');
  await until(() => harness.forks.ready, { label: "the second fork's session attached", timeout: 90000 });
  firstFork.kill('SIGHUP');
  await until(() => !running(firstServer), { label: "the first fork's app server stopping once its window closed", timeout: 30000 });
  evidence.leftBehind = 'ran in its window until the window closed, then its app server stopped';
  fork!.kill('SIGHUP');
  await until(() => harness.forks.focus === 'main', { label: 'the focus back once the window closed', timeout: 30000 });
  evidence.closed = events().filter(e => e.type === 'fork.back').map(e => e.why);
  Object.assign(evidence, { passed: true, main: harness.sessionId, fork: forkSession, files: fs.readdirSync(cwd).filter(f => f.endsWith('.txt')).sort() });
  console.log('CODEX FORK END TO END PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  evidence.forkTerminal = (() => { try { return stripVTControlCharacters(fs.readFileSync(path.join(harness.runDir, 'fork-terminal-1.log'), 'utf8')).replace(/\s+/g, ' ').slice(0, 1200); } catch { return undefined; } })();
  console.log(JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(harness.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  fork?.kill('SIGTERM');
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
