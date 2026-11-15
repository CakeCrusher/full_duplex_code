import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// Forks with real voice, real Jev and real Claude Code (spends GPT Live, a few minutes, and Jev and Claude usage). Claude
// works on a long job; the operator, by voice, starts a tangent: Jev's reading opens a fork (in a terminal of its own,
// here a pseudo-terminal), and the request goes to it from the conversation record, "<fork started>" in it. The operator
// then settles it: back to the main session, whose request carries the record since its own last one, the forked
// stretch and "<fork ended>" included. Jev's readings must have read the same tags.
const tangent = synthesize('fork-tangent', 'By the way, totally unrelated to what you are working on, a separate side task: create a file named tangent dot txt containing the word tangent.');
const settled = synthesize('fork-settled', 'Okay, thanks, that settles that. Back to the main work now: when it is done, also create a file named back dot txt containing the word back.');
const test = await startTestHarness('fork-voice', { jevKey: process.env.TYPESAFE_API_KEY, tuning: { standbyAfterMs: 0 } });
const { harness, cwd } = test;
const evidence: Record<string, any> = { passed: false };
const file = (name: string) => path.join(cwd, name);
const events = () => fs.readFileSync(path.join(harness.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
let fork: pty.IPty | undefined, voice: Awaited<ReturnType<typeof connectTestVoice>> | undefined;
harness.forks.open = script => {
  const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
  const term = fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 120, rows: 35, cwd, env });
  let raw = '', confirmed = false;
  term.onData(data => {
    fs.appendFileSync(path.join(harness.runDir, 'fork-terminal.log'), data);
    raw = (raw + data).slice(-40000);
    if (!confirmed && stripVTControlCharacters(raw).replace(/[^A-Za-z]/g, '').includes('Iamusingthisforlocaldevelopment')) {
      confirmed = true; let n = 0; const t = setInterval(() => { if (harness.forks.ready || ++n > 8) clearInterval(t); else term.write('\r'); }, 1000);
    }
  });
  return 'test terminal';
};
try {
  assert.ok(process.env.TYPESAFE_API_KEY, 'Jev decides forks: TYPESAFE_API_KEY is needed');
  // Claude ready, as the operator sees it before typing (a channel message in its first seconds can be lost: noted apart).
  await until(() => harness.observer.state === 'idle', { label: 'Claude ready', timeout: 60000 }); await delay(3000);
  // The main work, typed, as the operator would in Claude's terminal.
  harness.deliver({ id: randomUUID(), content: 'Run the shell command `sleep 150` in the foreground (not in the background), then create a file named slow-done.txt containing the word done. Nothing else.', said: 'typed' });
  await until(() => harness.observer.state === 'working', { label: 'Claude at work', timeout: 60000 });
  voice = await connectTestVoice(harness);
  await delay(4000);
  await voice.speak(tangent);
  await until(() => harness.forks.focus === 'fork', { label: "Jev's reading opening a fork", timeout: 30000 }).catch(error => { evidence.jevTangent = events().filter(e => e.type === 'jev.read').map(e => e.answers?.tangent ?? e.tangent).filter(Boolean); throw error; });
  await until(() => harness.forks.ready, { label: "the fork's channel", timeout: 90000 });
  await until(() => fs.existsSync(file('tangent.txt')), { label: 'the fork made tangent.txt', timeout: 180000 });
  const toFork = events().find(e => e.type === 'agent.input' && e.fork && String(e.text).includes('tangent'));
  evidence.toFork = toFork && String(toFork.text).slice(-900);
  assert.ok(toFork, 'the tangent reached the fork');
  assert.match(String(toFork.text), /<fork started>/, "the fork's request carries the tag from the record");
  assert.equal(fs.existsSync(file('slow-done.txt')), false, 'the main session was still at its long job');
  await delay(3000);
  await voice.speak(settled);
  await until(() => harness.forks.focus === 'main', { label: "Jev's reading settling the tangent", timeout: 30000 });
  await until(() => events().some(e => e.type === 'agent.input' && !e.fork && String(e.text).includes('<fork ended>')), { label: "the main session's catch-up request", timeout: 60000 });
  const toMain = events().find(e => e.type === 'agent.input' && !e.fork && String(e.text).includes('<fork ended>'));
  evidence.toMain = String(toMain.text).slice(-1500);
  assert.match(String(toMain.text), /<fork started>[\s\S]*tangent[\s\S]*<fork ended>/, 'the main session gets the forked stretch, between the tags');
  await until(() => fs.existsSync(file('back.txt')) && fs.existsSync(file('slow-done.txt')), { label: 'back.txt after the long job', timeout: 240000 });
  // Jev read the same record: its reading of the words that settled the tangent had the fork's start in its history
  // (the end is written by that reading's own decision).
  const readings = fs.readFileSync(path.join(harness.runDir, 'jev.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const settling = readings.find(c => c.questions && 'settled' in c.questions);
  assert.match(String(settling?.state?.history), /<fork started>/, "Jev's reading while the fork was open had the tag");
  Object.assign(evidence, { passed: true, files: fs.readdirSync(cwd).filter(f => f.endsWith('.txt')).sort(), forks: events().filter(e => e.type.startsWith('fork.')).map(e => `${e.type} ${e.why ?? ''}`) });
  console.log('\nFORK WITH VOICE PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  evidence.forks = events().filter(e => e.type.startsWith('fork.')).map(e => `${e.type} ${e.why ?? ''}`);
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(evidence, null, 2));
  await voice?.close().catch(() => {});
  fork?.kill('SIGTERM');
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
