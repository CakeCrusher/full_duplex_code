import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// Standby with real Claude and real GPT Live (spends API credits; about 3 minutes of voice):
// a slow task lets voice go quiet and on Standby; Claude finishing wakes it, and GPT Live reports
// without greeting or mentioning the pause; quiet again, then the operator speaking wakes it and
// GPT Live answers from the conversation. This client is the WebSocket stand-in for the page: it
// reports speech levels the way the page does (the page's held audio is checked by test:standby).
const ask = synthesize('standby-ask', 'Ask Claude to create a file named notes dot text containing the word hello, then run sleep 30, then reply done.');
const question = synthesize('standby-question', 'What file did Claude create, and what is in it?');
const test = await startTestHarness('standby-voice', { tuning: { standbyAfterMs: 15000, wakeThreshold: 10 } });
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
const logged = (type: string) => fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === type);
const said = (from: number) => voice!.events.slice(from).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
async function speak(fixture: ReturnType<typeof synthesize>) { speaking = true; try { await voice!.speak(fixture); } finally { speaking = false; } }
// The page answers a wake by reconnecting on the same microphone.
const answerWakes = setInterval(() => {
  const wake = voice?.events.findLast(e => e.type === 'voice_wake');
  if (wake && !wake.answered) { wake.answered = true; voice!.ws.send(JSON.stringify({ type: 'start', mode: 'resume', automatic: true })); }
}, 100);
try {
  voice = await connectTestVoice(harness);
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'greeting' });
  await delay(4000);
  await speak(ask);
  await until(() => fs.existsSync(path.join(test.cwd, 'notes.txt')), { timeout: 60000, label: 'Claude creates notes.txt' });
  // While Claude sleeps, nobody speaks: Standby.
  await until(() => logged('voice.standby').length === 1, { timeout: 60000, label: 'Standby while Claude works' });
  const pausedAt = voice.events.length;
  console.log('\nSTANDBY');
  // Claude finishing wakes it; GPT Live reports without a greeting.
  await until(() => logged('voice.woke').length === 1, { timeout: 90000, label: 'Claude finishing wakes voice' });
  const newsWake = logged('voice.waking')[0];
  console.log('\nWOKE for', newsWake.reason);
  await until(() => /\bdone\b|finish|notes|creat|hello|slept|sleep/i.test(said(pausedAt)), { timeout: 30000, label: 'GPT Live reports the result' });
  await delay(6000);
  const report = said(pausedAt);
  evidence.newsWake = { reason: newsWake.reason, report };
  assert.ok(!/\b(i'?m back|welcome back|hello again|hi again|reconnect|paused|standby)\b/i.test(report), `no greeting or talk of the pause: ${report}`);
  // Quiet again, then the operator speaks: it wakes and answers from the conversation.
  await until(() => logged('voice.standby').length === 2, { timeout: 60000, label: 'Standby again' });
  console.log('\nSTANDBY AGAIN');
  speaking = true; await delay(1000); speaking = false;
  await until(() => logged('voice.woke').length === 2, { timeout: 30000, label: 'speech wakes voice' });
  const speechWake = logged('voice.waking')[1];
  assert.equal(speechWake.reason, 'operator');
  const before = voice.events.length, requests = harness.outbox.size;
  await speak(question);
  await until(() => /notes/i.test(said(before)) && /hello/i.test(said(before)), { timeout: 30000, label: 'GPT Live answers from the conversation' });
  await delay(3000);
  evidence.speechWake = { answer: said(before), newRequests: harness.outbox.size - requests };
  evidence.starts = logged('voice.started').map(e => ({ plan: e.plan, startMs: e.startMs, wake: e.wake }));
  evidence.passed = true;
  console.log('\nSTANDBY VOICE PASSED', JSON.stringify(evidence, null, 2));
} catch (error) { evidence.error = (error as Error).message; throw error; }
finally {
  clearInterval(levels); clearInterval(answerWakes);
  if (voice) { voice.ws.send(JSON.stringify({ type: 'stop' })); await delay(3000); voice.ws.close(); }
  evidence.billedSeconds = logged('bridge.closed').reduce((sum, e) => sum + (e.usageSeconds ?? 0), 0);
  evidence.estimatedUsd = evidence.billedSeconds * 0.05 / 60;
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  console.log(`\nBilled ${evidence.billedSeconds} s of voice, about $${evidence.estimatedUsd.toFixed(2)}.`);
  await test.close();
  process.exit(evidence.passed ? 0 : 1);
}
