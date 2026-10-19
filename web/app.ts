// The page: wires the bridge client, audio I/O, the WebRTC peer, the page UI,
// the timeline, the meters and the sound cues, and runs one voice connection at a time.
import { TimelineView } from './timeline.js';
import { Meters } from './meters.js';
import { CuePlayer, CueTracker } from './cues.js';
import { BridgeClient, type BridgeEvent } from './bridge-client.js';
import { AudioIO, watchMicrophones, type WorkletMessage } from './audio-io.js';
import { WebRtcPeer } from './webrtc-peer.js';
import { $, developerMode, microphone as microphoneAccess, notice, requireMicrophone, resumable, showStatus } from './page-ui.js';
import { profile } from './profile.js';
import { mountCompanions } from './companions.js';

const token = location.hash.slice(1) || sessionStorage.getItem('fd-voice-token');
if (location.hash) { sessionStorage.setItem('fd-voice-token', token!); history.replaceState(null, '', location.pathname); }
// A new link from a later start, opened in this tab, changes only the hash, and the browser
// doesn't reload for that: reload so the page reads the new key instead of the refused old one.
addEventListener('hashchange', () => { if (location.hash.length > 1) location.reload(); });
const bridge = new BridgeClient(), audio = new AudioIO(), peer = new WebRtcPeer();
let active = false, starting = false, muted = false, currentStatus: BridgeEvent | undefined;
// On Standby: GPT Live is disconnected while the conversation is quiet, and this page keeps its microphone
// open, held, so the operator's speech (or the agent's news, through the bridge) can wake voice.
let standby = false, waking = false;
let voiceSessionId: string | null = null;
let generation = 0;
// The audit copy pauses while the bridge connection is backlogged, and how many packets it dropped.
let auditPaused = false, auditDropped = 0;
// This page's identity on the bridge, and its connection: it reconnects by itself.
let pageId: string | null = null, connections = 0, attempts = 0, leaving = false, voiceDropped = false;
let retry: ReturnType<typeof setTimeout> | undefined;
const cues = new CueTracker(), cuePlayer = new CuePlayer();
let replaying = false;
developerMode();
const timeline = new TimelineView(), meters = new Meters(timeline.items);
// Loaded on its own: an fdc started before this module existed serves the page without it (it serves only
// the files it knew when it started), and the rest of the page must still work.
let settingsPanel: { update(event: BridgeEvent): void } | undefined;
import('./settings-panel.js').then(module => { settingsPanel = module.mountSettings($('settings'), token); if (currentStatus) settingsPanel.update(currentStatus); }).catch(() => { $('settings').hidden = true; });

function handle(event: BridgeEvent) {
  timeline.handle(event); meters.handle(event);
  const cue = cues.cue(event, { replaying });
  if (cue) cuePlayer.play(cue);
  if (event.type === 'page') pageId = event.id;
  if (event.type === 'status') {
    currentStatus = event;
    // The companion's learned instructions as it lists them: a card for each, and one it no longer lists was removed.
    const listed = (event.prompt?.additional ?? []).filter((item: any) => item.learned);
    for (const item of listed) learned({ type: 'instruction_learned', id: item.learned, text: item.text.replace(`${item.learned}: `, '') });
    for (const card of document.querySelectorAll<HTMLElement>('.learned[id^="learned-"]:not(.removed)')) if (!listed.some((item: any) => card.id === `learned-${item.learned}`)) removed(card.id.slice('learned-'.length));
    showStatus(event, { active, muted, starting, standby, waking, elsewhere: Boolean(event.voicePage) && event.voicePage !== pageId });
    settingsPanel?.update(event);
  }
  if (event.type === 'agent_status') $('agentState').textContent = event.detail;
  if (event.type === 'instruction_learned') learned(event);
  if (event.type === 'instruction_removed') removed(event.id);
  if (event.type === 'tuning' && event.changes?.length) tuned(event.changes);
  // Sessions turned on or off by voice: what fdc is doing, and another companion asking this one to start voice.
  if (event.type === 'sessions' && !replaying) notice(event.text);
  // The page beside the conversation moved without the agent: by the voice's own words, or by the voice tool.
  if (event.type === 'stage' && !replaying && event.done?.length) notice(`${event.cue ? 'The page followed the voice' : 'The voice tool moved the page'}: ${event.done.join(', then ').replace(/\s*\([^()]*\)\s*$/, '')}.`);
  if (event.type === 'voice_on' && !active && !starting && !standby) { notice(`Voice turned on from ${event.from}.`); start(resumable(currentStatus) ? 'resume' : 'fresh', false, true); }
  if (event.type === 'voice_wake') wake();
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
    const woke = waking;
    active = true; starting = false; standby = false; waking = false; cuePlayer.waking(false);
    if (woke) replayWhenConnected(); else notice(event.automatic ? 'Reconnected. The conversation continues.' : '');
    $<HTMLButtonElement>('mute').disabled = false; $<HTMLButtonElement>('stop').disabled = false; $('audioState').textContent = 'Microphone on';
  }
  if (event.type === 'voice_closed') {
    // Quiet: voice goes on Standby, and this page keeps listening.
    if (event.standby && (active || starting)) { pause(); return; }
    releaseAudio();
    // Voice that ended on its own resumes by itself, a limited number of times.
    if (event.reconnect) { notice(`Voice dropped (${event.reason}). Reconnecting…`); start('resume', true); return; }
    notice(/^(Turned off|Switched to)\b/.test(event.reason ?? '') ? `${event.reason}.` : event.dropped ? `Voice dropped (${event.reason}). Click Resume voice to continue the conversation.` : event.moved ? 'Voice moved to another tab or device. Click Move voice here to bring it back.' : event.reserved === false ? 'Voice did not start. No API connection was opened.' : event.finalized ? `Voice session ended. ${profile.name} is still available in your terminal.` : 'Voice connection ended. Final usage was not confirmed; the last reported usage is saved and may be incomplete.');
  }
}
// Jev heard a standing instruction and added it: show what was added, under its ID, with a way to remove it.
function learned(event: BridgeEvent) {
  if (document.getElementById(`learned-${event.id}`)) return;
  const card = document.createElement('article'); card.className = 'learned'; card.id = `learned-${event.id}`;
  const text = document.createElement('p');
  text.append(`Added instruction ${event.id}: `, Object.assign(document.createElement('q'), { textContent: event.text }));
  const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove' });
  remove.onclick = () => { if (bridge.open) { bridge.send({ type: 'instruction_remove', id: event.id }); remove.disabled = true; } };
  card.append(text, remove, Object.assign(document.createElement('small'), { textContent: 'Heard by Jev from what you said. Removing it tells this voice session to disregard it, and later sessions leave it out.' }));
  $('learned').prepend(card);
}
// Jev changed how agent updates reach GPT Live: the settings and their old values, for the record.
function tuned(changes: { name: string; from: number; to: number }[]) {
  const card = document.createElement('article'); card.className = 'learned';
  const text = document.createElement('p');
  text.textContent = `Jev adjusted the companion to your instructions: ${changes.map(c => `${c.name} ${c.from} → ${c.to}`).join(', ')}.`;
  card.append(text, Object.assign(document.createElement('small'), { textContent: 'Developer mode shows what each setting does.' }));
  $('learned').prepend(card);
}
function removed(id: unknown) {
  const card = document.getElementById(`learned-${id}`);
  if (!card) return;
  card.classList.add('removed');
  card.querySelector('p')!.prepend('Removed. ');
  card.querySelector('button')?.remove();
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
      readyReported = ''; reportReady();
    },
    onEvent: handle,
    onClose: disconnected,
  });
}
// Whether voice could start here without the operator: Chrome needs microphone permission and a click in the tab
// before sound and the microphone work, so another companion turning this one on knows if it can.
// Checked every second and sent when it changes: Chrome registers a click only after the page's own
// pointerdown handlers run, so reporting from those said "not clicked" for good.
let readyReported = '';
async function reportReady() {
  let microphone = 'unknown';
  try { microphone = (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state; } catch {}
  if (microphoneAccess.opened && microphone !== 'denied') microphone = 'granted';
  // Inside another companion's tab, that tab's click carries over (the frame is allowed autoplay).
  const ready = { microphone, clicked: (navigator.userActivation?.hasBeenActive ?? false) || window !== window.top }, key = JSON.stringify(ready);
  if (!bridge.open || key === readyReported) return;
  readyReported = key; bridge.send({ type: 'page_ready', ...ready });
}
setInterval(reportReady, 1000);
function disconnected() {
  const cue = cues.end(); if (cue) cuePlayer.play(cue);
  const hadVoice = active || starting;
  releaseAudio(); pageId = null;
  $('connection').textContent = 'Reconnecting…'; $<HTMLButtonElement>('start').disabled = true; $<HTMLButtonElement>('fresh').disabled = true;
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
    // Voice matters more than its audit: a backlogged connection drops audit audio
    // until it drains (the bridge records the gap), and never ends voice.
    if (bridge.bufferedAmount > (auditPaused ? 32000 : 128000)) {
      auditDropped++;
      if (!auditPaused) { auditPaused = true; bridge.send({ type: 'audit_paused', buffered: bridge.bufferedAmount }); }
      return;
    }
    if (auditPaused) { auditPaused = false; bridge.send({ type: 'audit_resumed', dropped: auditDropped }); auditDropped = 0; }
    bridge.send({ type: 'playback_audio', voiceSessionId: data.sessionId, offsetSamples: data.offsetSamples,
      at: audio.audioEpoch + data.startTime * 1000, pcm: btoa(String.fromCharCode(...new Uint8Array(data.pcm))),
      microphone: data.microphone ? btoa(String.fromCharCode(...new Uint8Array(data.microphone))) : undefined });
  }
  if (data.type === 'level') {
    $<HTMLMeterElement>('level').value = Math.min(1, (data.rawRms ?? data.rms) * 5);
    $('gate-state').textContent = standby ? muted ? 'Muted' : data.rms > 0 ? 'Standby · speech wakes voice' : 'Standby · listening here' : !active ? 'Waiting for Live' : muted ? 'Muted' : data.rms > 0 ? 'Passing audio to Live' : 'Gate closed · sending silence';
    // On Standby too: the bridge hears the operator start speaking from these.
    if (bridge.open && (active || standby)) bridge.send({ type: 'audio_level', at: audio.audioEpoch + data.endTime * 1000, durationMs: data.durationMs, inputRms: data.rms, rawInputRms: data.rawRms, gateThreshold: data.gateThreshold, outputRms: data.outputRms });
  }
}
async function start(mode: 'resume' | 'fresh' = 'fresh', automatic = false, asked = false, fromStandby = false) {
  if (active || starting) return; starting = true; $<HTMLButtonElement>('start').disabled = true; $<HTMLButtonElement>('fresh').disabled = true;
  if (!automatic) notice('');
  cuePlayer.unlock(); // Start voice is the user gesture that allows audio cues.
  const attempt = ++generation, current = () => attempt === generation;
  // The input is captured once per voice connection; change it after End voice.
  $<HTMLSelectElement>('microphone-device').disabled = true;
  $<HTMLButtonElement>('stop').disabled = false; if (!fromStandby) $('audioState').textContent = 'Waiting for microphone…';
  try {
    const gate = Number($<HTMLInputElement>('microphone-gate').value);
    // Waking from Standby, the microphone is already open: the held audio rides on the same track.
    const microphone = fromStandby && audio.microphone ? audio.microphone : await audio.open({ deviceId: $<HTMLSelectElement>('microphone-device').value, gate, current, onMessage: measured });
    if (!microphone) return;
    if (!microphoneAccess.opened) { microphoneAccess.opened = true; reportReady(); }
    bridge.send({ type: 'microphone_gate', threshold: gate });
    const sdp = await peer.offer(microphone, {
      active: () => active, connected: () => bridge.open,
      sendStats: (stats, direction) => bridge.send({ type: 'audio_transport', voiceSessionId, direction, at: Date.now(), stats }),
      sendState: state => bridge.send({ type: 'peer_state', at: Date.now(), ...state }),
      canPlay: () => audio.running, play: received => audio.play(received),
      fail: message => { notice(message); stop(); },
    });
    if (!current()) return;
    if (!fromStandby) { muted = false; $('mute').textContent = 'Mute microphone'; $('mute').setAttribute('aria-pressed', 'false'); }
    bridge.send({ type: 'start', sdp, mode, automatic });
    $<HTMLButtonElement>('stop').disabled = false; $('audioState').textContent = 'Connecting voice…';
  } catch (error) {
    if (!current()) return; releaseAudio();
    const { name, message } = error as Error;
    // Asked by another companion: it tells the operator why this one did not start.
    if (asked && bridge.open) bridge.send({ type: 'voice_on_failed', message: name === 'NotAllowedError' ? 'its page is not allowed to use the microphone' : message });
    notice(name === 'NotAllowedError' ? 'Allow microphone access in Chrome, then click Start voice.'
      : ['OverconstrainedError', 'NotFoundError'].includes(name) ? 'The selected microphone is unavailable. Choose another microphone, then click Start voice.'
      : message);
    if (currentStatus) handle(currentStatus);
  }
}
// GPT Live has disconnected; the microphone stays open and is held for the next connection.
function pause() {
  voiceSessionId = null; active = false; starting = false; standby = true; waking = false;
  peer.close(); audio.hold();
  $('audioState').textContent = 'Standby · listening here';
  if (currentStatus) handle(currentStatus);
}
// Speech or news woke voice (or the operator clicked): a new connection on the same microphone.
function wake() {
  if (!standby || waking || active || starting) return;
  waking = true; audio.wakeHold(); cuePlayer.waking(true);
  $('audioState').textContent = 'Waking…';
  start('resume', true, false, true);
}
// The held audio goes out once the new connection carries media, ahead of the live microphone.
async function replayWhenConnected() {
  for (let i = 0; i < 100 && peer.connection && peer.connection.connectionState !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  audio.replay();
}
function releaseAudio() {
  voiceSessionId = null; standby = false; waking = false; cuePlayer.waking(false);
  if (audio.node && bridge.open) bridge.send({ type: 'audio_stopped' });
  generation++;
  active = false; starting = false; audio.stopCapture();
  peer.close(); audio.release();
  $<HTMLButtonElement>('mute').disabled = true; $<HTMLButtonElement>('stop').disabled = true; $('audioState').textContent = 'Microphone off'; $<HTMLMeterElement>('level').value = 0;
  $('gate-state').textContent = 'Microphone off';
  $<HTMLSelectElement>('microphone-device').disabled = false;
}
function stop() { if (bridge.open) bridge.send({ type: 'stop' }); releaseAudio(); }
// Start continues the conversation when there is one (Resume voice); Start fresh never does.
// On Standby, Start wakes voice now.
$('start').onclick = () => standby ? wake() : start(resumable(currentStatus) ? 'resume' : 'fresh'); $('fresh').onclick = () => start('fresh'); $('stop').onclick = stop;
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
requireMicrophone(reportReady);
mountCompanions($('companions'), token);
connect();
