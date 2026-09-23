import { TimelineView } from './timeline.js';

const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('fd-voice-token');
if (location.hash) { sessionStorage.setItem('fd-voice-token', token); history.replaceState(null, '', location.pathname); }
let ws, context, stream, node, mic, active = false, starting = false, muted = false, currentStatus;
let peer, remote, remoteAudio, microphoneDestination, transportTimer, voiceSessionId;
let generation = 0;
let instructionHistory = '';
const timeline = new TimelineView();
const speakingNames = ['Quiet', 'Milestones'];
const speakingDescriptions = ['Answer you and confirm sent requests. Observe Claude silently.', 'Default: meaningful outcomes, major changes, and decisions you must make. Complete thoughts, without running commentary. Your spoken requests come first.'];
function showSpeaking(level) {
  $('speaking-level').value = level;
  $('speaking-level').setAttribute('aria-valuetext', speakingNames[level]);
  $('speaking-label').textContent = speakingNames[level];
  $('speaking-description').textContent = speakingDescriptions[level];
}
function showSpeakingUpdate(update) {
  const name = speakingNames[update.level];
  const confirmed = speakingNames[update.confirmedLevel];
  const states = {
    next_session: [`Next session · ${name}`, 'This preference will be included when you start voice.'],
    starting: [`Waiting for session · ${name}`, 'The voice connection has not confirmed this preference yet.'],
    pending: [`Applying · ${name}…`, `Waiting for Live’s acknowledgment.${confirmed ? ` Last confirmed: ${confirmed}.` : ''}`],
    acknowledged: [update.source === 'startup' ? `Active from session start · ${name}` : `Live acknowledged · ${name}`, 'The instructions are confirmed for this conversation. This does not guarantee when speech will reflect them.'],
    failed: [`Not confirmed · ${name}`, `${update.error ?? 'The update failed.'} Select the mode again to retry.`],
    disconnected: ['Disconnected', 'Reconnect before changing the speaking preference.'],
  };
  const [label, detail] = states[update.state] ?? states.next_session;
  $('updates-state').textContent = label; $('updates-state').dataset.state = update.state;
  $('updates-detail').textContent = detail;
}

function notice(text) { $('notice').textContent = text; }
function handle(event) {
  timeline.handle(event);
  if (event.type === 'status') {
    currentStatus = event;
    if (event.prompt) {
      const texts = {
        'prompt-state': ({ preview: 'Next voice session · startup preview', session: 'Current voice session · startup instructions', previous: 'Last voice session · startup instructions' })[event.prompt.mode],
        'prompt-instructions': event.prompt.instructions,
        'prompt-preference': event.prompt.speakingPreference,
      };
      // Preserve text selection while the regular status updates arrive.
      for (const [id, text] of Object.entries(texts)) if ($(id).textContent !== text) $(id).textContent = text;
      const additional = event.prompt.additional ?? [];
      const serialized = JSON.stringify(additional);
      if (serialized !== instructionHistory) {
        instructionHistory = serialized;
        $('instruction-history').replaceChildren(...additional.map(item => {
          const article = document.createElement('article');
          const state = document.createElement('strong');
          state.textContent = ({ pending: 'Applying…', acknowledged: 'Live acknowledged', failed: 'Not confirmed', next_session: 'Saved for next voice session' })[item.state];
          const text = document.createElement('pre'); text.textContent = item.text;
          article.append(state, text);
          if (item.error) { const error = document.createElement('p'); error.textContent = item.error; article.append(error); }
          return article;
        }));
      }
      $('instruction-append').disabled = ['new', 'connecting', 'closing'].includes(event.live) || additional.some(item => item.state === 'pending');
    }
    if (document.activeElement !== $('speaking-level')) showSpeaking(event.speakingLevel ?? 1);
    showSpeakingUpdate(event.speakingUpdate ?? { state: 'next_session', level: event.speakingLevel ?? 1 });
    const delivery = event.contextDelivery ?? { waiting: 0, inFlight: 0 };
    $('context-delivery').textContent = event.live !== 'active' ? 'Claude observations stay saved while voice is off.'
      : delivery.observationsWaiting ? `${delivery.observationsWaiting} hooks being combined · oldest ${(delivery.oldestObservationMs / 1000).toFixed(1)}s · estimated API backlog ${delivery.estimatedBacklogSeconds.toFixed(1)}s. Full observations remain saved.`
      : delivery.waiting ? `${delivery.waiting} context fragments waiting · sending in order, including during speech. All observations remain saved.`
      : delivery.inFlight ? `All context sent · ${delivery.inFlight} fragment${delivery.inFlight === 1 ? '' : 's'} awaiting Live’s acknowledgment.` : 'No context waiting to be sent.';
    $('connection').textContent = active ? muted ? 'Microphone muted' : 'Listening' : event.channel ? 'Agent connected' : 'Waiting for Claude';
    $('agentState').textContent = ({ starting: 'Starting in your terminal', idle: 'Ready for your next request', working: 'Working', needs_attention: 'Needs your attention in the terminal', failed: 'Reported an error', exited: 'Session ended' })[event.agent] ?? event.agent;
    $('start').disabled = starting || active || !event.channel || ['connecting', 'active', 'closing'].includes(event.live) || event.agent === 'exited';
    $('project').textContent = event.cwd;
    $('usage').textContent = active ? `${Math.floor(event.usageSeconds / 60)}m ${event.usageSeconds % 60}s · $${(event.usageSeconds * 0.05 / 60).toFixed(3)}` : 'Not connected · $0.05/min';
    $('budget').textContent = `Estimated total $${event.committedUsd.toFixed(2)} · includes unfinished sessions`;
  }
  if (event.type === 'agent_status') $('agentState').textContent = event.detail;
  if (event.type === 'history') for (const item of event.events) handle(item);
  if (event.type === 'fault') { notice(event.message); if (starting && !active) { starting = false; releaseAudio(); } }
  if (event.type === 'voice_answer' && peer) {
    const connection = peer;
    connection.setRemoteDescription({ type: 'answer', sdp: event.sdp }).catch(error => { if (peer === connection) { notice(error.message); stop(); } });
  }
  if (event.type === 'voice_started') {
    voiceSessionId = event.sessionId;
    node?.port.postMessage({ type: 'audit_start', sessionId: event.sessionId });
    active = true; starting = false; notice('');
    $('mute').disabled = false; $('stop').disabled = false; $('audioState').textContent = 'Microphone on';
  }
  if (event.type === 'voice_closed') {
    releaseAudio();
    notice(event.reserved === false ? 'Voice did not start. No API connection was opened.' : event.finalized ? 'Voice session ended. Claude is still available in your terminal.' : 'Voice connection ended. Final usage was not confirmed; the last reported usage is saved and may be incomplete.');
  }
}
$('instruction-form').onsubmit = event => {
  event.preventDefault();
  if (ws?.readyState !== WebSocket.OPEN) { $('instruction-status').textContent = 'Reconnect to the companion first.'; return; }
  const text = $('instruction-text').value.trim();
  if (!text) return;
  if (new TextEncoder().encode(text).length > 440) { $('instruction-status').textContent = 'Please shorten this instruction before appending it.'; return; }
  ws.send(JSON.stringify({ type: 'append_instruction', text }));
  $('instruction-status').textContent = 'Submitted. Check the instruction status below for confirmation.';
  $('instruction-text').value = '';
};
// The chosen input is a per-browser convenience. Labels appear only after
// Chrome has granted microphone access, so the list refreshes after capture.
const MICROPHONE_KEY = 'fd-microphone-device';
function storedMicrophone() { try { return localStorage.getItem(MICROPHONE_KEY) ?? ''; } catch { return ''; } }
async function listMicrophones() {
  const select = $('microphone-device');
  let inputs = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput' && device.deviceId); } catch { return; }
  const devices = inputs.filter(device => !['default', 'communications'].includes(device.deviceId));
  // Name the device behind Chrome's default: it can differ from the macOS input.
  const fallback = inputs.find(device => device.deviceId === 'default')?.label.replace(/^Default - /, '');
  const wanted = select.value || storedMicrophone();
  select.replaceChildren(new Option(fallback ? `Chrome default (${fallback})` : 'Chrome default', ''), ...devices.map((device, index) => new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
  // An unplugged choice stays saved; Chrome's default is used until it returns.
  select.value = devices.some(device => device.deviceId === wanted) ? wanted : '';
}
// Each launcher port is a new site to Chrome, which hides devices until it grants
// microphone access. Ask when the operator opens the list, not on page load.
async function revealMicrophones() {
  if ([...$('microphone-device').options].some(option => option.value)) return;
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(track => track.stop()); }
  catch { notice('Allow microphone access in Chrome to list your microphones.'); return; }
  await listMicrophones();
}
$('microphone-device').addEventListener('pointerdown', revealMicrophones);
$('microphone-device').addEventListener('focus', revealMicrophones);
$('microphone-device').onchange =e => { try { localStorage.setItem(MICROPHONE_KEY, e.target.value); } catch {} };
navigator.mediaDevices?.addEventListener('devicechange', listMicrophones);
listMicrophones();
function connect() {
  if (!token) { notice('Open the companion link printed by the launcher in your terminal.'); return; }
  ws = new WebSocket(`${location.origin.replace('http:', 'ws:')}/voice`, ['fd-voice', token]); ws.binaryType = 'arraybuffer';
  ws.onmessage = ({ data }) => { if (typeof data === 'string') handle(JSON.parse(data)); };
  ws.onclose = () => { releaseAudio(); showSpeakingUpdate({ state: 'disconnected' }); $('connection').textContent = 'Disconnected'; $('start').disabled = true; notice('The local companion disconnected. Reopen the launcher link to reconnect.'); };
  ws.onerror = () => notice('Unable to connect. Another companion tab may already be open.');
}
async function start() {
  if (active || starting) return; starting = true; $('start').disabled = true; notice('');
  const attempt = ++generation;
  // The input is captured once per voice connection; change it after End voice.
  $('microphone-device').disabled = true;
  $('stop').disabled = false; $('audioState').textContent = 'Waiting for microphone…';
  try {
    context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
    await context.resume();
    if (attempt !== generation) return;
    if (context.sampleRate !== 24000) throw new Error('This browser did not provide 24 kHz audio. Use current Chrome.');
    let permissionTimer;
    const deviceId = $('microphone-device').value;
    const requestedStream = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
    requestedStream.then(s => { if (attempt !== generation) s.getTracks().forEach(track => track.stop()); }).catch(() => {});
    try {
      const granted = await Promise.race([requestedStream, new Promise((_, reject) => { permissionTimer = setTimeout(() => reject(new Error('Microphone startup is taking too long. Check Chrome’s microphone permission and selected audio device, then try again.')), 20000); })]);
      if (attempt !== generation) { granted.getTracks().forEach(track => track.stop()); return; }
      stream = granted;
    } finally { clearTimeout(permissionTimer); }
    listMicrophones();
    if (attempt !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
    await context.audioWorklet.addModule('/audio-worklet.js');
    if (attempt !== generation) return;
    node = new AudioWorkletNode(context, 'duplex-audio', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [1, 1] });
    node.port.postMessage({ type: 'gate', threshold: Number($('microphone-gate').value) });
    ws.send(JSON.stringify({ type: 'microphone_gate', threshold: Number($('microphone-gate').value) }));
    const audioEpoch = Date.now() - context.currentTime * 1000;
    node.port.onmessage = ({ data }) => {
      if (data.type === 'playback' && ws?.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 128000) { notice('The audio audit connection fell behind. Please reconnect.'); stop(); return; }
        ws.send(JSON.stringify({ type: 'playback_audio', voiceSessionId: data.sessionId, offsetSamples: data.offsetSamples,
          at: audioEpoch + data.startTime * 1000, pcm: btoa(String.fromCharCode(...new Uint8Array(data.pcm))),
          microphone: data.microphone ? btoa(String.fromCharCode(...new Uint8Array(data.microphone))) : undefined }));
      }
      if (data.type === 'level') {
        $('level').value = Math.min(1, (data.rawRms ?? data.rms) * 5);
        $('gate-state').textContent = !active ? 'Waiting for Live' : muted ? 'Muted' : data.rms > 0 ? 'Passing audio to Live' : 'Gate closed · sending silence';
        if (ws?.readyState === WebSocket.OPEN && active) ws.send(JSON.stringify({ type: 'audio_level', at: audioEpoch + data.endTime * 1000, durationMs: data.durationMs, inputRms: data.rms, rawInputRms: data.rawRms, gateThreshold: data.gateThreshold, outputRms: data.outputRms }));
      }
    };
    // WebRTC owns decoding, jitter buffering and continuous playback. The
    // worklet gates the outgoing microphone and measures the decoded speaker
    // track without scheduling, splicing or cutting generated speech.
    mic = context.createMediaStreamSource(stream); mic.connect(node, 0, 0);
    microphoneDestination = context.createMediaStreamDestination();
    node.connect(microphoneDestination, 0, 0); node.connect(context.destination, 1, 0);
    const connection = peer = new RTCPeerConnection();
    // Audit the receiver independently of captions and worklet playback.
    // A final packetsLost count can be zero even when late packets caused
    // audible concealment earlier, so retain the counters over time.
    let samplingTransport = false;
    transportTimer = setInterval(async () => {
      if (!active || samplingTransport || peer !== connection) return;
      samplingTransport = true;
      try {
        const report = await connection.getStats();
        if (!active || peer !== connection || ws?.readyState !== WebSocket.OPEN) return;
        for (const stat of report.values()) {
          if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') continue;
          const fields = ['packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter', 'concealedSamples', 'silentConcealedSamples',
            'concealmentEvents', 'totalSamplesReceived', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
            'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'];
          const stats = Object.fromEntries(fields.filter(key => Number.isFinite(stat[key])).map(key => [key, stat[key]]));
          stats.clockRate = report.get(stat.codecId)?.clockRate;
          stats.requestedJitterBufferMs = connection.getReceivers().find(receiver => receiver.track.kind === 'audio')?.jitterBufferTarget;
          ws.send(JSON.stringify({ type: 'audio_transport', voiceSessionId, at: Date.now(), stats }));
        }
      } catch { /* Missing diagnostics must not interrupt audio. */ }
      finally { samplingTransport = false; }
    }, 1000);
    connection.ontrack = event => {
      if (peer !== connection || !context || !node) return;
      // Give late network packets a small recovery window in the existing
      // WebRTC receiver. Speech still streams continuously in both directions.
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 200;
      const received = new MediaStream([event.track]);
      // Chrome starts the WebRTC receiver's playout clock through a media
      // element. Keep that element silent: the measured worklet is the only
      // audible output, so the same track cannot play twice.
      remoteAudio = new Audio(); remoteAudio.srcObject = received; remoteAudio.muted = true;
      remoteAudio.play().catch(error => { if (peer === connection) { notice(error.message); stop(); } });
      remote = context.createMediaStreamSource(received); remote.connect(node, 0, 1);
    };
    connection.onconnectionstatechange = () => {
      if (peer === connection && connection.connectionState === 'failed') { notice('The voice media connection failed. Start voice again to reconnect.'); stop(); }
    };
    for (const track of microphoneDestination.stream.getAudioTracks()) connection.addTrack(track, microphoneDestination.stream);
    connection.createDataChannel('oai-events');
    await connection.setLocalDescription(await connection.createOffer());
    if (connection.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.removeEventListener('icegatheringstatechange', changed); reject(new Error('Voice network setup timed out. Try again.')); }, 10000);
      function changed() {
        if (connection.iceGatheringState !== 'complete') return;
        clearTimeout(timer); connection.removeEventListener('icegatheringstatechange', changed); resolve();
      }
      connection.addEventListener('icegatheringstatechange', changed); changed();
    });
    if (attempt !== generation) return;
    muted = false; $('mute').textContent = 'Mute microphone'; $('mute').setAttribute('aria-pressed', 'false');
    ws.send(JSON.stringify({ type: 'start', sdp: connection.localDescription.sdp }));
    $('stop').disabled = false; $('audioState').textContent = 'Connecting voice…';
  } catch (error) {
    if (attempt !== generation) return; releaseAudio();
    notice(error.name === 'NotAllowedError' ? 'Allow microphone access in Chrome, then click Start voice.'
      : ['OverconstrainedError', 'NotFoundError'].includes(error.name) ? 'The selected microphone is unavailable. Choose another microphone, then click Start voice.'
      : error.message);
    if (currentStatus) handle(currentStatus);
  }
}
function releaseAudio() {
  clearInterval(transportTimer); transportTimer = null;
  voiceSessionId = null;
  if (node && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stopped' }));
  generation++;
  active = false; starting = false; stream?.getTracks().forEach(track => track.stop()); stream = null;
  peer?.close(); peer = null; remote?.disconnect(); remote = null;
  remoteAudio?.pause(); if (remoteAudio) remoteAudio.srcObject = null; remoteAudio = null;
  microphoneDestination?.stream.getTracks().forEach(track => track.stop()); microphoneDestination = null;
  mic?.disconnect(); mic = null; node?.disconnect(); node = null; context?.close().catch(() => {}); context = null;
  $('mute').disabled = true; $('stop').disabled = true; $('audioState').textContent = 'Microphone off'; $('level').value = 0;
  $('gate-state').textContent = 'Microphone off';
  $('microphone-device').disabled = false;
}
function stop() { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' })); releaseAudio(); }
$('start').onclick = start; $('stop').onclick = stop;
$('speaking-level').oninput = e => showSpeaking(Number(e.target.value));
$('speaking-level').onchange = e => {
  const level = Number(e.target.value);
  if (ws?.readyState !== WebSocket.OPEN) return showSpeakingUpdate({ state: 'disconnected', level });
  showSpeakingUpdate({ state: active ? 'pending' : starting ? 'starting' : 'next_session', level });
  ws.send(JSON.stringify({ type: 'speaking_level', level }));
};
$('microphone-gate').oninput = e => {
  const threshold = Number(e.target.value);
  $('gate-label').textContent = threshold === 0 ? 'Off' : `${(threshold * 100).toFixed(1)}%`;
  node?.port.postMessage({ type: 'gate', threshold });
};
$('microphone-gate').onchange = e => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'microphone_gate', threshold: Number(e.target.value) })); };
$('mute').onclick = () => {
  muted = !muted; node?.port.postMessage({ type: 'mute', muted }); ws.send(JSON.stringify({ type: 'mute', muted }));
  $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; $('mute').setAttribute('aria-pressed', String(muted)); $('audioState').textContent = muted ? 'Microphone muted' : 'Microphone on';
};
addEventListener('pagehide', () => { stop(); ws?.close(); });
connect();
