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
// This page's identity on the bridge, and its connection: it reconnects by itself.
let pageId: string | null = null, connections = 0, attempts = 0, leaving = false, voiceDropped = false;
let retry: ReturnType<typeof setTimeout> | undefined;
const cues = new CueTracker(), cuePlayer = new CuePlayer();
let replaying = false;
const timeline = new TimelineView();

function handle(event: BridgeEvent) {
  timeline.handle(event);
  const cue = cues.cue(event, { replaying });
  if (cue) cuePlayer.play(cue);
  if (event.type === 'page') pageId = event.id;
  if (event.type === 'status') {
    currentStatus = event;
    showStatus(event, { active, muted, starting, elsewhere: Boolean(event.voicePage) && event.voicePage !== pageId });
  }
  if (event.type === 'agent_status') $('agentState').textContent = event.detail;
  if (event.type === 'history') {
    replaying = true;
    try { for (const item of event.events) handle(item); } finally { replaying = false; }
  }
  // After a reconnect, the replayed history is not news.
  if (event.type === 'fault') { if (!(replaying && connections > 1)) notice(event.message); if (starting && !active) { starting = false; releaseAudio(); } }
  if (event.type === 'voice_answer') peer.answer(event.sdp, message => { notice(message); stop(); });
  if (event.type === 'voice_started') {
    voiceSessionId = event.sessionId;
    audio.auditStart(event.sessionId);
    active = true; starting = false; notice('');
    $<HTMLButtonElement>('mute').disabled = false; $<HTMLButtonElement>('stop').disabled = false; $('audioState').textContent = 'Microphone on';
  }
  if (event.type === 'voice_closed') {
    releaseAudio();
    notice(event.moved ? 'Voice moved to another tab or device. Click Move voice here to bring it back.' : event.reserved === false ? 'Voice did not start. No API connection was opened.' : event.finalized ? `Voice session ended. ${profile.name} is still available in your terminal.` : 'Voice connection ended. Final usage was not confirmed; the last reported usage is saved and may be incomplete.');
  }
}
$<HTMLFormElement>('instruction-form').onsubmit = event => {
  event.preventDefault();
  if (!bridge.open) { $('instruction-status').textContent = 'Not connected to the companion; try again once it reconnects.'; return; }
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
  clearTimeout(retry);
  bridge.connect(token, {
    onOpen: () => {
      connections++; attempts = 0;
      if (voiceDropped) notice('Reconnected. Voice ended when the connection dropped; click Start voice to start it again.');
      else if (connections > 1) notice('');
      voiceDropped = false;
    },
    onEvent: handle,
    onClose: disconnected,
  });
}
function disconnected() {
  const cue = cues.end(); if (cue) cuePlayer.play(cue);
  const hadVoice = active || starting;
  releaseAudio(); pageId = null;
  showSpeakingUpdate({ state: 'disconnected' });
  $('connection').textContent = 'Reconnecting…'; $<HTMLButtonElement>('start').disabled = true;
  if (leaving) return;
  if (hadVoice) { voiceDropped = true; notice('The connection to the companion dropped, which ended voice. Reconnecting…'); }
  reconnect();
}
// A link from an earlier start is refused for good. Otherwise the companion may
// be restarting, still coming up, or briefly out of reach: try again, less often.
async function reconnect() {
  const reason = await reachability();
  // Returning to the page may have reconnected it meanwhile.
  if (bridge.open || bridge.connecting || leaving) return;
  if (reason === 'refused') {
    $('connection').textContent = 'Not connected';
    notice('This link is from an earlier start of the companion. Open the link fdc printed this time.');
    return;
  }
  if (reason === 'unreachable' && attempts >= 2) notice(`Can't reach the companion. It stops when ${profile.name} exits; if it did, start fdc again and open its new link. Retrying…`);
  retry = setTimeout(() => { if (!bridge.open && !bridge.connecting) connect(); }, Math.min(10000, 500 * 2 ** attempts++));
}
async function reachability(): Promise<'reachable' | 'refused' | 'unreachable'> {
  try {
    const response = await fetch('/api/status', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return response.status === 403 ? 'refused' : response.ok ? 'reachable' : 'unreachable';
  } catch { return 'unreachable'; }
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
$('confirm-product').textContent = profile.product;
$<HTMLInputElement>('confirm-deliveries').onchange = e => { if (bridge.open) bridge.send({ type: 'confirm_deliveries', on: (e.target as HTMLInputElement).checked }); };
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
// A connection that has gone quiet is dead even if it looks open, as after a phone sleeps.
setInterval(() => { if (bridge.open && Date.now() - bridge.lastMessageAt > 6000) { bridge.close(); disconnected(); } }, 2000);
// Coming back to the page reconnects at once instead of waiting for the next try.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !bridge.open && !bridge.connecting && !leaving && token) { attempts = 0; connect(); } });
addEventListener('pagehide', () => { leaving = true; clearTimeout(retry); stop(); bridge.close(); });
// A page restored from the back/forward cache connects again.
addEventListener('pageshow', event => { if (event.persisted) { leaving = false; connect(); } });
connect();
