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
import { CompanionRegistry } from '../src/core/companions.ts';
import { startTunnel, type Tunnel } from '../src/launcher/tunnel.ts';

// Companion pages in real Chrome, in the orders people open them: before the
// agent is ready, on a second device, moving voice between them, after a
// dropped connection, from an earlier start's link, and after the companion
// stops. The voice connection is a stand-in answered by a helper page; no API spending.
// With --public, the phone uses a real Cloudflare tunnel, opened the moment it is handed out.
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-pages-'));
const harness = new Harness({ agent: claude, root, runDir: dir, cwd: dir, sessionId: randomUUID(), apiKey: 'unused-pages-test-key' });
// Registered apart from the companions really running here, whose tabs would open this one too.
harness.companions = new CompanionRegistry(path.join(dir, 'companions'));
await harness.start();
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
    const page = await (await browser!.newContext({ permissions: ['microphone'] })).newPage();
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
        live.requested = true; live.closeReason ??= reason;
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
  // Which session this is, at the top and in the tab title.
  const folder = path.basename(dir), shortId = harness.sessionId!.slice(0, 8);
  assert.equal(await text(laptop, '#session-name'), folder);
  assert.equal(await text(laptop, '#session-meta'), `Claude Code · session ${shortId} · ${dir}`);
  assert.equal(await laptop.title(), `${folder} · Claude Code · ${shortId} · Full-Duplex Code`);

  // 2. A second device connects too, and both follow the session.
  const phone = await device();
  const response = await phone.goto(phoneUrl);
  assert.equal(response?.status(), 200, 'the phone link works at its first try');
  await waitFor(async () => await text(phone, '#connection') === 'Agent connected', 'the phone connects beside the laptop');
  harness.observer.status('working', 'Working on it');
  await waitFor(async () => await text(laptop, '#agentState') === 'Working' && await text(phone, '#agentState') === 'Working', 'both pages follow the session');
  harness.observer.status('idle', 'Ready');

  // What Jev learned and changed is one table that scrolls, newest first: Remove for an instruction, Revert for a setting change.
  for (const instruction of ['Keep answers under two sentences.', 'Say who is talking.']) await harness.voiceSessions.learn({ text: instruction, scope: 'session', behave: .9, design: .1, lasting: 'this_session' });
  harness.setTuning({ ...harness.tuning, standbyAfterMs: 30000 }, [{ name: 'standbyAfterMs', from: 60000, to: 30000 }]);
  await waitFor(async () => await laptop.locator('#learned tbody tr').count() === 3, 'a row for each instruction and each setting change');
  assert.match((await text(laptop, '#learned tbody tr:first-child'))!, /Setting: standbyAfterMs 60 s → 30 s.*Revert/, 'the newest first, in seconds');
  await laptop.locator('#learned tbody tr:first-child button').click();
  await waitFor(async () => /Reverted/.test((await text(laptop, '#learned tbody tr:first-child'))!), 'Revert puts the setting back and the row says so');
  assert.equal(harness.tuning.standbyAfterMs, 60000);
  await laptop.getByRole('button', { name: 'Remove' }).first().click();
  await waitFor(async () => harness.voiceSessions.additionalInstructions.length === 1 && await laptop.locator('#learned tr.undone').count() === 2, 'Remove takes the instruction out and the row says so');
  for (let i = 1; i <= 12; i++) harness.setTuning({ ...harness.tuning, wakeThreshold: 50 + i }, [{ name: 'wakeThreshold', from: 49 + i, to: 50 + i }]);
  await waitFor(async () => await laptop.locator('#learned tbody tr').count() === 15 && await phone.locator('#learned tbody tr').count() === 15, 'every change is listed, on every page');
  const learnedBox = (await laptop.locator('#learned').boundingBox())!;
  assert.ok(learnedBox.height <= 240, `the list stays contained and scrolls (${learnedBox.height}px high)`);
  // A companion started before it listed what it learned serves this same page from disk: its status names the instructions in force with its prompt only.
  const { learned: _learned, tuningHistory: _history, ...older } = harness.status() as Record<string, any>;
  harness.publish({ ...older, prompt: { ...older.prompt, additional: [{ id: 'x', text: 'I9: Speak slowly.', state: 'acknowledged', learned: 'I9' }] } });
  await waitFor(async () => /Instruction I9: .?Speak slowly\..*Remove/.test((await text(laptop, '#learned-I9')) ?? ''), 'an older companion\'s learned instruction is listed, with Remove');
  harness.publish(harness.status());
  await waitFor(async () => await laptop.locator('#learned tbody tr').count() === 15, 'and this companion\'s own list is back');
  // Back to how the session started, for the rest of the run.
  await harness.removeInstruction('I1');
  harness.setTuning({ ...harness.tuning, wakeThreshold: 50 }, [{ name: 'wakeThreshold', from: 62, to: 50 }]);

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
