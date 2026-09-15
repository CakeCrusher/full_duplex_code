import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { channelNotification } from '../src/channel-message.js';
import { Harness } from '../src/server.js';
import { AudioAudit } from '../src/audio-audit.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-ui-timeline-'));
const artifacts = process.env.FD_UI_ARTIFACTS;
async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(check(), label);
}
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const harness = await new Harness({ root, runDir: dir, cwd: '/Projects/voice-studio', sessionId: randomUUID(), apiKey: 'unused-ui-test-key' }).start();
const now = Date.now(); const base = now - 55000;
harness.timeline.origin = now - 90000; harness.channelReady = true; harness.observer.status('idle', 'Ready for your next request');
const publish = event => harness.publish(event);
function audio(track, from, to) {
  for (let at = from; at <= to; at += 100) publish({ type: 'audio_level', at: base + at, durationMs: 100, inputRms: track === 'operator' ? .12 : 0, outputRms: track === 'speech' ? .16 : 0 });
  publish({ type: 'audio_stopped', at: base + to });
}
audio('operator', 1000, 6500); audio('speech', 4800, 9000);
audio('operator', 18000, 21500); audio('speech', 19000, 23000); audio('speech', 29500, 31500);
for (const [role, startMs, endMs, text] of [
  ['operator', 1000, 6500, 'Ask Claude to add a dark-mode toggle.'],
  ['intermediary', 4800, 9000, 'I’ll pass that along. You can keep talking while Claude works.'],
  ['operator', 18000, 21500, 'What changed in the settings file?'],
  ['intermediary', 19000, 23000, 'The selected theme is now saved between visits.'],
  ['intermediary', 29500, 31500, 'The toggle is ready, and all three tests passed.'],
]) publish({ type: 'caption', voiceSessionId: 'fixture', voiceStartedAt: base, role, startMs, endMs, text, at: base + endMs + 400 });
const requestContent = 'User request (transcribed speech):\nAdd a dark-mode toggle named “夜”.\n\nEarlier voice conversation for reference only:\nintermediary: The theme lives in settings.\n';
const notification = channelNotification({ id: 'request-one', content: requestContent });
for (const [at, state] of [[7500, 'queued'], [9000, 'sent']]) publish({ type: 'task', id: 'request-one', queuedAt: base + 7500, at: base + at, state, text: requestContent, notification });
const observedPrompt = `<channel source="voice" message_id="request-one">\n${requestContent}\n</channel>`;
publish({ type: 'agent_input', at: base + 9500, text: observedPrompt });
for (const [at, index, text, final] of [
  [10500, 0, 'I’ll add the toggle and persist the selected theme.', false],
  [14000, 1, 'Updated the settings component.', false],
  [20800, 2, 'The theme preference now persists across visits.', false],
  [28500, 3, 'All three tests passed. The dark-mode toggle is ready.', true],
]) publish({ type: 'agent_observation', name: 'MessageDisplay', at: base + at, text });
publish({ type: 'agent_observation', name: 'PostToolUse', text: JSON.stringify({tool_name:'Bash',tool_response:'all tests pass'}), at:base+32000 });
const contextWire={type:'session.thinking.append',event_id:'thinking-one',content:'Exact thinking data'};
publish({type:'context_sent',at:base+32100,id:'thinking-one',kind:'thinking',text:contextWire.content,notification:contextWire});
publish({type:'context_ack',at:base+33000,id:'thinking-one',startMs:32100,endMs:32500});
publish({ type: 'agent_input', at: base + 35000, text: 'Also let the toggle follow the system theme.' });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1150 }, reducedMotion: 'reduce' });
  // Exercise the real audio worklet with a virtual microphone, without Claude
  // or OpenAI: synthesized tone in, actual PCM playback out.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
      const source = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .15;
      const destination = audio.createMediaStreamDestination(); source.connect(gain); gain.connect(destination); source.start();
      window.__virtualAudio = { audio, source, destination }; return destination.stream;
    };
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(harness.browserUrl);
  await page.locator('.timeline-item[data-track="operator"]').first().waitFor();
  for (const track of ['operator', 'speech', 'transcript', 'claude', 'context', 'requests']) assert.ok(await page.locator(`.timeline-item[data-track="${track}"]`).count() > 0, track);
  assert.equal(await page.locator('.timeline-item[data-track="requests"]').count(), 2, 'voice prompt does not duplicate delivery');
  await page.locator('.timeline-item[data-track="requests"][data-state="observed"]').first().click();
  assert.equal(await page.locator('#detail-text').textContent(), requestContent);
  assert.deepEqual(JSON.parse(await page.locator('#detail-json').textContent()), notification);
  assert.equal(await page.locator('#detail-observed-text').textContent(), observedPrompt);
  assert.match(await page.locator('#detail-verification').textContent(), /Verified/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: harness.baseUrl });
  await page.locator('#detail-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), requestContent);
  assert.equal(await page.locator('#detail-copy').textContent(), 'Copied');
  await page.locator('#detail-payload summary').click();
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'request-inspector.png'), fullPage: true });
  await page.locator('.timeline-item[data-track="context"]').click();
  assert.deepEqual(JSON.parse(await page.locator('#detail-json').textContent()), contextWire);
  await page.locator('#detail-clear').click();
  const batch = page.locator('.timeline-item[data-track="claude"]').nth(3);
  await batch.hover();
  await page.locator('#timeline-tooltip').waitFor();
  assert.match(await page.locator('#tooltip-text').textContent(), /All three tests passed/);
  await batch.click();
  assert.equal(await page.locator('#timeline-live').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#detail-text').textContent(), /All three tests passed/);
  assert.match(await page.locator('#detail-source').textContent(), /Complete Claude observation/);
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'timeline-desktop.png'), fullPage: true });
  publish({ type: 'agent_observation', name: 'FileChanged', text: 'A new hook arrived while reviewing.' });
  await page.locator('#timeline-live').click();
  await page.getByRole('button', { name: /Claude hooks\. FileChanged/ }).waitFor();
  await page.locator('#timeline-zoom').selectOption('15000');
  await page.locator('#timeline-back').click();
  assert.equal(await page.locator('#timeline-live').getAttribute('aria-pressed'), 'false');
  await page.locator('#timeline-scrub').fill('0');
  await page.locator('#timeline-zoom').selectOption('60000');
  await page.locator('#timeline-live').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page fits');
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'timeline-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1150 });
  let inputBytes = 0;
  harness.startLive = async () => {
    harness.audit = new AudioAudit({ dir: path.join(dir,'audio'), log:harness.log, onError:error=>errors.push(error.message) });
    harness.live = { id: 'offline-audio', state: 'active', usageSeconds: 0, audio: buffer => { inputBytes += buffer.length; }, close: async () => {
      harness.live.state = 'closed'; publish({ type: 'voice_closed', finalized: true }); publish(harness.status());
    } };
    publish({ type: 'voice_started', sessionId: 'offline-audio' }); publish(harness.status());
  };
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#audioState').textContent === 'Microphone on');
  await waitFor(() => inputBytes > 0, 'real worklet sent microphone PCM');
  const playback = new Int16Array(12000);
  for (let i = 0; i < playback.length; i++) playback[i] = Math.sin(i / 24000 * Math.PI * 2 * 440) * 8000;
  harness.audit.write('output',Buffer.from(playback.buffer));
  harness.browser.send(Buffer.from(playback.buffer));
  await waitFor(() => harness.timeline.snapshot().items.some(i => i.track === 'speech' && i.start > now), 'real rendered playback reached the chart');
  const measured = harness.timeline.snapshot().items.filter(i => i.start > now);
  assert.ok(measured.some(i => i.track === 'operator'), 'actual microphone measurement reached chart');
  assert.ok(measured.some(i => i.track === 'speech'), 'actual rendered playback reached chart');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await waitFor(() => harness.timeline.audio.get('operator')?.active === false, 'muted microphone activity ended');
  await new Promise(resolve=>setTimeout(resolve,700));
  await page.getByRole('button', { name: 'End voice', exact: true }).click();
  await new Promise(resolve=>setTimeout(resolve,100));
  const recorded = fs.readFileSync(path.join(dir,'audio','playback.wav')).subarray(44);
  const nonzero = bytes => [...new Int16Array(bytes.buffer,bytes.byteOffset,bytes.length/2)].filter(x=>x!==0);
  assert.deepEqual(nonzero(recorded),nonzero(Buffer.from(playback.buffer)), 'rendered recording retains every audible sample in order');
  assert.ok(fs.existsSync(path.join(dir,'timeline.json')), 'Gantt saved to disk');
  await page.reload();
  await page.getByRole('button', { name: /Claude hooks\. FileChanged/ }).waitFor();
  assert.ok(await page.locator('.timeline-item[data-track="speech"]').count() >= 1, 'audio history survives reload');
  assert.deepEqual(errors, []);
  console.log('Timeline tracks, hover/pin, zoom/history, live updates, reload, virtual microphone, playback and mute passed. No API spending.');
} finally { await browser?.close(); await harness.close(); fs.rmSync(dir, { recursive: true, force: true }); }
