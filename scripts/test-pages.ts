import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, type Page as BrowserPage } from 'playwright';
import { claude } from '../src/adapters/claude/index.ts';
import { Harness } from '../src/core/bridge.ts';
import { startTunnel, type Tunnel } from '../src/launcher/tunnel.ts';

// Companion pages in real Chrome, in the orders people open them: before the
// agent is ready, on a second device, moving voice between them, after a
// dropped connection, from an earlier start's link, and after the companion
// stops. The voice connection is a stand-in answered by a helper page; no API spending.
// With --public, the phone uses a real Cloudflare tunnel, opened the moment it is handed out.
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-pages-'));
const harness = await new Harness({ agent: claude, root, runDir: dir, cwd: dir, sessionId: randomUUID(), apiKey: 'unused-pages-test-key' }).start();
let tunnel: Tunnel | undefined;
if (process.argv.includes('--public')) {
  tunnel = await startTunnel({ port: new URL(harness.baseUrl).port, log: line => harness.log({ type: 'tunnel.log', line }), onAddress: url => harness.setPublicUrl(url) });
  console.log('Tunnel:', tunnel.url);
}
const phoneUrl = harness.publicBrowserUrl ?? harness.browserUrl;
const logged = (type: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === type);
async function waitFor(check: () => unknown | Promise<unknown>, label: string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(await check(), label);
}
const text = (page: BrowserPage, selector: string) => page.locator(selector).textContent();

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  // Each device is its own browser context, with a quiet virtual microphone.
  const device = async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
        const source = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .004;
        const destination = audio.createMediaStreamDestination(); source.connect(gain); gain.connect(destination); source.start();
        return destination.stream;
      };
    });
    return page;
  };
  // Stands in for OpenAI's side of WebRTC, one answering peer per offer.
  const remote = await browser.newPage();
  await remote.goto(harness.baseUrl + '/');
  const answer = (sdp: string) => remote.evaluate(async sdp => {
    const peer = new RTCPeerConnection();
    const audio = new AudioContext({ sampleRate: 24000 }); const destination = audio.createMediaStreamDestination();
    const source = audio.createOscillator(); source.connect(destination); source.start();
    destination.stream.getTracks().forEach(track => peer.addTrack(track, destination.stream));
    await peer.setRemoteDescription({ type: 'offer', sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => { peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve(); }; });
    return peer.localDescription!.sdp;
  }, sdp);
  const lives: any[] = [];
  harness.voiceSessions.createLive = () => {
    const live: any = Object.assign(new EventEmitter(), { state: 'new', reservation: `pages-${lives.length}`, transport: 'webrtc', usageSeconds: 0, closedFor: undefined as string | undefined });
    Object.assign(live, {
      async start(sdp: string) {
        live.emit('answer', await answer(sdp)); live.state = 'active'; live.id = `voice-${lives.length}`;
        live.emit('event', { type: 'session.started' });
        // The microphone as the API would report it, so voice stays up.
        live.heard = setInterval(() => live.emit('event', { type: 'session.input_audio.append', audio: Buffer.alloc(480).toString('base64') }), 500);
      },
      async greet() {}, async append() {}, audio() {},
      close(reason: string) {
        clearInterval(live.heard);
        if (live.state !== 'closed') { live.closedFor = reason; live.state = 'closed'; live.emit('closed', { finalized: true, reserved: true, usageSeconds: 1, sessionId: live.id }); }
        return Promise.resolve();
      },
    });
    lives.push(live); return live;
  };

  // 1. A page opened before the agent is ready waits for it.
  const laptop = await device();
  await laptop.goto(harness.browserUrl);
  await waitFor(async () => await text(laptop, '#connection') === 'Waiting for Claude', 'the laptop page waits for Claude');
  assert.equal(await laptop.locator('#start').isEnabled(), false);
  harness.agentReady = true; harness.publish(harness.status());
  await waitFor(async () => await text(laptop, '#connection') === 'Agent connected' && await laptop.locator('#start').isEnabled(), 'Start voice once Claude is ready');

  // 2. A second device connects too, and both follow the session.
  const phone = await device();
  const response = await phone.goto(phoneUrl);
  assert.equal(response?.status(), 200, 'the phone link works at its first try');
  await waitFor(async () => await text(phone, '#connection') === 'Agent connected', 'the phone connects beside the laptop');
  harness.observer.status('working', 'Working on it');
  await waitFor(async () => await text(laptop, '#agentState') === 'Working' && await text(phone, '#agentState') === 'Working', 'both pages follow the session');
  harness.observer.status('idle', 'Ready');

  // 3. Voice runs in one page; the other can move it.
  await laptop.getByRole('button', { name: 'Start voice' }).click();
  await waitFor(async () => await text(laptop, '#connection') === 'Listening', 'voice runs on the laptop');
  await waitFor(async () => await text(phone, '#connection') === 'Voice is on in another tab or device' && await text(phone, '#start') === 'Move voice here' && await phone.locator('#start').isEnabled(), 'the phone offers to move voice');
  await phone.getByRole('button', { name: 'Move voice here' }).click();
  await waitFor(async () => await text(phone, '#connection') === 'Listening', 'voice moved to the phone');
  await waitFor(async () => (await text(laptop, '#notice'))!.startsWith('Voice moved to another tab or device') && await text(laptop, '#start') === 'Move voice here', 'the laptop is told, and can move it back');
  assert.equal(lives[0].closedFor, 'voice moved to another page');
  assert.equal(logged('voice.moved').length, 1);

  // 4. A dropped connection reconnects by itself; voice on that page ends.
  const phoneSocket = [...harness.pages.all.values()].find(page => page.id === harness.voiceSessions.page?.id)!.ws;
  phoneSocket.terminate();
  await waitFor(async () => (await text(phone, '#notice'))!.includes('ended voice. Reconnecting'), 'the phone says the drop ended voice');
  await waitFor(() => lives[1].closedFor === 'voice client disconnected', 'the bridge ended voice with the page');
  await waitFor(async () => await text(phone, '#connection') === 'Agent connected' && harness.pages.size === 2 && (await text(phone, '#notice'))!.startsWith('Reconnected. Voice ended'), 'the phone reconnected by itself', 15000)
    .catch(async error => { console.log({ connection: await text(phone, '#connection'), notice: await text(phone, '#notice'), pages: harness.pages.size }); throw error; });

  // 5. A link from an earlier start says so instead of retrying.
  const stale = await device();
  await stale.goto(`${harness.baseUrl}/#${'0'.repeat(64)}`);
  await waitFor(async () => (await text(stale, '#notice'))!.startsWith('This link is from an earlier start') && await text(stale, '#connection') === 'Not connected', 'an old link is recognized');
  assert.ok(logged('page.refused').some(e => e.reason === 'token'));

  // 6. When the companion stops, pages keep trying and say why.
  await harness.close();
  await waitFor(async () => (await text(laptop, '#notice'))!.startsWith("Can't reach the companion"), 'the laptop explains the companion is gone', 15000);
  console.log('Pages before the agent, on two devices, moving voice, reconnecting, an old link and a stopped companion passed. No API spending.');
} finally { await browser?.close(); await harness.close(); await tunnel?.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
