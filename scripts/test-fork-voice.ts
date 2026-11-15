import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// Forks with real voice, real Jev and real Claude Code (spends GPT Live, a few minutes, and Jev and Claude usage). Claude
// works on a long job; the operator, by voice, turns aside to ask something only the agent can answer (what a file in
// the project says): Jev's reading of the words, as they are sent, opens a fork (in a terminal of its own, here a
// pseudo-terminal), and the request goes to it from the conversation record, "<fork started>" in it; the fork answers
// while the main session works on. The operator then closes the matter and asks for work: back to the main session,
// whose request carries the record since its own last one, the forked stretch and "<fork ended>" included, and the
// fork is left behind. Jev's readings must have read the same tags.
const aside = synthesize('fork-aside', 'By the way, a quick question while that runs: what is the code word written in the file named secret dot txt? Just tell me what it says.');
const moved = synthesize('fork-moved', 'Okay, got it, thanks. Now back to the main work: when it is done, also create a file named back dot txt containing the word back.');
const test = await startTestHarness('fork-voice', { jevKey: process.env.TYPESAFE_API_KEY, tuning: { standbyAfterMs: 0 } });
const { harness, cwd } = test;
const evidence: Record<string, any> = { passed: false };
const file = (name: string) => path.join(cwd, name);
fs.writeFileSync(file('secret.txt'), 'The code word is heron.\n');
const events = () => fs.readFileSync(path.join(harness.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const readings = () => fs.existsSync(path.join(harness.runDir, 'jev.jsonl')) ? fs.readFileSync(path.join(harness.runDir, 'jev.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const scores = (name: string) => readings().filter(c => c.answers?.[name]).map(c => `${c.trigger} ${Number(c.answers[name].noul).toFixed(2)}${c.decision?.fork ? ` (${c.decision.fork})` : ''}`);
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
  await voice.speak(aside);
  await until(() => harness.forks.focus === 'fork', { label: "Jev's reading opening a fork as the question is sent", timeout: 40000 });
  await until(() => harness.forks.ready, { label: "the fork's channel", timeout: 90000 });
  const toFork = await until(() => events().find(e => e.type === 'agent.input' && e.fork && /secret/i.test(String(e.text))), { label: 'the question reaching the fork', timeout: 60000 });
  evidence.toFork = String(toFork.text).slice(-700);
  assert.match(String(toFork.text), /<fork started>/, "the fork's request carries the tag from the record");
  const answer = await until(() => events().find(e => e.type === 'agent.text' && e.fork && /heron/i.test(String(e.text))), { label: "the fork's answer", timeout: 180000 });
  evidence.answer = String(answer.text).slice(0, 300);
  assert.equal(fs.existsSync(file('slow-done.txt')), false, 'the main session was still at its long job');
  await until(() => !harness.forks.busy, { label: "the fork's turn ending", timeout: 60000 });
  await delay(6000);
  await voice.speak(moved);
  await until(() => harness.forks.focus === 'main', { label: "Jev's reading moving back to the main session", timeout: 40000 });
  assert.equal(harness.forks.adapter, undefined, 'the fork is left behind');
  const toMain = await until(() => events().find(e => e.type === 'agent.input' && !e.fork && String(e.text).includes('<fork ended>')), { label: "the main session's request", timeout: 60000 });
  evidence.toMain = String(toMain.text).slice(-1500);
  assert.match(String(toMain.text), /<fork started>[\s\S]*secret[\s\S]*<fork ended>[\s\S]*back/i, 'the main session gets the forked stretch between the tags, then the new words');
  await until(() => fs.existsSync(file('back.txt')) && fs.existsSync(file('slow-done.txt')), { label: 'back.txt after the long job', timeout: 240000 });
  // Jev read the same record: its reading of the words that left the fork had the fork's start in its history.
  const leaving = readings().find(c => c.questions && 'settled' in c.questions && c.decision?.fork === 'back') ?? readings().find(c => c.questions && 'settled' in c.questions);
  assert.match(String(leaving?.state?.history), /<fork started>/, "Jev's reading while the fork was open had the tag");
  Object.assign(evidence, { passed: true, files: fs.readdirSync(cwd).filter(f => f.endsWith('.txt')).sort() });
  console.log('\nFORK WITH VOICE PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  Object.assign(evidence, { forks: events().filter(e => e.type.startsWith('fork.')).map(e => `${e.type} ${e.why ?? ''}`.trim()), jevFork: scores('tangent'), jevBack: scores('settled'), run: harness.runDir });
  console.log(JSON.stringify(evidence, null, 2));
  await voice?.close().catch(() => {});
  fork?.kill('SIGTERM');
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
