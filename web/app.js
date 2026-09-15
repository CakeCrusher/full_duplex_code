import { TimelineView } from './timeline.js';

const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('fd-voice-token');
if (location.hash) { sessionStorage.setItem('fd-voice-token', token); history.replaceState(null, '', location.pathname); }
let ws, context, stream, node, mic, active = false, starting = false, muted = false, currentStatus;
let generation = 0;
const timeline = new TimelineView();

function notice(text) { $('notice').textContent = text; }
function handle(event) {
  timeline.handle(event);
  if (event.type === 'status') {
    currentStatus = event;
    $('connection').textContent = active ? muted ? 'Microphone muted' : 'Listening' : event.channel ? 'Agent connected' : 'Waiting for Claude';
    $('agentState').textContent = ({ starting: 'Starting in your terminal', idle: 'Ready for your next request', working: 'Working', needs_attention: 'Needs your attention in the terminal', failed: 'Reported an error', exited: 'Session ended' })[event.agent] ?? event.agent;
    $('start').disabled = starting || active || !event.channel || ['connecting', 'active', 'closing'].includes(event.live) || event.agent === 'exited';
    $('project').textContent = event.cwd;
    $('usage').textContent = active ? `${Math.floor(event.usageSeconds / 60)}m ${event.usageSeconds % 60}s · $${(event.usageSeconds * 0.05 / 60).toFixed(3)} · ${event.maxSeconds / 60} min limit` : 'Not connected · $0.05/min';
    $('budget').textContent = `$${event.remainingUsd.toFixed(2)} experiment budget available`;
  }
  if (event.type === 'agent_status') $('agentState').textContent = event.detail;
  if (event.type === 'history') for (const item of event.events) handle(item);
  if (event.type === 'fault') { notice(event.message); if (starting && !active) { starting = false; releaseAudio(); } }
  if (event.type === 'voice_started') {
    node?.port.postMessage({ type: 'audit_start', sessionId: event.sessionId });
    active = true; starting = false; notice('');
    $('mute').disabled = false; $('stop').disabled = false; $('audioState').textContent = 'Microphone on';
  }
  if (event.type === 'voice_closed') {
    releaseAudio();
    notice(event.finalized ? 'Voice session ended. Claude is still available in your terminal.' : 'Voice connection ended. Final usage was not confirmed; its budget reservation is retained.');
  }
}
function connect() {
  if (!token) { notice('Open the companion link printed by the launcher in your terminal.'); return; }
  ws = new WebSocket(`${location.origin.replace('http:', 'ws:')}/voice`, ['fd-voice', token]); ws.binaryType = 'arraybuffer';
  ws.onmessage = ({ data }) => {
    if (data instanceof ArrayBuffer) { if (node) node.port.postMessage({ type: 'play', pcm: data }, [data]); }
    else handle(JSON.parse(data));
  };
  ws.onclose = () => { releaseAudio(); $('connection').textContent = 'Disconnected'; $('start').disabled = true; notice('The local companion disconnected. Reopen the launcher link to reconnect.'); };
  ws.onerror = () => notice('Unable to connect. Another companion tab may already be open.');
}
async function start() {
  if (active || starting) return; starting = true; $('start').disabled = true; notice('');
  const attempt = ++generation;
  $('stop').disabled = false; $('audioState').textContent = 'Waiting for microphone…';
  try {
    context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
    await context.resume();
    if (attempt !== generation) return;
    if (context.sampleRate !== 24000) throw new Error('This browser did not provide 24 kHz audio. Use current Chrome.');
    let permissionTimer;
    const requestedStream = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    requestedStream.then(s => { if (attempt !== generation) s.getTracks().forEach(track => track.stop()); }).catch(() => {});
    try {
      const granted = await Promise.race([requestedStream, new Promise((_, reject) => { permissionTimer = setTimeout(() => reject(new Error('Microphone startup is taking too long. Check Chrome’s microphone permission and selected audio device, then try again.')), 20000); })]);
      if (attempt !== generation) { granted.getTracks().forEach(track => track.stop()); return; }
      stream = granted;
    } finally { clearTimeout(permissionTimer); }
    if (attempt !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
    await context.audioWorklet.addModule('/audio-worklet.js');
    node = new AudioWorkletNode(context, 'duplex-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const audioEpoch = Date.now() - context.currentTime * 1000;
    node.port.onmessage = ({ data }) => {
      if (data.type === 'playback' && ws?.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 128000) { notice('The audio audit connection fell behind. Please reconnect.'); stop(); return; }
        ws.send(JSON.stringify({ type: 'playback_audio', voiceSessionId: data.sessionId, offsetSamples: data.offsetSamples,
          at: audioEpoch + data.startTime * 1000, pcm: btoa(String.fromCharCode(...new Uint8Array(data.pcm))) }));
      }
      if (data.type === 'input' && ws?.readyState === WebSocket.OPEN && (active || starting)) {
        if (ws.bufferedAmount > 128000) { notice('The audio connection is too slow. Please reconnect.'); stop(); return; }
        ws.send(data.pcm);
      }
      if (data.type === 'level') {
        $('level').value = Math.min(1, data.rms * 5);
        if (ws?.readyState === WebSocket.OPEN && (active || starting)) ws.send(JSON.stringify({ type: 'audio_level', at: audioEpoch + data.endTime * 1000, durationMs: data.durationMs, inputRms: data.rms, outputRms: data.outputRms, backlogMs: data.backlogMs }));
        if (data.backlogMs > 2000) { notice('Audio playback fell behind. Please reconnect.'); stop(); }
      }
    };
    mic = context.createMediaStreamSource(stream); mic.connect(node); node.connect(context.destination);
    muted = false; $('mute').textContent = 'Mute microphone'; $('mute').setAttribute('aria-pressed', 'false');
    ws.send(JSON.stringify({ type: 'start' }));
    $('stop').disabled = false; $('audioState').textContent = 'Connecting voice…';
  } catch (error) { if (attempt !== generation) return; releaseAudio(); notice(error.name === 'NotAllowedError' ? 'Allow microphone access in Chrome, then click Start voice.' : error.message); if (currentStatus) handle(currentStatus); }
}
function releaseAudio() {
  if (node && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stopped' }));
  generation++;
  active = false; starting = false; stream?.getTracks().forEach(track => track.stop()); stream = null;
  mic?.disconnect(); mic = null; node?.disconnect(); node = null; context?.close().catch(() => {}); context = null;
  $('mute').disabled = true; $('stop').disabled = true; $('audioState').textContent = 'Microphone off'; $('level').value = 0;
}
function stop() { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' })); releaseAudio(); }
$('start').onclick = start; $('stop').onclick = stop;
$('mute').onclick = () => {
  muted = !muted; node?.port.postMessage({ type: 'mute', muted }); ws.send(JSON.stringify({ type: 'mute', muted }));
  $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; $('mute').setAttribute('aria-pressed', String(muted)); $('audioState').textContent = muted ? 'Microphone muted' : 'Microphone on';
};
addEventListener('pagehide', () => { stop(); ws?.close(); });
connect();
