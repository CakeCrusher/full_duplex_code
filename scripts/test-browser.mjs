import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestHarness, synthesize, until, delay } from './test-support.mjs';

const fixture = synthesize('browser-greeting', 'Hello, are you ready to help me with my coding agent?');
const test = await startTestHarness('browser');
let browser, page;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  // An in-browser virtual audio cable: a WAV -> MediaStreamDestination replaces
  // only the unavailable physical microphone. The app's capture worklet, WebRTC
  // transport, GPT Live connection, playback, and captions run unchanged.
  await page.addInitScript(({ wav }) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const input = new AudioContext({ sampleRate: 24000 }); await input.resume();
      const destination = input.createMediaStreamDestination();
      const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
      const source = input.createBufferSource(); source.buffer = await input.decodeAudioData(bytes.buffer);
      source.connect(destination); source.start(input.currentTime + 12);
      window.__virtualMicrophone = { input, source, destination };
      return destination.stream;
    };
  }, { wav: fs.readFileSync(fixture.wav).toString('base64') });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(test.harness.browserUrl);
  await page.getByRole('button', { name: 'Start voice', exact: true }).waitFor();
  await page.screenshot({ path: path.join(test.runDir, 'before.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await until(() => test.harness.live?.state === 'active', { label: 'browser voice startup' });
  await page.waitForFunction(() => document.querySelector('[data-lane=transcript]').textContent.includes('Claude'), { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.timeline-item[data-role=operator]')].some(p => p.textContent.includes('coding agent')), { timeout: 30000 });
  await delay(4000);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Unmute microphone', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: path.join(test.runDir, 'connected.png'), fullPage: true });
  await page.getByRole('button', { name: 'End voice', exact: true }).click();
  await until(() => test.harness.live?.state === 'closed', { label: 'browser finalized voice' });
  assert.equal(test.harness.live.finalEvent?.type, 'session.closed');
  assert.deepEqual(errors, []);
  assert.equal(test.harness.channelReady, true, 'ending voice leaves the headed Claude session running');
  const firstSession = test.harness.live.id;
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await until(() => test.harness.live?.state === 'active' && test.harness.live.id !== firstSession, { label: 'voice restart beside the same Claude session' });
  await delay(6000);
  await page.getByRole('button', { name: 'End voice', exact: true }).click();
  await until(() => test.harness.live?.state === 'closed', { label: 'restarted voice finalized' });
  assert.equal(test.harness.live.finalEvent?.type, 'session.closed');
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify({ passed: true, browser: 'Chrome', virtualMicrophone: 'WAV through Web Audio MediaStreamDestination', actualUserAudioTranscribed: true, audioWorklet: true, greeting: true, mute: true, gracefulClose: true, voiceRestart: true, claudeStillConnected: true, browserErrors: errors }, null, 2));
  console.log('\nBROWSER PASSED');
} catch (error) {
  if (page) { console.error('Browser notice:', await page.locator('#notice').innerText()); await page.screenshot({ path: path.join(test.runDir, 'failure.png'), fullPage: true }); }
  throw error;
} finally { await browser?.close(); await test.close(); }
