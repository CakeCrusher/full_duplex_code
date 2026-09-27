// The microphone, the speakers and the audio graph between them. The worklet
// gates the outgoing microphone and measures the decoded speaker track.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// The chosen input is a per-browser convenience. Labels appear only after
// Chrome has granted microphone access, so the list refreshes after capture.
const MICROPHONE_KEY = 'fd-microphone-device';
function storedMicrophone() { try { return localStorage.getItem(MICROPHONE_KEY) ?? ''; } catch { return ''; } }
export async function listMicrophones() {
  const select = $<HTMLSelectElement>('microphone-device');
  let inputs: MediaDeviceInfo[] = [];
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
export function watchMicrophones(notice: (text: string) => void) {
  async function revealMicrophones() {
    if ([...$<HTMLSelectElement>('microphone-device').options].some(option => option.value)) return;
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(track => track.stop()); }
    catch { notice('Allow microphone access in Chrome to list your microphones.'); return; }
    await listMicrophones();
  }
  $('microphone-device').addEventListener('pointerdown', revealMicrophones);
  $('microphone-device').addEventListener('focus', revealMicrophones);
  $<HTMLSelectElement>('microphone-device').onchange = e => { try { localStorage.setItem(MICROPHONE_KEY, (e.target as HTMLSelectElement).value); } catch {} };
  navigator.mediaDevices?.addEventListener('devicechange', listMicrophones);
  listMicrophones();
}

/** Messages from the audio worklet. */
export type WorkletMessage = { type: 'playback'; pcm: ArrayBuffer; microphone?: ArrayBuffer; sessionId: string; offsetSamples: number; startTime: number }
  | { type: 'level'; rms: number; rawRms?: number; outputRms: number; gateThreshold: number; durationMs: number; endTime: number };

export class AudioIO {
  context: AudioContext | null = null;
  stream: MediaStream | null = null;
  node: AudioWorkletNode | null = null;
  mic: MediaStreamAudioSourceNode | null = null;
  microphoneDestination: MediaStreamAudioDestinationNode | null = null;
  remote: MediaStreamAudioSourceNode | null = null;
  /** Wall-clock time of the audio context's zero, for timestamps from the worklet. */
  audioEpoch = 0;
  /**
   * Captures the microphone and builds the graph. Returns the gated microphone
   * track for WebRTC, or nothing when a newer start replaced this one.
   */
  async open({ deviceId, gate, current, onMessage }: { deviceId: string; gate: number; current: () => boolean; onMessage: (data: WorkletMessage) => void }): Promise<MediaStream | undefined> {
    const context = this.context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
    await context.resume();
    if (!current()) return;
    if (context.sampleRate !== 24000) throw new Error('This browser did not provide 24 kHz audio. Use current Chrome.');
    let permissionTimer: ReturnType<typeof setTimeout> | undefined;
    const requestedStream = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
    requestedStream.then(s => { if (!current()) s.getTracks().forEach(track => track.stop()); }).catch(() => {});
    let stream: MediaStream;
    try {
      const granted = await Promise.race([requestedStream, new Promise<never>((_, reject) => { permissionTimer = setTimeout(() => reject(new Error('Microphone startup is taking too long. Check Chrome’s microphone permission and selected audio device, then try again.')), 20000); })]);
      if (!current()) { granted.getTracks().forEach(track => track.stop()); return; }
      stream = this.stream = granted;
    } finally { clearTimeout(permissionTimer); }
    listMicrophones();
    if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
    await context.audioWorklet.addModule('/audio-worklet.js');
    if (!current()) return;
    const node = this.node = new AudioWorkletNode(context, 'duplex-audio', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [1, 1] });
    node.port.postMessage({ type: 'gate', threshold: gate });
    this.audioEpoch = Date.now() - context.currentTime * 1000;
    node.port.onmessage = ({ data }) => onMessage(data);
    // WebRTC owns decoding, jitter buffering and continuous playback. The
    // worklet gates the outgoing microphone and measures the decoded speaker
    // track without scheduling, splicing or cutting generated speech.
    this.mic = context.createMediaStreamSource(stream); this.mic.connect(node, 0, 0);
    const destination = this.microphoneDestination = context.createMediaStreamDestination();
    node.connect(destination, 0, 0); node.connect(context.destination, 1, 0);
    return destination.stream;
  }
  get running() { return Boolean(this.context && this.node); }
  /** Plays the decoded remote track through the worklet, the only audible output. */
  play(received: MediaStream) {
    this.remote = this.context!.createMediaStreamSource(received); this.remote.connect(this.node!, 0, 1);
  }
  gate(threshold: number) { this.node?.port.postMessage({ type: 'gate', threshold }); }
  mute(muted: boolean) { this.node?.port.postMessage({ type: 'mute', muted }); }
  auditStart(sessionId: string) { this.node?.port.postMessage({ type: 'audit_start', sessionId }); }
  stopCapture() { this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; }
  release() {
    this.stopCapture();
    this.remote?.disconnect(); this.remote = null;
    this.microphoneDestination?.stream.getTracks().forEach(track => track.stop()); this.microphoneDestination = null;
    this.mic?.disconnect(); this.mic = null; this.node?.disconnect(); this.node = null; this.context?.close().catch(() => {}); this.context = null;
  }
}
