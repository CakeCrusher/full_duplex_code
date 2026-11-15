import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// Standby on Jev's word with real GPT Live and real Jev (spends about a minute of voice and a few Jev readings; the
// agent only starts). The quiet window is a minute here, so only Jev's reading can put voice on Standby. In the middle
// of a back-and-forth (the operator gives numbers one at a time), the quiet after each answer is read and voice stays
// on. Then the operator asks it to stand by: once the voice has answered, Jev's reading puts it on Standby within
// seconds. This client is the WebSocket stand-in for the page: it reports speech levels the way the page does.
const first = synthesize('standby-jev-first', "I'm going to give you three numbers, one at a time. After each one, just repeat it back to me and wait for the next. The first number is seven.");
const second = synthesize('standby-jev-second', 'The second number is twelve.');
const bye = synthesize('standby-jev-bye', "Okay, that's all for now. Go on standby until I call you.");
const test = await startTestHarness('standby-jev', { jevKey: process.env.TYPESAFE_API_KEY, tuning: { standbyAfterMs: 60000 } });
const { harness } = test;
const evidence: Record<string, any> = { passed: false };
let voice: Awaited<ReturnType<typeof connectTestVoice>> | undefined;
// The page's level reports: the operator while the test speaks, GPT Live while its audio arrives.
let speaking = false, lastOutput = 0;
const liveEvent = harness.voiceSessions.liveEvent.bind(harness.voiceSessions);
// GPT Live streams audio all the time, silence included: like the page, only sound counts as speech.
const loud = (base64: string) => { const pcm = Buffer.from(base64, 'base64'); let power = 0; for (let i = 0; i + 1 < pcm.length; i += 2) power += (pcm.readInt16LE(i) / 32768) ** 2; return Math.sqrt(power / Math.max(1, pcm.length / 2)) >= .003; };
harness.voiceSessions.liveEvent = ((run: any, event: any) => { if (event.type === 'session.output_audio.delta' && loud(event.delta)) lastOutput = Date.now(); return liveEvent(run, event); }) as typeof harness.voiceSessions.liveEvent;
const levels = setInterval(() => {
  if (speaking) harness.voiceSessions.heard({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008 });
  if (Date.now() - lastOutput < 200) harness.voiceSessions.heard({ at: Date.now(), inputRms: 0, outputRms: .05 } as any);
}, 100);
const lines = (name: string) => { const file = path.join(harness.runDir, name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
const logged = (type: string) => lines('events.jsonl').filter(e => e.type === type);
// Jev's readings of a quiet, as recorded once fdc has acted on them.
const quiets = () => lines('jev.jsonl').filter(c => c.trigger === 'quiet' && c.decision);
const said = (from: number) => voice!.events.slice(from).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
async function speak(fixture: ReturnType<typeof synthesize>) { speaking = true; try { await voice!.speak(fixture); } finally { speaking = false; } }
/** The operator says something, the voice answers, and Jev reads the quiet that follows: its likelihood and what came of it. */
async function exchange(fixture: ReturnType<typeof synthesize>, answer: RegExp, label: string) {
  const before = voice!.events.length, read = quiets().length;
  await speak(fixture);
  await until(() => answer.test(said(before)), { timeout: 30000, label: `the voice's answer to ${label}` });
  await until(() => quiets().length > read, { timeout: 30000, label: `Jev's reading of the quiet after ${label}` });
  const call = quiets().at(-1);
  return { answer: said(before).trim(), standby: Number(call.answers?.standby?.noul), decision: call.decision };
}
try {
  assert.ok(process.env.TYPESAFE_API_KEY, 'Jev decides: TYPESAFE_API_KEY is needed');
  voice = await connectTestVoice(harness);
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'greeting' });
  await delay(4000);
  // In the middle of a back-and-forth: voice stays on.
  evidence.first = await exchange(first, /seven|7/i, 'the first number');
  assert.equal(evidence.first.decision.standby, false, `the operator is in the middle of giving numbers: ${JSON.stringify(evidence.first)}`);
  assert.equal(harness.voiceSessions.standby, undefined);
  await delay(1500);
  evidence.second = await exchange(second, /twelve|12/i, 'the second number');
  assert.equal(evidence.second.decision.standby, false, `still giving numbers: ${JSON.stringify(evidence.second)}`);
  assert.equal(logged('voice.standby').length, 0, 'voice stayed on through the exchange');
  await delay(1500);
  // Asked to stand by: Standby follows the voice's answer within seconds, on Jev's reading, a minute before the window.
  const before = voice.events.length, askedAt = Date.now();
  await speak(bye);
  await until(() => logged('voice.standby').length === 1, { timeout: 25000, label: "Standby on Jev's word" });
  const went = logged('voice.standby')[0];
  evidence.standby = { jev: went.jev, from: went.from, quietMs: went.quietMs, secondsAfterAsking: (went.at - askedAt) / 1000, answer: said(before).trim() };
  assert.ok(went.jev >= went.from && went.afterMs === undefined, `on Jev's reading, not the window: ${JSON.stringify(went)}`);
  evidence.readings = quiets().map(c => ({ standby: Number(c.answers?.standby?.noul), decision: c.decision }));
  evidence.passed = true;
  console.log('\nSTANDBY ON JEV\'S WORD PASSED');
} catch (error) {
  evidence.error = (error as Error).message;
  evidence.readings = quiets().map(c => ({ standby: Number(c.answers?.standby?.noul), decision: c.decision, latest: String(c.state?.latest).slice(-120) }));
  process.exitCode = 1;
} finally {
  clearInterval(levels);
  if (voice) { voice.ws.send(JSON.stringify({ type: 'stop' })); await delay(3000); voice.ws.close(); }
  evidence.billedSeconds = logged('bridge.closed').reduce((sum, e) => sum + (e.usageSeconds ?? 0), 0);
  evidence.estimatedUsd = +(evidence.billedSeconds * 0.05 / 60).toFixed(3);
  evidence.run = harness.runDir;
  console.log(JSON.stringify(evidence, null, 2));
  await test.close();
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
