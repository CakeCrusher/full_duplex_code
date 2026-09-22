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
import { liveInstructions } from '../src/live.js';
import { Budget } from '../src/budget.js';

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
  // or OpenAI: two actual WebRTC peers, with synthesized audio in both directions.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__microphoneConstraints = constraints;
      const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
      const source = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .004;
      const destination = audio.createMediaStreamDestination(); source.connect(gain); gain.connect(destination); source.start();
      window.__virtualAudio = { audio, source, gain, destination }; return destination.stream;
    };
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(harness.browserUrl);
  await page.locator('.timeline-item[data-track="operator"]').first().waitFor();
  assert.equal(await page.locator('#prompt-instructions').textContent(), liveInstructions(2));
  assert.match(await page.locator('#prompt-state').textContent(), /startup preview/);
  await page.locator('#live-prompt > summary').click();
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'prompt-panel.png'), fullPage: true });
  await page.locator('#live-prompt > summary').click();
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
  assert.match(await page.locator('#detail-source').textContent(), /Complete observation/);
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
  // Exercise the real rejected-start path before replacing Live with the
  // offline audio fixture. The temporary ledger lock prevents API connections.
  harness.budget = new Budget(path.join(dir, 'budget.json'));
  harness.budget.reserve(36000, 'usage tracking fixture');
  fs.writeFileSync(`${harness.budget.file}.lock`, '');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: 'Start voice', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Usage ledger locked'));
    assert.equal(await page.locator('#audioState').textContent(), 'Microphone off');
    assert.equal(await page.locator('#start').isEnabled(), true);
    assert.equal(harness.live.state, 'closed');
    assert.equal(harness.live.ws, undefined);
    assert.equal(await page.evaluate(() => window.__virtualAudio.destination.stream.getTracks().every(track => track.readyState === 'ended')), true);
    await page.evaluate(() => window.__virtualAudio.audio.close());
  }
  fs.unlinkSync(`${harness.budget.file}.lock`);
  assert.match(await page.locator('#budget').textContent(), /Estimated total \$30\.00/);
  const inputFrames = [];
  const other = await browser.newPage();
  await other.goto(harness.baseUrl + '/');
  await other.exposeFunction('measureInput', rms => inputFrames.push(rms));
  harness.startLive = async sdp => {
    harness.audit = new AudioAudit({ dir: path.join(dir,'audio'), log:harness.log, onError:error=>errors.push(error.message) });
    harness.live = { instructions:liveInstructions(harness.speakingLevel), append:(kind,text)=>{harness.__preference={kind,text};return new Promise(resolve=>{harness.__ackPreference=resolve;});}, id: 'offline-audio', state: 'active', usageSeconds: 0, audio: () => { throw new Error('Browser sent microphone through the control socket'); }, close: async () => {
      harness.live.state = 'closed'; publish({ type: 'voice_closed', finalized: true }); publish(harness.status());
    } };
    const answer = await other.evaluate(async sdp => {
      const audio = new AudioContext({sampleRate:24000}); await audio.resume();
      const peer = new RTCPeerConnection();
      const destination = audio.createMediaStreamDestination();
      const source = audio.createOscillator(); source.frequency.value = 440;
      const gain = audio.createGain(); gain.gain.value = 0;
      source.connect(gain); gain.connect(destination); source.start();
      destination.stream.getTracks().forEach(track => peer.addTrack(track,destination.stream));
      peer.ontrack = event => {
        const stream = new MediaStream([event.track]);
        const player=window.__receiverPlayer=new Audio();player.srcObject=stream;player.muted=true;player.play();
        const remote = audio.createMediaStreamSource(stream);
        const meter = audio.createScriptProcessor(2048,1,1);
        meter.onaudioprocess = e => {
          const data=e.inputBuffer.getChannelData(0);
          window.measureInput(Math.sqrt(data.reduce((sum,v)=>sum+v*v,0)/data.length));
        };
        remote.connect(meter); meter.connect(audio.destination);
      };
      await peer.setRemoteDescription({type:'offer',sdp});
      await peer.setLocalDescription(await peer.createAnswer());
      if(peer.iceGatheringState!=='complete')await new Promise(resolve=>peer.onicegatheringstatechange=()=>{if(peer.iceGatheringState==='complete')resolve()});
      window.__remote={audio,peer,gain};
      return peer.localDescription.sdp;
    },sdp);
    publish({type:'voice_answer',sdp:answer});
    harness.speakingUpdate = { state: 'acknowledged' , level: harness.speakingLevel, confirmedLevel: harness.speakingLevel, source: 'startup' };
    publish({ type: 'voice_started', sessionId: 'offline-audio' }); publish(harness.status());
  };
  await page.locator('#speaking-level').fill('0');
  await page.locator('#speaking-level').dispatchEvent('input');
  await page.locator('#speaking-level').dispatchEvent('change');
  await waitFor(()=>harness.speakingLevel===0,'Quiet preference received');
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#audioState').textContent === 'Microphone on');
  await waitFor(() => inputFrames.length > 3, 'remote peer received real gated microphone audio');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.ok(inputFrames.every(rms => rms < 0.00001), 'quiet virtual whisper is zeroed before the server sees it');
  assert.ok(!harness.timeline.snapshot().items.some(i => i.track === 'operator' && i.start > now), 'blocked whisper makes no operator bar');
  assert.match(await page.locator('#gate-state').textContent(), /Gate closed/);
  assert.equal(await page.evaluate(() => window.__microphoneConstraints.audio.autoGainControl), false);
  assert.match(await page.locator('#updates-state').textContent(), /Active from session start.*Quiet/);
  await page.locator('#speaking-level').fill('1');
  await page.locator('#speaking-level').dispatchEvent('input');
  await page.locator('#speaking-level').dispatchEvent('change');
  await waitFor(()=>harness.__preference?.text.includes('Milestones:'),'live preference sent');
  await page.waitForFunction(() => document.querySelector('#updates-state').textContent.includes('Applying'));
  assert.equal(harness.status().speakingUpdate.state, 'pending', 'no false confirmation while the API has not acknowledged');
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'preference-pending.png'), fullPage: true });
  harness.__ackPreference();
  await page.waitForFunction(() => document.querySelector('#updates-state').textContent.includes('Live acknowledged'));
  await page.waitForFunction(() => document.querySelector('#prompt-preference').textContent.includes('Milestones:'));
  assert.equal(await page.locator('#prompt-instructions').textContent(), harness.live.instructions, 'startup prompt stays exact after the preference changes');
  assert.equal(harness.live.instructions, liveInstructions(0), 'this connection started with Quiet');
  assert.equal(await page.locator('#prompt-preference').textContent(), harness.__preference.text, 'selected preference matches the actual instruction append');
  assert.match(await page.locator('#prompt-state').textContent(), /Current voice session/);
  await page.locator('#live-prompt').evaluate(element => { element.open = true; });
  const extraInstruction = 'Explain technical terms with a simple example.';
  await page.locator('#instruction-text').fill(extraInstruction);
  await page.locator('#instruction-append').click();
  await waitFor(() => harness.__preference?.text === extraInstruction, 'additional instruction sent');
  assert.equal(harness.__preference.kind, 'instructions');
  await page.waitForFunction(() => document.querySelector('#instruction-history').textContent.includes('Applying'));
  assert.equal(await page.locator('#instruction-history pre').textContent(), extraInstruction);
  harness.__ackPreference();
  await page.waitForFunction(() => document.querySelector('#instruction-history').textContent.includes('Live acknowledged'));
  assert.equal(await page.locator('#prompt-instructions').textContent(), harness.live.instructions, 'additional instruction does not rewrite the startup audit');
  await page.locator('#microphone-gate').fill('0.001');
  await page.locator('#microphone-gate').dispatchEvent('input');
  await page.locator('#microphone-gate').dispatchEvent('change');
  await waitFor(() => inputFrames.at(-1) > .0005, 'lower gate passes the same virtual whisper').catch(async error => { console.log({inputFrames:inputFrames.slice(-10),gate:await page.locator('#gate-state').textContent(),rtc:await other.evaluate(async()=>Array.from((await window.__remote.peer.getStats()).values()).filter(s=>s.type==='inbound-rtp'))}); throw error; });
  await waitFor(() => harness.timeline.snapshot().items.some(i => i.track === 'operator' && i.start > now), 'accepted whisper appears on Gantt');
  await page.waitForFunction(() => document.querySelector('#gate-state').textContent.includes('Passing audio'));
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'whisper-passing.png'), fullPage: true });
  await page.locator('#microphone-gate').fill('0.02');
  await page.locator('#microphone-gate').dispatchEvent('input');
  await page.locator('#microphone-gate').dispatchEvent('change');
  await waitFor(()=>fs.existsSync(path.join(dir,'audio','microphone.wav')),'pre-gate microphone recording exists');
  await waitFor(() => inputFrames.at(-1) < .00001, 'raising the gate blocks the whisper again');
  await waitFor(() => harness.timeline.audio.get('operator')?.active === false, 'operator bar ends after the gate closes');
  await page.waitForFunction(() => document.querySelector('#gate-state').textContent.includes('Gate closed'));
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'whisper-blocked.png'), fullPage: true });
  await page.evaluate(() => { window.__virtualAudio.gain.gain.value = .15; });
  await waitFor(() => inputFrames.at(-1) > .0005, 'normal voice crosses the higher gate');
  await other.evaluate(() => {
    const {gain,audio}=window.__remote;
    gain.gain.setValueAtTime(.244,audio.currentTime);
    gain.gain.setValueAtTime(0,audio.currentTime+.5);
  });
  await waitFor(() => harness.timeline.snapshot().items.some(i => i.track === 'speech' && i.start > now), 'native playback reached the chart');
  const measured = harness.timeline.snapshot().items.filter(i => i.start > now);
  assert.ok(measured.some(i => i.track === 'operator'), 'actual microphone measurement reached chart');
  assert.ok(measured.some(i => i.track === 'speech'), 'actual rendered playback reached chart');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await waitFor(() => harness.timeline.audio.get('operator')?.active === false, 'muted microphone activity ended');
  const transportEvents = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'audio.transport');
  await waitFor(() => transportEvents().some(e => e.voiceSessionId === 'offline-audio' && e.stats.clockRate === 48000 && e.stats.packetsReceived > 0), 'native receiver diagnostics are saved for this voice connection');
  await new Promise(resolve=>setTimeout(resolve,700));
  await page.getByRole('button', { name: 'End voice', exact: true }).click();
  await new Promise(resolve=>setTimeout(resolve,100));
  const stoppedTransportCount = transportEvents().length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(transportEvents().length, stoppedTransportCount, 'receiver diagnostics end with the voice connection');
  const recorded = fs.readFileSync(path.join(dir,'audio','playback.wav')).subarray(44);
  const samples = new Int16Array(recorded.buffer,recorded.byteOffset,recorded.length/2);
  const audible = [...samples].filter(x=>Math.abs(x)>300).length/24000;
  assert.ok(audible > .45 && audible < .6, `native playback preserved the half-second tone (${audible}s)`);
  assert.ok(fs.existsSync(path.join(dir,'timeline.json')), 'Gantt saved to disk');
  await page.reload();
  await page.getByRole('button', { name: /Claude hooks\. FileChanged/ }).waitFor();
  assert.equal(await page.locator('#prompt-instructions').textContent(), harness.live.instructions);
  assert.match(await page.locator('#prompt-state').textContent(), /Last voice session/);
  assert.ok(await page.locator('.timeline-item[data-track="speech"]').count() >= 1, 'audio history survives reload');
  assert.deepEqual(errors, []);
  console.log('Timeline, preference acknowledgment, virtual whisper gate, native WebRTC playback, mute and reload passed. No API spending.');
} finally { await browser?.close(); await harness.close(); fs.rmSync(dir, { recursive: true, force: true }); }
