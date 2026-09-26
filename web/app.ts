// The page: wires the bridge client, audio I/O, the WebRTC peer, the page UI,
// the timeline and the sound cues, and runs one voice connection at a time.
import { TimelineView } from './timeline.js';
import { CuePlayer, CueTracker } from './cues.js';
import { BridgeClient, type BridgeEvent } from './bridge-client.js';
import { AudioIO, watchMicrophones, type WorkletMessage } from './audio-io.js';
import { WebRtcPeer } from './webrtc-peer.js';
import { $, notice, showSpeaking, showSpeakingUpdate, showStatus } from './page-ui.js';
import { profile } from './profile.js';

const token = location.hash.slice(1) || sessionStorage.getItem('fd-voice-token');
if (location.hash) { sessionStorage.setItem('fd-voice-token', token!); history.replaceState(null, '', location.pathname); }
const bridge = new BridgeClient(), audio = new AudioIO(), peer = new WebRtcPeer();
let active = false, starting = false, muted = false, currentStatus: BridgeEvent | undefined;
let voiceSessionId: string | null = null;
let generation = 0;
const cues = new CueTracker(), cuePlayer = new CuePlayer();
let replaying = false;
const timeline = new TimelineView();

function handle(event: BridgeEvent) {
  timeline.handle(event);
  const cue = cues.cue(event, { replaying });
  if (cue) cuePlayer.play(cue);
  if (event.type === 'status') {
    currentStatus = event;
    showStatus(event, { active, muted, starting });
  }
  if (event.type === 'agent_status') $('agentState').textContent = event.detail;
  if (event.type === 'history') {
    replaying = true;
    try { for (const item of event.events) handle(item); } finally { replaying = false; }
  }
  if (event.type === 'fault') { notice(event.message); if (starting && !active) { starting = false; releaseAudio(); } }
  if (event.type === 'voice_answer') peer.answer(event.sdp, message => { notice(message); stop(); });
  if (event.type === 'voice_started') {
    voiceSessionId = event.sessionId;
    audio.auditStart(event.sessionId);
    active = true; starting = false; notice('');
    $<HTMLButtonElement>('mute').disabled = false; $<HTMLButtonElement>('stop').disabled = false; $('audioState').textContent = 'Microphone on';
  }
  if (event.type === 'voice_closed') {
    releaseAudio();
    notice(event.reserved === false ? 'Voice did not start. No API connection was opened.' : event.finalized ? `Voice session ended. ${profile.name} is still available in your terminal.` : 'Voice connection ended. Final usage was not confirmed; the last reported usage is saved and may be incomplete.');
  }
}
$<HTMLFormElement>('instruction-form').onsubmit = event => {
  event.preventDefault();
  if (!bridge.open) { $('instruction-status').textContent = 'Reconnect to the companion first.'; return; }
  const text = $<HTMLTextAreaElement>('instruction-text').value.trim();
  if (!text) return;
  if (new TextEncoder().encode(text).length > 440) { $('instruction-status').textContent = 'Please shorten this instruction before appending it.'; return; }
  bridge.send({ type: 'append_instruction', text });
  $('instruction-status').textContent = 'Submitted. Check the instruction status below for confirmation.';
  $<HTMLTextAreaElement>('instruction-text').value = '';
};
watchMicrophones(notice);
function connect() {
  if (!token) { notice('Open the companion link printed by the launcher in your terminal.'); return; }
  bridge.connect(token, {
    onEvent: handle,
    onClose: () => { const cue = cues.end(); if (cue) cuePlayer.play(cue); releaseAudio(); showSpeakingUpdate({ state: 'disconnected' }); $('connection').textContent = 'Disconnected'; $<HTMLButtonElement>('start').disabled = true; notice('The local companion disconnected. Reopen the launcher link to reconnect.'); },
    onError: () => notice('Unable to connect. Another companion tab may already be open.'),
  });
}
// Audit samples and levels measured by the worklet.
function measured(data: WorkletMessage) {
  if (data.type === 'playback' && bridge.open) {
    if (bridge.bufferedAmount > 128000) { notice('The audio audit connection fell behind. Please reconnect.'); stop(); return; }
    bridge.send({ type: 'playback_audio', voiceSessionId: data.sessionId, offsetSamples: data.offsetSamples,
      at: audio.audioEpoch + data.startTime * 1000, pcm: btoa(String.fromCharCode(...new Uint8Array(data.pcm))),
      microphone: data.microphone ? btoa(String.fromCharCode(...new Uint8Array(data.microphone))) : undefined });
  }
  if (data.type === 'level') {
    $<HTMLMeterElement>('level').value = Math.min(1, (data.rawRms ?? data.rms) * 5);
    $('gate-state').textContent = !active ? 'Waiting for Live' : muted ? 'Muted' : data.rms > 0 ? 'Passing audio to Live' : 'Gate closed · sending silence';
    if (bridge.open && active) bridge.send({ type: 'audio_level', at: audio.audioEpoch + data.endTime * 1000, durationMs: data.durationMs, inputRms: data.rms, rawInputRms: data.rawRms, gateThreshold: data.gateThreshold, outputRms: data.outputRms });
  }
}
async function start() {
  if (active || starting) return; starting = true; $<HTMLButtonElement>('start').disabled = true; notice('');
  cuePlayer.unlock(); // Start voice is the user gesture that allows audio cues.
  const attempt = ++generation, current = () => attempt === generation;
  // The input is captured once per voice connection; change it after End voice.
  $<HTMLSelectElement>('microphone-device').disabled = true;
  $<HTMLButtonElement>('stop').disabled = false; $('audioState').textContent = 'Waiting for microphone…';
  try {
    const gate = Number($<HTMLInputElement>('microphone-gate').value);
    const microphone = await audio.open({ deviceId: $<HTMLSelectElement>('microphone-device').value, gate, current, onMessage: measured });
    if (!microphone) return;
    bridge.send({ type: 'microphone_gate', threshold: gate });
    const sdp = await peer.offer(microphone, {
      active: () => active, connected: () => bridge.open,
      sendStats: stats => bridge.send({ type: 'audio_transport', voiceSessionId, at: Date.now(), stats }),
      canPlay: () => audio.running, play: received => audio.play(received),
      fail: message => { notice(message); stop(); },
    });
    if (!current()) return;
    muted = false; $('mute').textContent = 'Mute microphone'; $('mute').setAttribute('aria-pressed', 'false');
    bridge.send({ type: 'start', sdp });
    $<HTMLButtonElement>('stop').disabled = false; $('audioState').textContent = 'Connecting voice…';
  } catch (error) {
    if (!current()) return; releaseAudio();
    const { name, message } = error as Error;
    notice(name === 'NotAllowedError' ? 'Allow microphone access in Chrome, then click Start voice.'
      : ['OverconstrainedError', 'NotFoundError'].includes(name) ? 'The selected microphone is unavailable. Choose another microphone, then click Start voice.'
      : message);
    if (currentStatus) handle(currentStatus);
  }
}
function releaseAudio() {
  voiceSessionId = null;
  if (audio.node && bridge.open) bridge.send({ type: 'audio_stopped' });
  generation++;
  active = false; starting = false; audio.stopCapture();
  peer.close(); audio.release();
  $<HTMLButtonElement>('mute').disabled = true; $<HTMLButtonElement>('stop').disabled = true; $('audioState').textContent = 'Microphone off'; $<HTMLMeterElement>('level').value = 0;
  $('gate-state').textContent = 'Microphone off';
  $<HTMLSelectElement>('microphone-device').disabled = false;
}
function stop() { if (bridge.open) bridge.send({ type: 'stop' }); releaseAudio(); }
$('start').onclick = start; $('stop').onclick = stop;
$<HTMLInputElement>('speaking-level').oninput = e => showSpeaking(Number((e.target as HTMLInputElement).value));
$<HTMLInputElement>('speaking-level').onchange = e => {
  const level = Number((e.target as HTMLInputElement).value);
  if (!bridge.open) return showSpeakingUpdate({ state: 'disconnected', level });
  showSpeakingUpdate({ state: active ? 'pending' : starting ? 'starting' : 'next_session', level });
  bridge.send({ type: 'speaking_level', level });
};
$<HTMLInputElement>('microphone-gate').oninput = e => {
  const threshold = Number((e.target as HTMLInputElement).value);
  $('gate-label').textContent = threshold === 0 ? 'Off' : `${(threshold * 100).toFixed(1)}%`;
  audio.gate(threshold);
};
$<HTMLInputElement>('microphone-gate').onchange = e => { if (bridge.open) bridge.send({ type: 'microphone_gate', threshold: Number((e.target as HTMLInputElement).value) }); };
$('mute').onclick = () => {
  muted = !muted; audio.mute(muted); bridge.send({ type: 'mute', muted });
  $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; $('mute').setAttribute('aria-pressed', String(muted)); $('audioState').textContent = muted ? 'Microphone muted' : 'Microphone on';
};
addEventListener('pagehide', () => { stop(); bridge.close(); });
connect();
