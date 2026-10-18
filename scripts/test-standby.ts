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
// speaking wakes it, and what was said before the new connection was up still reaches the other
// end, ahead of the live microphone. GPT Live is a stand-in peer in a helper page that measures
// what it hears; no API spending.
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
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  // A virtual microphone whose loudness the test sets: quiet room noise below the gate, or speech.
  await page.addInitScript(() => {
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
  const lives: any[] = [];
  harness.voiceSessions.createLive = () => {
    const live: any = Object.assign(new EventEmitter(), { state: 'new', reservation: `standby-${lives.length}`, transport: 'webrtc', usageSeconds: 0, appended: [] as string[] });
    Object.assign(live, {
      async start(sdp: string) {
        live.emit('answer', await answer(sdp)); live.state = 'active'; live.id = `voice-${lives.length}`; live.startedAt = Date.now();
        live.emit('event', { type: 'session.started' });
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

  // 2. Speaking wakes it; the speech from before the new connection still arrives, ahead of the live microphone.
  const spokeAt = Date.now();
  await page.evaluate(() => (window as any).speak(true));
  await new Promise(resolve => setTimeout(resolve, 1500));
  await page.evaluate(() => (window as any).speak(false));
  await waitFor(async () => await text('#connection') === 'Listening', 'speech woke voice');
  const woke = logged('voice.started').at(-1);
  assert.equal(woke.wake, 'operator'); assert.equal(woke.plan, 'fresh', 'no conversation yet: a fresh session, never a fork');
  await new Promise(resolve => setTimeout(resolve, 4000));
  // Like any background context, the note waits for the operator to finish speaking.
  assert.ok(lives[1].appended.some((t: string) => /The operator has started speaking/.test(t)) && !lives[1].greeting, 'told the conversation continues, not greeted');
  const heard: [number, number][] = await remote.evaluate(() => (window as any).heard);
  const loud = heard.filter(([at, rms]) => at > spokeAt && rms > .05);
  const speechSeconds = loud.length * .02;
  const connectedAt = logged('voice.started').at(-1).at;
  console.log({ spokeFor: 1.5, wokeAfter: ((connectedAt - spokeAt) / 1000).toFixed(2), heardSpeechSeconds: speechSeconds.toFixed(2) });
  assert.ok(speechSeconds > 1.2, `the other end heard nearly all 1.5 s of speech, including what was said before it connected (${speechSeconds.toFixed(2)} s)`);

  // 3. Quiet again: Standby again. Ending voice there turns voice off.
  await waitFor(async () => await text('#connection') === 'Standby · speak to wake it', 'quiet again: Standby', 12000);
  await page.getByRole('button', { name: 'End voice' }).click();
  await waitFor(() => logged('voice.standby_ended').length === 1 && !harness.status().standby, 'ending voice on Standby turns it off');
  await waitFor(async () => await text('#start') === 'Resume voice' || await text('#start') === 'Start voice', 'the page offers to start voice again');
  console.log('Standby in Chrome: quiet goes on Standby, speech wakes it with the held speech replayed, ending voice there turns it off. No API spending.');
} finally { await browser?.close(); await harness.close(); fs.rmSync(dir, { recursive: true, force: true }); }
