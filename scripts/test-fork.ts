import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { startTestHarness, until, delay } from './test-support.ts';

// Forks with real Claude Code, without voice (uses the operator's Claude usage, no OpenAI spending): a request to the
// main session; a fork opened for a tangent, run here in a terminal of its own instead of a window; a request that goes
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
  const first = send('Create a file named main.txt containing the word main. Nothing else.');
  await until(() => fs.existsSync(file('main.txt')), { label: 'main.txt', timeout: 120000 });
  assert.equal(receivedBy(first)?.fork, undefined, 'the first request reached the main session');
  // The fork, in a terminal of its own: confirm Claude's development-channel prompt as the main one was.
  harness.forks.open = script => {
    // A new window's shell, as Terminal would start it: not this process's Claude session or OpenAI key.
    const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
    for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
    fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 120, rows: 35, cwd, env });
    let raw = '', confirmed = false;
    fork.onData(data => {
      fs.appendFileSync(path.join(harness.runDir, 'fork-terminal.log'), data);
      raw = (raw + data).slice(-40000);
      const compact = stripVTControlCharacters(raw).replace(/[^A-Za-z]/g, '');
      if (!confirmed && compact.includes('Iamusingthisforlocaldevelopment')) { confirmed = true; let n = 0; const t = setInterval(() => { if (harness.forks.ready || ++n > 8) clearInterval(t); else fork!.write('\r'); }, 1000); }
    });
    return 'test terminal';
  };
  const told = await harness.forks.start('By the way, unrelated: make a tangent file.');
  evidence.told = told;
  assert.equal(harness.forks.focus, 'fork');
  await until(() => harness.forks.ready, { label: "the fork's channel", timeout: 90000 });
  const tangent = send('In this session, which file did you create first? Write its exact name into a new file named history.txt, and create tangent.txt containing the word tangent.');
  await until(() => fs.existsSync(file('tangent.txt')) && fs.existsSync(file('history.txt')), { label: 'the fork did the tangent', timeout: 180000 });
  assert.ok(receivedBy(tangent)?.fork, 'the tangent reached the fork, not the main session');
  assert.match(fs.readFileSync(file('history.txt'), 'utf8'), /main\.txt/, "the fork knows the main session's history");
  const forkSession = events().find(e => e.type === 'fork.session')?.sessionId;
  assert.ok(forkSession && forkSession !== harness.sessionId, 'the fork is a session of its own');
  // Settled: back to the main session.
  evidence.back = harness.forks.back('the tangent is settled');
  const again = send('Create a file named back.txt containing the word back.');
  await until(() => fs.existsSync(file('back.txt')), { label: 'back.txt', timeout: 120000 });
  assert.equal(receivedBy(again)?.fork, undefined, 'after the tangent, requests reach the main session');
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
