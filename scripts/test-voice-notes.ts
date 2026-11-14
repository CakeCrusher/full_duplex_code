import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { claude } from '../src/adapters/claude/index.ts';
import { Harness } from '../src/core/bridge.ts';
import { NoteHotkey } from '../src/core/hotkey.ts';

// Voice notes in a real Chrome, without Claude or OpenAI: a stand-in voice session (two real WebRTC peers, as in
// test-ui-context.ts) receives the page's microphone, so the check hears what the voice would. A note recorded from the
// button, then from the chord, pauses that microphone and comes back as the operator left it; a note while muted stays
// muted after; a note with voice off records on its own. Each is saved with its timing and drawn on the notes track.
declare global { interface Window { measureInput(rms: number): void } }
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-voice-notes-'));
const harness = await new Harness({ agent: claude, root, runDir: dir, cwd: '/Projects/voice-studio', sessionId: randomUUID(), apiKey: 'unused-notes-test-key' }).start();
harness.agentReady = true; harness.observer.status('idle', 'Ready for your next request');
const sounds: string[] = [];
const hotkey = harness.noteHotkey = new NoteHotkey(harness, { sound: name => sounds.push(name), lock: path.join(dir, 'note-chord.lock') });
const heard: { at: number; rms: number }[] = [];
const loudSince = (at: number) => heard.filter(h => h.at > at).some(h => h.rms > .01);
const quietSince = (at: number) => { const after = heard.filter(h => h.at > at); return after.length > 5 && after.every(h => h.rms < .001); };
const notes = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')); } catch { return []; } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => unknown, label: string, ms = 10000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await pause(50)) if (check()) return;
  assert.ok(check(), label);
}
let browser;
const errors: string[] = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  // A loud steady tone as the microphone.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
      const source = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .3;
      const destination = audio.createMediaStreamDestination(); source.connect(gain); gain.connect(destination); source.start();
      return destination.stream;
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(harness.browserUrl);
  // The page's own microphone prompt, answered as the operator would.
  await page.locator('dialog.microphone-gate button').click();
  await page.locator('#note').waitFor();
  assert.equal(await page.locator('[data-lane="notes"]').isVisible(), true, 'the notes track shows');
  // The stand-in voice session, measuring what reaches it.
  const other = await browser.newPage();
  await other.goto(harness.baseUrl + '/');
  await other.exposeFunction('measureInput', (rms: number) => heard.push({ at: Date.now(), rms }));
  harness.startLive = async (sdp: any, voicePage?: any) => {
    harness.voiceSessions.page = voicePage;
    harness.live = { instructions: '', append: async () => {}, id: 'offline-notes', state: 'active', usageSeconds: 0, audio: () => {}, close: async () => {
      harness.live!.state = 'closed'; harness.publish({ type: 'voice_closed', finalized: true }); harness.publish(harness.status());
    } } as any;
    const answer = await other.evaluate(async sdp => {
      const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
      const peer = new RTCPeerConnection(), destination = audio.createMediaStreamDestination(), silent = audio.createGain(); silent.gain.value = 0;
      const source = audio.createOscillator(); source.connect(silent); silent.connect(destination); source.start();
      destination.stream.getTracks().forEach(track => peer.addTrack(track, destination.stream));
      peer.ontrack = event => {
        const stream = new MediaStream([event.track]); const player = new Audio(); player.srcObject = stream; player.muted = true; player.play();
        const meter = audio.createScriptProcessor(2048, 1, 1);
        meter.onaudioprocess = e => { const data = e.inputBuffer.getChannelData(0); window.measureInput(Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length)); };
        audio.createMediaStreamSource(stream).connect(meter); meter.connect(audio.destination);
      };
      await peer.setRemoteDescription({ type: 'offer', sdp }); await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve(); });
      return peer.localDescription!.sdp;
    }, sdp);
    harness.publish({ type: 'voice_answer', sdp: answer });
    harness.publish({ type: 'voice_started', sessionId: 'offline-notes' }); harness.publish(harness.status());
  };
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#audioState')!.textContent === 'Microphone on');
  let mark = Date.now();
  await until(() => loudSince(mark), 'the voice hears the microphone');

  // 1. From the button: the voice hears nothing while the note records, and the microphone comes back after.
  await page.locator('#note').click();
  await page.waitForFunction(() => document.querySelector('#note')!.textContent!.startsWith('Stop note'));
  await page.waitForFunction(() => document.querySelector('#gate-state')!.textContent === 'Paused for your note');
  await pause(400); mark = Date.now(); await pause(1600);
  assert.ok(quietSince(mark), 'the voice hears silence while the note records');
  await until(() => harness.timeline.snapshot().items.some(i => i.track === 'notes' && i.active), 'the note grows on its track');
  await page.locator('#note').click();
  await until(() => notes().length === 1, 'the first note is saved');
  mark = Date.now(); await until(() => loudSince(mark), 'the microphone comes back after the note');
  const [first] = notes();
  const bytes = fs.readFileSync(path.join(dir, first.file));
  assert.ok(first.end - first.start > 1500 && bytes.length > 1000 && bytes.readUInt32BE(0) === 0x1a45dfa3, 'a WebM file of the stretch recorded');
  await page.locator('.timeline-item[data-track="notes"]').first().waitFor();

  // 2. From the chord, held anywhere: it records while held, with a sound at the start and the release.
  hotkey.line('down');
  await page.waitForFunction(() => document.querySelector('#note')!.textContent!.startsWith('Stop note'));
  await pause(1500);
  hotkey.line('up');
  await until(() => notes().length === 2, 'the chord note is saved');
  assert.deepEqual(sounds, ['down', 'up']);
  mark = Date.now(); await until(() => loudSince(mark), 'the microphone comes back after the chord');

  // 3. Muted before the note, muted after it.
  await page.locator('#mute').click();
  await page.locator('#note').click(); await pause(1200); await page.locator('#note').click();
  await until(() => notes().length === 3, 'the note while muted is saved');
  await pause(300); mark = Date.now(); await pause(1200);
  assert.ok(quietSince(mark), 'still muted after the note');
  await page.waitForFunction(() => document.querySelector('#gate-state')!.textContent === 'Muted');
  await page.locator('#mute').click();

  // 4. With voice off, a note records on its own microphone.
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.querySelector('#audioState')!.textContent === 'Microphone off');
  await page.locator('#note').click(); await pause(1200); await page.locator('#note').click();
  await until(() => notes().length === 4, 'the note with voice off is saved');
  assert.equal(await page.locator('.timeline-item[data-track="notes"]').count(), 4);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.type === 'note.saved').length, 4);
  assert.deepEqual(errors, []);
  console.log('VOICE NOTES PASSED', JSON.stringify(notes().map((n: any) => ({ file: n.file, seconds: +((n.end - n.start) / 1000).toFixed(1), bytes: n.bytes }))));
} catch (error) {
  console.error((error as Error).message, errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await harness.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
