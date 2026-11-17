import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { claude } from '../src/adapters/claude/index.ts';
import { Harness } from '../src/core/bridge.ts';
import { CompanionRegistry } from '../src/core/companions.ts';

// Standby in real Chrome: voice that stays quiet disconnects and the page keeps its microphone;
// speaking wakes it, resuming the paused session (a fork, which can take many seconds to start), and
// what was said before and while it started still reaches the other end, ahead of the live microphone,
// with the waking sound until it has; a fork that never starts gives way to a new session on the same
// microphone. What is said on Standby and while voice wakes is in the audit's microphone track, as the microphone had it.
// And the page's audio device stopping for a couple of seconds, again and again, leaves the bridge hearing as before:
// the page keeps its audio clock on the wall clock (on Nov 16 it ended 6 s behind, and every level was refused).
// GPT Live is a stand-in peer in a helper page that measures what it hears; no API spending.
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-standby-'));
const harness = new Harness({ agent: claude, root, runDir: dir, cwd: dir, sessionId: randomUUID(), apiKey: 'unused-standby-test-key', tuning: { standbyAfterMs: 3000, wakeThreshold: 10 } });
// Registered apart from the companions really running here, whose tabs would open this one too.
harness.companions = new CompanionRegistry(path.join(dir, 'companions'));
await harness.start();
harness.agentReady = true;
const logged = (type: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === type);
async function waitFor(check: () => unknown | Promise<unknown>, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(await check(), label);
}

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  // A virtual microphone whose loudness the test sets: quiet room noise below the gate, or speech. And the page's
  // sounds, as the notes it starts (the virtual microphone's own 330 Hz tone aside).
  await page.addInitScript(() => {
    // The page's own audio context (the one it asks low latency of), for the test to stop as a stalled audio device does.
    const Native = window.AudioContext;
    window.AudioContext = class extends Native { constructor(options?: AudioContextOptions) { super(options); if (options?.latencyHint === 'interactive') (window as any).pageAudio = this; } };
    const start = OscillatorNode.prototype.start, tones: [number, number][] = (window as any).tones = [];
    OscillatorNode.prototype.start = function (...args: any[]) { if (this.frequency.value !== 330) tones.push([Date.now(), this.frequency.value]); return start.apply(this, args as any); };
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
      const source = audio.createOscillator(); source.frequency.value = 330; const gain = audio.createGain(); gain.gain.value = .004;
      const destination = audio.createMediaStreamDestination(); source.connect(gain); gain.connect(destination); source.start();
      (window as any).speak = (on: boolean) => { gain.gain.value = on ? .3 : .004; };
      return destination.stream;
    };
  });
  // Stands in for OpenAI's side of WebRTC: answers each offer and measures what it hears, 20 ms at a time.
  const remote = await browser.newPage();
  await remote.goto(harness.baseUrl + '/');
  await remote.evaluate(() => { (window as any).heard = []; });
  const answer = (sdp: string) => remote.evaluate(async sdp => {
    const peer = new RTCPeerConnection();
    const audio = new AudioContext({ sampleRate: 24000 }); const destination = audio.createMediaStreamDestination();
    destination.stream.getTracks().forEach(track => peer.addTrack(track, destination.stream));
    peer.ontrack = event => {
      const analyser = audio.createAnalyser(); analyser.fftSize = 512;
      audio.createMediaStreamSource(new MediaStream([event.track])).connect(analyser);
      // A muted element starts Chrome's playout of the received track.
      const element = new Audio(); element.srcObject = new MediaStream([event.track]); element.muted = true; element.play();
      const samples = new Float32Array(512);
      setInterval(() => { analyser.getFloatTimeDomainData(samples); let power = 0; for (const x of samples) power += x * x; (window as any).heard.push([Date.now(), Math.sqrt(power / samples.length)]); }, 20);
    };
    await peer.setRemoteDescription({ type: 'offer', sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => { peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve(); }; });
    return peer.localDescription!.sdp;
  }, sdp);
  // Stand-in sessions, stored as OpenAI's are, so a wake resumes the paused one: its fork can be slow to start, or never start.
  const lives: any[] = [], fork = { startMs: 0, never: false };
  harness.voiceSessions.createLive = (options: any) => {
    const live: any = Object.assign(new EventEmitter(), { state: 'new', reservation: `standby-${lives.length}`, transport: 'webrtc', usageSeconds: 0, appended: [] as string[], options });
    Object.assign(live, {
      async start(sdp: string) {
        live.state = 'connecting'; live.emit('answer', await answer(sdp)); live.answered = true;
        if (options.fork && fork.never) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          live.state = 'closed'; live.emit('closed', { finalized: false, reserved: true, usageSeconds: 0, reason: 'session startup timed out' });
          throw new Error('session startup timed out');
        }
        if (options.fork) await new Promise(resolve => setTimeout(resolve, fork.startMs));
        live.state = 'active'; live.id = `voice-${lives.indexOf(live)}`; live.startedAt = Date.now(); live.stored = true;
        live.emit('event', { type: 'session.started', session: { id: live.id } });
        live.heard = setInterval(() => live.emit('event', { type: 'session.input_audio.append', audio: Buffer.alloc(480).toString('base64') }), 500);
      },
      async greet(text: string) { live.greeting = text; }, async append(_kind: string, text: string) { live.appended.push(text); }, audio() {},
      close(reason: string) {
        live.requested = true; live.closeReason ??= reason; clearInterval(live.heard);
        if (live.state !== 'closed') { live.state = 'closed'; setImmediate(() => live.emit('closed', { finalized: true, reserved: true, usageSeconds: 1, sessionId: live.id, reason })); }
        return Promise.resolve();
      },
    });
    lives.push(live); return live;
  };
  const text = (selector: string) => page.locator(selector).textContent();
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const speak = async (ms: number) => { await page.evaluate(() => (window as any).speak(true)); await sleep(ms); await page.evaluate(() => (window as any).speak(false)); };
  // What the other end heard after a moment: loud 20 ms windows, in seconds, and when the last one came.
  const heardSince = async (since: number) => { const loud = (await remote.evaluate(() => (window as any).heard) as [number, number][]).filter(([at, rms]) => at > since && rms > .05); return { seconds: loud.length * .02, lastAt: loud.at(-1)?.[0] ?? 0 }; };
  const tonesSince = async (since: number) => (await page.evaluate(() => (window as any).tones) as [number, number][]).filter(([at]) => at >= since);
  // How much speech a session's microphone track holds (the audit, audio-audit.ts): loud 20 ms windows, in seconds.
  const recorded = (session: number) => {
    const file = path.join(dir, 'audio', `standby-${session}`, 'microphone.wav');
    if (!fs.existsSync(file)) return 0;
    const pcm = fs.readFileSync(file).subarray(44); let loud = 0;
    for (let i = 0; i + 960 <= pcm.length; i += 960) { let power = 0; for (let j = i; j < i + 960; j += 2) power += (pcm.readInt16LE(j) / 32768) ** 2; if (Math.sqrt(power / 480) > .05) loud++; }
    return loud * .02;
  };

  // 1. Voice starts; with nobody speaking for the window, it goes on Standby and the page keeps listening.
  await page.goto(harness.browserUrl);
  await waitFor(async () => await page.locator('#start').isEnabled(), 'Start voice once Claude is ready');
  await page.getByRole('button', { name: 'Start voice' }).click();
  await waitFor(async () => await text('#connection') === 'Listening', 'voice is on');
  await waitFor(async () => await text('#connection') === 'Standby · speak to wake it', 'quiet: Standby', 12000);
  assert.equal(lives[0].closeReason, 'Standby: the conversation was quiet');
  assert.equal(await text('#start'), 'Wake now');
  assert.equal(await text('#usage'), 'Standby · not billed');
  await waitFor(() => page.locator('.standby-band').count(), 'the timeline shows Standby as a band');
  assert.equal(lives.length, 1, 'room noise below the gate does not wake it');

  // 2. Speaking wakes it, resuming the paused session, whose fork takes 6 s to start: the operator speaks before it
  // and again while it starts, and all of it reaches the other end. The waking sound (the start cue's first note, then
  // softly again) plays until the held words are out; then the start cue.
  // (A quiet of more than 5 s first: all of what the page keeps to record ahead of a sound.)
  fork.startMs = 6000;
  await sleep(5500);
  const spokeAt = Date.now();
  await speak(1500);
  await waitFor(() => logged('voice.waking').length === 1, 'speech wakes voice', 5000);
  const wokeAt = logged('voice.waking')[0].at;
  await sleep(1500); await speak(1500);
  await waitFor(async () => await text('#connection') === 'Listening', 'the resumed session started', 15000);
  const woke = logged('voice.started').at(-1);
  assert.equal(woke.wake, 'operator'); assert.equal(woke.plan, 'fork', 'the paused session resumes');
  assert.ok(woke.startMs >= 6000, `it took ${woke.startMs} ms to start`);
  assert.ok(!lives[1].greeting && !lives[1].appended.length, 'not greeted; nothing added');
  await sleep(5000);
  const held = await heardSince(spokeAt), tones = await tonesSince(wokeAt - 500);
  const startCue = tones.find(([, frequency]) => frequency === 990)?.[0];
  console.log({ forkStartedAfter: woke.startMs / 1000, spokeFor: 3, heardSpeechSeconds: held.seconds.toFixed(2), wakingNotes: tones.filter(([at, f]) => f === 660 && at < (startCue ?? Infinity)).length, startCueAfterLastHeldWordMs: startCue && startCue - held.lastAt });
  assert.ok(held.seconds > 2.6, `the other end heard nearly all 3 s of speech, before and while the fork started (${held.seconds.toFixed(2)} s)`);
  assert.ok(tones[0]?.[1] === 660 && tones[0][0] - wokeAt < 1000, 'the waking sound starts as voice wakes');
  assert.ok(tones.filter(([at, f]) => f === 660 && at < woke.at).length >= 6, 'and goes on while the session starts');
  assert.ok(startCue && startCue >= held.lastAt - 300, 'the start cue sounds once the held words are out');
  // The audit has those words as the microphone had them, in the track of the session that went on Standby: nobody
  // spoke while it was connected, so all the speech in it was said on Standby and while the fork started.
  const onStandby = recorded(0);
  console.log({ recordedOnStandbySeconds: onStandby.toFixed(2), gaps: logged('audio.audit_gap').filter(e => e.reason === 'standby_quiet').length });
  assert.ok(onStandby > 2.6, `the first session's microphone track goes on through its Standby and holds nearly all 3 s said there (${onStandby.toFixed(2)} s)`);
  assert.ok(recorded(1) < .3, "and the next session's own track starts after them");

  assert.equal(logged('audio.audit_paused').length, 0, 'what led up to the words went out without the page taking it for a backlog and dropping some');

  // 3. The audio device stops four times while the operator talks, 1.8 s each: the page's audio clock stands still with
  // it, 7 s behind by the end. The page fits it again each time, the bridge goes on hearing them (voice stays on while
  // they talk, well past the window), and the stops are on record.
  fork.startMs = 0;
  await waitFor(async () => await text('#connection') === 'Standby · speak to wake it', 'quiet again: Standby', 12000);
  await page.evaluate(() => (window as any).speak(true));
  await waitFor(async () => await text('#connection') === 'Listening', 'their voice wakes it again', 15000);
  const standbys = logged('voice.standby').length, connected = lives.length - 1;
  for (let i = 0; i < 4; i++) {
    await page.evaluate(async () => { const audio: AudioContext = (window as any).pageAudio; await audio.suspend(); await new Promise(resolve => setTimeout(resolve, 1800)); await audio.resume(); });
    await sleep(1500);
  }
  await sleep(5000);
  const fitted = logged('audio.clock_fitted').filter(e => e.movedMs > 1000), behind = fitted.reduce((sum, e) => sum + e.movedMs, 0);
  const lastLevel = logged('audio_level').at(-1);
  console.log({ audioDeviceStops: 4, clockFitted: fitted.map(e => e.movedMs), lastLevelOffByMs: Math.round(Date.now() - lastLevel.at), standbysMeanwhile: logged('voice.standby').length - standbys });
  assert.equal(await text('#connection'), 'Listening', 'voice stays on while the operator talks');
  assert.equal(logged('voice.standby').length, standbys, 'no Standby meanwhile');
  assert.ok(fitted.length === 4 && behind > 6500 && behind < 9500, `each stop is fitted and on record (${fitted.map(e => e.movedMs)})`);
  assert.ok(Date.now() - lastLevel.at < 1000 && !('pageAt' in lastLevel), "the page's levels carry the right time again");
  await page.evaluate(() => (window as any).speak(false));

  // 4. Quiet again, then a wake whose fork never starts: the page starts again on the same microphone, and the words
  // said meanwhile still arrive, in a new session.
  await waitFor(async () => await text('#connection') === 'Standby · speak to wake it', 'quiet again: Standby', 12000);
  fork.never = true;
  const spokeAgainAt = Date.now(), recordedBefore = recorded(connected);
  await speak(1500);
  await waitFor(() => logged('voice.fork_never_started').length === 1, 'the fork never starts', 15000);
  await waitFor(async () => await text('#connection') === 'Listening', 'a new session started instead', 15000);
  const fallback = logged('voice.started').at(-1);
  assert.notEqual(fallback.plan, 'fork', 'not another fork');
  assert.equal(logged('audio_stopped').length, 0, 'the page kept its microphone throughout');
  await sleep(3000);
  const again = await heardSince(spokeAgainAt);
  console.log({ fallbackPlan: fallback.plan, startedAfter: fallback.startMs / 1000, heardSpeechSeconds: again.seconds.toFixed(2) });
  assert.ok(again.seconds > 1.2, `the other end heard nearly all 1.5 s of speech said before the failed fork (${again.seconds.toFixed(2)} s)`);
  assert.ok(recorded(connected) - recordedBefore > 1.2, `recorded too, in the track of the session that was on Standby (${(recorded(connected) - recordedBefore).toFixed(2)} s)`);

  // 5. Quiet again: Standby again. Ending voice there turns voice off.
  await waitFor(async () => await text('#connection') === 'Standby · speak to wake it', 'quiet again: Standby', 12000);
  await page.getByRole('button', { name: 'End voice' }).click();
  await waitFor(() => logged('voice.standby_ended').length === 1 && !harness.status().standby, 'ending voice on Standby turns it off');
  await waitFor(async () => await text('#start') === 'Resume voice' || await text('#start') === 'Start voice', 'the page offers to start voice again');
  console.log('Standby in Chrome: quiet goes on Standby; speech wakes it, resuming the paused session even when its fork is slow, with the held speech replayed and the waking sound until it is; a fork that never starts gives way to a new session on the same microphone; an audio device that keeps stopping leaves the bridge hearing; ending voice there turns it off. No API spending.');
} finally { await browser?.close(); await harness.close(); fs.rmSync(dir, { recursive: true, force: true }); }
