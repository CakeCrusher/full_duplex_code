import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { startTestHarness, until, delay } from './test-support.ts';

// Forks with real Claude Code, without voice (uses the operator's Claude usage, no OpenAI spending): a request to the
// main session; a fork opened for a tangent, run here in a terminal of its own instead of a window, where fdc answers
// Claude's development-channel prompt itself (nobody is at a fork's window); a request that goes
// to the fork, which knows the main session's history; then back to the main session, and a request that goes there.
const test = await startTestHarness('fork');
const { harness, cwd } = test;
const evidence: Record<string, unknown> = { passed: false };
let fork: pty.IPty | undefined;
const send = (said: string) => { const id = randomUUID(); harness.deliver({ id, content: `User request (transcribed speech).\n\nuser: ${said}`, said }); return id; };
const file = (name: string) => path.join(cwd, name);
// Who received a request: the main session's input, or the fork's (logged with its number).
const events = () => fs.readFileSync(path.join(harness.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const receivedBy = (id: string) => events().find(e => e.type === 'agent.input' && String(e.text).includes(id));
try {
  // The main session starts a long job: the tangent comes while it works, as in real use.
  const first = send('Create a file named main.txt containing the word main. Then run the shell command `sleep 75` in the foreground, and after it finishes create a file named slow-done.txt containing the word done. Nothing else.');
  await until(() => fs.existsSync(file('main.txt')), { label: 'main.txt', timeout: 120000 });
  assert.equal(receivedBy(first)?.fork, undefined, 'the first request reached the main session');
  await until(() => harness.observer.state === 'working', { label: 'the main session at work', timeout: 30000 });
  // The fork, in a terminal of its own, as its window would run it.
  harness.forks.open = script => {
    // A new window's shell, as Terminal would start it: not this process's Claude session or OpenAI key.
    const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
    for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
    const term = fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 120, rows: 35, cwd, env });
    // Nothing is typed in it: fdc's own script answers Claude's development-channel prompt (window.ts).
    term.onData(data => fs.appendFileSync(path.join(harness.runDir, 'fork-terminal.log'), data));
    return 'test terminal';
  };
  const openedAt = Date.now();
  evidence.told = await harness.forks.start('By the way, unrelated: make a tangent file.');
  assert.equal(harness.forks.focus, 'fork');
  await until(() => harness.forks.ready, { label: "the fork's channel", timeout: 90000 });
  // Claude asked about the voice channel there, and nobody typed: fdc answered.
  const shown = stripVTControlCharacters(fs.readFileSync(path.join(harness.runDir, 'fork-terminal.log'), 'utf8')).replace(/[^A-Za-z]/g, '');
  evidence.promptAnswered = { shown: shown.includes('Iamusingthisforlocaldevelopment'), connectedAfterMs: Date.now() - openedAt };
  assert.ok(shown.includes('Iamusingthisforlocaldevelopment'), "Claude showed its development-channel prompt in the fork's terminal");
  const tangent = send('In this session, which file did you create first? Write its exact name into a new file named history.txt, and create tangent.txt containing the word tangent. Do not wait for anything else.');
  await until(() => fs.existsSync(file('tangent.txt')) && fs.existsSync(file('history.txt')), { label: 'the fork did the tangent', timeout: 180000 });
  assert.ok(receivedBy(tangent)?.fork, 'the tangent reached the fork, not the main session');
  assert.match(fs.readFileSync(file('history.txt'), 'utf8'), /main\.txt/, "the fork knows the main session's history");
  assert.equal(fs.existsSync(file('slow-done.txt')), false, 'the fork finished its tangent while the main session still worked');
  const forkSession = events().find(e => e.type === 'fork.session')?.sessionId;
  assert.ok(forkSession && forkSession !== harness.sessionId, 'the fork is a session of its own');
  // Both sessions' hooks reached fdc meanwhile, each on its own route.
  await until(() => events().some(e => e.at >= openedAt && e.fork && e.type === 'agent.hook' && e.name === 'Stop'), { label: "the fork's turn end", timeout: 60000 });
  const during = events().filter(e => e.at >= openedAt && e.type === 'agent.hook');
  evidence.hooks = { fork: [...new Set(during.filter(e => e.fork).map(e => e.name))], main: [...new Set(during.filter(e => !e.fork).map(e => e.name))] };
  assert.ok(during.some(e => e.fork && e.name === 'PostToolUse') && during.some(e => e.fork && e.name === 'Stop'), "the fork's tool calls and turn end reached fdc");
  // Settled while the main session still works: the next request goes to it.
  evidence.back = harness.forks.back('the tangent is settled');
  const again = send('Also create a file named back.txt containing the word back.');
  await until(() => fs.existsSync(file('back.txt')) && fs.existsSync(file('slow-done.txt')), { label: 'back.txt and the long job', timeout: 240000 });
  assert.equal(receivedBy(again)?.fork, undefined, 'after the tangent, requests reach the main session');
  assert.ok(events().some(e => !e.fork && e.type === 'agent.hook' && e.name === 'Stop' && e.at > openedAt), "the main session's turn end reached fdc");
  // A second fork, whose window the operator closes: the focus comes back by itself.
  const firstFork = fork!;
  evidence.second = await harness.forks.start('Another aside: what does the README say?');
  assert.equal(harness.forks.focus, 'fork');
  await until(() => harness.forks.ready, { label: "the second fork's channel", timeout: 90000 });
  firstFork.kill('SIGTERM');
  fork!.kill('SIGHUP');
  await until(() => harness.forks.focus === 'main', { label: 'the focus back once the window closed', timeout: 30000 });
  evidence.closed = events().filter(e => e.type === 'fork.back').map(e => e.why);
  Object.assign(evidence, { passed: true, main: harness.sessionId, fork: forkSession, files: fs.readdirSync(cwd).filter(f => f.endsWith('.txt')).sort() });
  console.log('FORK END TO END PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(evidence, null, 2));
  fork?.kill('SIGTERM');
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
