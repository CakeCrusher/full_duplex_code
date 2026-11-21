import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { startCodexTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// A fork's answer that comes while voice is on Standby, with real voice, real Jev and real Codex (spends GPT Live, under a
// minute billed, a few Jev readings, and two short Codex turns at low effort). The main session works on a long job; the
// operator, by voice, asks aside, in a fork, what a slow script prints. Jev opens a fork; the conversation goes quiet and
// voice goes on Standby, on Jev's reading of the quiet or after the quiet window. The fork's answer wakes voice, and it
// tells the operator what the script printed: the woken voice is told the fork's answer, then that it is back to the main
// session (forks.ts, heard). Until Nov 20 it was told only the main session's work, and the answer never reached it.
// A question asked aside, a fork named: "run it and tell me" alone is work, which goes to the main session (fork rule).
const aside = synthesize('fork-standby-aside', 'By the way, a quick question while that runs, in a fork: what does the script slow dot sh print when you run it?');
const test = await startCodexTestHarness('fork-standby-voice', { jevKey: process.env.TYPESAFE_API_KEY, args: ['--no-alt-screen', '-s', 'workspace-write', '-a', 'never', '-c', 'model_reasoning_effort="low"'] });
const { harness, cwd } = test;
const evidence: Record<string, any> = { passed: false, standbyAfterMs: harness.tuning.standbyAfterMs, standbyFrom: harness.tuning.standbyFrom };
// It sleeps a minute before printing a word it decodes, for an answer after Standby even when Standby waits out the quiet
// window. A fork may skip the sleep (Nov 20 it ran only the last line): the check holds only if Standby came first, and
// says it was inconclusive otherwise.
fs.writeFileSync(path.join(cwd, 'slow.sh'), "#!/bin/sh\nsleep 60\necho \"The code word is $(printf '%s' 'bmFjaWxlcA==' | base64 -d | rev).\"\n", { mode: 0o755 });
const events = () => fs.readFileSync(path.join(harness.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const logged = (type: string) => events().filter(e => e.type === type);
const answered = () => events().find(e => e.type === 'agent.text' && e.fork && /pelican/i.test(String(e.text)));
let fork: pty.IPty | undefined, voice: Awaited<ReturnType<typeof connectTestVoice>> | undefined;
// The fork in a terminal of its own instead of a window, where nothing is typed.
harness.forks.open = script => {
  const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  const term = fork = pty.spawn('/bin/sh', [script], { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
  term.onData(data => fs.appendFileSync(path.join(harness.runDir, 'fork-terminal.log'), data));
  return 'test terminal';
};
// The page's level reports (as test-standby-voice.ts): the operator while the test speaks, GPT Live while its audio arrives.
let speaking = false, lastOutput = 0;
const liveEvent = harness.voiceSessions.liveEvent.bind(harness.voiceSessions);
const loud = (base64: string) => { const pcm = Buffer.from(base64, 'base64'); let power = 0; for (let i = 0; i + 1 < pcm.length; i += 2) power += (pcm.readInt16LE(i) / 32768) ** 2; return Math.sqrt(power / Math.max(1, pcm.length / 2)) >= .003; };
harness.voiceSessions.liveEvent = ((run: any, event: any) => { if (event.type === 'session.output_audio.delta' && loud(event.delta)) lastOutput = Date.now(); return liveEvent(run, event); }) as typeof harness.voiceSessions.liveEvent;
const levels = setInterval(() => {
  if (speaking) harness.voiceSessions.heard({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008 });
  if (Date.now() - lastOutput < 200) harness.voiceSessions.heard({ at: Date.now(), inputRms: 0, outputRms: .05 } as any);
}, 100);
// The page answers a wake by reconnecting on the same microphone.
const answerWakes = setInterval(() => {
  const wake = voice?.events.findLast(e => e.type === 'voice_wake');
  if (wake && !wake.answered) { wake.answered = true; voice!.ws.send(JSON.stringify({ type: 'start', mode: 'resume', automatic: true })); }
}, 100);
const said = (from: number) => voice!.events.slice(from).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
let askedAt = 0;
const after = (at?: number) => at === undefined ? undefined : Math.round((at - askedAt) / 100) / 10;
try {
  assert.ok(process.env.TYPESAFE_API_KEY, 'Jev decides forks and Standby: TYPESAFE_API_KEY is needed');
  assert.ok(harness.tuning.standbyAfterMs > 0, 'Standby is on');
  await until(() => harness.observer.state === 'idle', { label: 'Codex ready', timeout: 60000 }); await delay(3000);
  // The main work, typed, as the operator would in Codex's terminal.
  harness.deliver({ id: randomUUID(), content: 'Run the shell command `sleep 200` in the foreground (not in the background), then create a file named slow-done.txt containing the word done. Nothing else.', said: 'typed' });
  await until(() => harness.observer.state === 'working', { label: 'the main session at work', timeout: 60000 });
  voice = await connectTestVoice(harness);
  // Its greeting, if any, heard out: its caption can come before its audio.
  await until(() => lastOutput > 0, { label: 'greeting', timeout: 10000 }).catch(() => {});
  await until(() => Date.now() - lastOutput > 1500, { label: 'the greeting to end', timeout: 20000 });
  speaking = true; try { await voice.speak(aside); } finally { speaking = false; }
  askedAt = Date.now();
  await until(() => harness.forks.focus === 'fork', { label: "Jev's reading opening a fork", timeout: 40000 });
  const toFork = await until(() => events().find(e => e.type === 'agent.input' && e.fork && /slow/i.test(String(e.text))), { label: 'the question reaching the fork', timeout: 120000 });
  // While the script runs, nobody speaks: Standby, the fork still at work.
  const standby = await until(() => logged('voice.standby')[0], { label: 'Standby while the fork works', timeout: 120000 });
  const early = answered();
  assert.ok(!early || early.at > standby.at, 'inconclusive: the fork answered before Standby, while voice was Live');
  const answer = await until(answered, { label: "the fork's answer", timeout: 240000 });
  const back = await until(() => logged('fork.back')[0], { label: 'back to the main session', timeout: 30000 });
  const waking = await until(() => logged('voice.waking')[0], { label: "the fork's answer waking voice", timeout: 30000 });
  assert.notEqual(waking.reason, 'operator', "the agent's news woke it, not speech");
  const woke = await until(() => logged('voice.woke')[0], { label: 'voice back', timeout: 60000 });
  const from = voice.events.findLastIndex(e => e.type === 'voice_wake');
  const spoken = await until(() => { const text = said(from); return /pelican/i.test(text) && voice!.events.findLast(e => e.type === 'caption' && e.role === 'intermediary'); }, { label: 'the voice telling the operator the code word', timeout: 45000 });
  await voice.quiet(1500, 30000);
  // What the woken voice was told: the fork's answer, then the way back to the main session, then the cue to report it.
  const told = events().filter(e => e.direction === 'sent' && e.at >= waking.at && /^session\.(thinking|commentary)\.append$/.test(e.type));
  const text = told.map(e => String(e.content ?? '')).join('\n\n'), word = text.search(/pelican/i), ended = text.indexOf('<fork ended>');
  assert.ok(word >= 0, 'the woken voice is told the fork\'s answer');
  assert.ok(ended > word, 'then that it is back to the main session');
  assert.equal(told.at(-1)?.type, 'session.commentary.append', 'and last the cue to report the news');
  const started = logged('voice.started').at(-1);
  Object.assign(evidence, {
    passed: true,
    timeline: { forkOpened: after(logged('fork.opened')[0]?.at), forkAsked: after(toFork.at), standby: after(standby.at), standbyHow: { jev: standby.jev, afterMs: standby.afterMs }, answer: after(answer.at), back: after(back.at), backWhy: back.why, waking: after(waking.at), wakeReason: waking.reason, woke: after(woke.at), plan: started?.plan, startMs: started?.startMs, codeWordSpoken: after(spoken.at) },
    forkAnswer: String(answer.text).slice(0, 300),
    told: told.map(e => `${e.type}: ${String(e.content ?? '').replace(/\s+/g, ' ').slice(0, 240)}`),
    voiceSaid: said(from).trim(),
  });
  console.log('\nFORK ANSWER ON STANDBY PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  clearInterval(levels); clearInterval(answerWakes);
  evidence.forks = (() => { try { return events().filter(e => e.type.startsWith('fork.') || /^voice\.(standby|waking|woke|started)$/.test(e.type)).map(e => `${after(e.at)} ${e.type} ${e.why ?? e.reason ?? e.plan ?? ''}`.trim()); } catch { return undefined; } })();
  await voice?.close().catch(() => {});
  // Every session's usage, once each has closed: GPT Live bills a session at least 15 s.
  await until(() => { try { return logged('bridge.closed').length >= logged('voice.started').length; } catch { return true; } }, { label: 'every voice session closed', timeout: 10000 }).catch(() => {});
  evidence.billedSeconds = (() => { try { return logged('bridge.closed').reduce((sum, e) => sum + Math.max(15, e.usageSeconds ?? 0), 0); } catch { return undefined; } })();
  evidence.estimatedUsd = evidence.billedSeconds === undefined ? undefined : Math.round(evidence.billedSeconds * 0.05 / 60 * 100) / 100;
  evidence.run = harness.runDir;
  fs.writeFileSync(path.join(harness.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  fork?.kill('SIGTERM');
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
