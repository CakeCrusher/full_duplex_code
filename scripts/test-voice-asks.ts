import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as pty from 'node-pty';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// What reaches the agent is decided once the conversation has gone quiet, from all that was said, the voice's words
// included (the operator's rule, Nov 18), with real voice, real Jev and real Claude Code (spends GPT Live, a few minutes,
// and Jev and Claude's usage). Two moments of the operator's notes of Nov 17 and 18:
// 1. A question only the agent can answer, the operator never saying to send it ("what does the retention file in this
//    project say about March?"): until Nov 18 GPT Live asked to pass it on, said "I'm checking that now", Jev read that
//    as the voice handling it and fdc told the voice to answer by itself ("Whenever I explicitly ask it to send things,
//    this is a very clear sign that it was a failure"). Now it must reach Claude unasked, and the voice must report what
//    the file says.
// 2. The voice getting something made for its own sake: asked to be taught something, it may judge a drawing would help
//    and say what Claude should draw; that goes to Claude, which makes it, and the voice is told when it is done. Its
//    judgment, so the rig records what it chose rather than fail when it chose to explain in words.
// A question asked aside goes to a fork of Claude's session (forks.ts), here in a pseudo-terminal rather than a window.
// The report goes to the run's folder (evidence.json).
const question = synthesize('asks-retention', 'What does the retention file in this project say about the March cohort?');
const what = synthesize('asks-what', 'So what did it find?');
// `visual`: only the second moment, with an operator who says they learn by seeing.
const visual = process.argv[2] === 'visual';
const teach = visual ? synthesize('asks-teach-visual', 'I want to understand how a hash table handles two keys that land in the same bucket. I learn best by seeing things. Teach me the best way you can.')
  : synthesize('asks-teach', 'I want to understand how a hash table handles two keys that land in the same bucket. Teach me the best way you can.');
const options = { jevKey: process.env.TYPESAFE_API_KEY, tuning: { standbyAfterMs: 0 } };
const test = await startTestHarness('voice-asks', options);
const { harness, cwd } = test;
const evidence: Record<string, any> = { passed: false };
fs.writeFileSync(path.join(cwd, 'retention.txt'), 'Retention by cohort\nJanuary: 52 percent\nFebruary: 47 percent\nMarch: 41 percent\n');
const events = () => fs.readFileSync(path.join(harness.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const said = (since: number) => events().filter(e => e.type === 'session.output_transcript.delta' && e.at >= since).map(e => e.delta).join('').replace(/\s+/g, ' ');
const requests = (since: number) => events().filter(e => e.type === 'agent.input' && e.at >= since);
const jobs = (since: number) => events().filter(e => (e.type === 'turn.job' || e.type === 'turn.voice') && e.at >= since);
let voice: Awaited<ReturnType<typeof connectTestVoice>> | undefined, fork: pty.IPty | undefined;
harness.forks.open = script => {
  const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
  fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 120, rows: 35, cwd, env });
  fork.onData(data => fs.appendFileSync(path.join(harness.runDir, 'fork-terminal.log'), data));
  return 'test terminal';
};
try {
  assert.ok(process.env.TYPESAFE_API_KEY, 'Jev decides what goes: TYPESAFE_API_KEY is needed');
  await until(() => harness.observer.state === 'idle', { label: 'the agent ready', timeout: 60000 }); await delay(3000);
  voice = await connectTestVoice(harness);
  await delay(4000); await voice.quiet();

  // 1. The question only Claude can answer.
  if (!visual) {
  const asked = Date.now();
  await voice.speak(question);
  const spokeAt = Date.now();
  const request = await until(() => requests(asked).find(e => /retention/i.test(String(e.text))), { label: 'the question reaching Claude, unasked', timeout: 60000 });
  evidence.question = { sentAfterMs: request.at - spokeAt, voiceMeanwhile: said(asked).slice(0, 400), decisions: jobs(asked).map(e => `${e.type} needs ${e.needsAgent} send ${e.send}${e.reply ? ` | read: ${String(e.reply).slice(0, 160)}` : ''}`) };
  const reported = () => /41/.test(said(request.at)) || /forty[- ]one/i.test(said(request.at));
  const answered = await until(() => events().find(e => e.type === 'agent.text' && e.at > request.at && /41/.test(String(e.text))), { label: "Claude's answer", timeout: 150000 });
  // Told Claude's answer, the voice speaks of it unprompted, as its instructions say; an operator who hears nothing asks.
  evidence.question.reportedUnprompted = await until(reported, { label: 'the voice reporting, unprompted', timeout: 30000 }).then(() => true, () => false);
  if (!evidence.question.reportedUnprompted) { await voice.speak(what); await until(reported, { label: 'the voice reporting what the file says', timeout: 40000 }); }
  evidence.question.answerToReportMs = events().find(e => e.type === 'session.output_transcript.delta' && e.at > answered.at && /41|forty/i.test(String(e.delta)))?.at - answered.at;
  evidence.question.reported = said(request.at).slice(0, 400);
  await voice.quiet(2500, 60000);
  }

  // 2. Taught something: does the voice get a drawing made?
  const files = () => (fs.readdirSync(cwd, { recursive: true }) as string[]).filter(name => !name.startsWith('.git'));
  const before = new Set(files());
  const taught = Date.now();
  await voice.speak(teach);
  await delay(45000);
  const sent = requests(taught);
  evidence.teach = { voice: said(taught).slice(0, 900), requests: sent.map(e => String(e.text).slice(-900)), decisions: jobs(taught).map(e => `${e.type} needs ${e.needsAgent} send ${e.send}${e.reply ? ` | read: ${String(e.reply).slice(0, 200)}` : ''}`) };
  if (sent.length) {
    const made = await until(() => files().filter(name => !before.has(name) && /\.(html|svg)$/.test(name)).at(0), { label: 'Claude making what the voice asked for', timeout: 240000 }).catch(() => undefined);
    evidence.teach.made = made ?? null;
    if (made) { await delay(20000); evidence.teach.after = said(taught).slice(-600); }
  }
  Object.assign(evidence, { passed: true });
  console.log('\nVOICE ASKS PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  evidence.run = harness.runDir;
  evidence.forks = events().filter(e => e.type.startsWith('fork.')).map(e => `${e.type} ${e.why ?? ''}`.trim());
  fs.writeFileSync(path.join(harness.runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await voice?.close().catch(() => {});
  fork?.kill('SIGTERM');
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
