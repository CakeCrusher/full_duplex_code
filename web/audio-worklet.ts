// The audio worklet scope, which the DOM library does not describe.
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;
declare const currentTime: number;

class DuplexAudio extends AudioWorkletProcessor {
  muted = false; ticks = 0;
  inputPower = 0; outputPower = 0; levelSamples = 0;
  auditSession: string | null = null; auditOffset = 0;
  gateThreshold = .008; gateHoldSamples = 0; rawInputPower = 0;
  inputGain = 4;
  // On Standby, the gated microphone is held instead of sent: its last 3 seconds, then, once voice is
  // waking, everything. When the new connection is up, the held audio goes out first and the live
  // microphone follows behind it; silence in the backlog is skipped, so it catches up at the first pause.
  holding = false; keepAll = false; replaying = false;
  held: Float32Array[] = []; heldSamples = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'hold') { this.holding = true; this.keepAll = false; this.replaying = false; this.held = []; this.heldSamples = 0; this.auditSession = null; }
      if (data.type === 'wake') this.keepAll = true;
      if (data.type === 'replay') { this.holding = false; this.replaying = this.held.length > 0; }
      if (data.type === 'mute') { this.muted = data.muted; if (this.muted) this.gateHoldSamples = 0; }
      if (data.type === 'audit_start') { this.auditSession = data.sessionId; this.auditOffset = 0; }
      if (data.type === 'gate' && Number.isFinite(data.threshold) && data.threshold >= 0 && data.threshold <= .05) {
        this.gateThreshold = data.threshold; this.gateHoldSamples = 0;
      }
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0]; const output = outputs[1][0];
    const remote = inputs[1]?.[0];
    const microphoneOutput = outputs[0][0];
    let rawPower = 0; let peak = 0;
    for (let i = 0; i < output.length; i++) {
      const sample = this.muted ? 0 : (input?.[i] ?? 0);
      rawPower += sample ** 2; peak = Math.max(peak, Math.abs(sample));
    }
    const rawRms = Math.sqrt(rawPower / output.length);
    if (rawRms >= this.gateThreshold) this.gateHoldSamples = sampleRate * .3;
    const gateOpen = this.gateThreshold === 0 || this.gateHoldSamples > 0;
    this.gateHoldSamples = Math.max(0, this.gateHoldSamples - output.length);
    this.rawInputPower += rawPower;
    // Boost accepted quiet speech, never the signal used to open the gate.
    // Reduce gain immediately for loud peaks; recover over 200 ms so syllables
    // do not repeatedly jump in volume. Leave headroom before PCM encoding.
    const peakGain = peak > 0 ? .9 / peak : 4;
    const recovery = 1 - Math.exp(-output.length / (sampleRate * .2));
    this.inputGain = Math.min(peakGain, this.inputGain + (4 - this.inputGain) * recovery);
    for (let i = 0; i < output.length; i++) {
      const sample = this.muted || !gateOpen ? 0 : (input?.[i] ?? 0) * this.inputGain;
      const sent = Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767));
      this.inputPower += (sent / 32768) ** 2;
      microphoneOutput[i] = sent / 32768;
      output[i] = remote?.[i] ?? 0;
      this.outputPower += output[i] * output[i];
    }
    if (this.holding || this.replaying) {
      this.held.push(Float32Array.from(microphoneOutput)); this.heldSamples += microphoneOutput.length;
      if (this.holding) {
        const limit = sampleRate * (this.keepAll ? 120 : 3);
        while (this.heldSamples - this.held[0].length >= limit) this.heldSamples -= this.held.shift()!.length;
        microphoneOutput.fill(0);
      } else {
        while (this.held.length > 1 && this.held[0].every(x => x === 0)) this.heldSamples -= this.held.shift()!.length;
        const next = this.held.shift()!; this.heldSamples -= next.length;
        microphoneOutput.set(next.subarray(0, microphoneOutput.length));
        if (!this.held.length) this.replaying = false;
      }
    }
    this.levelSamples += output.length;
    if (this.auditSession) {
      // Clamp only the audit's integer encoding. A decoded peak at +1 (or an
      // Opus overshoot) must not wrap to the opposite sign in the recording.
      const pcm = Int16Array.from(output, sample => Math.max(-32768, Math.min(32767, Math.round(sample * 32768)))).buffer;
      const microphone = Int16Array.from({ length: output.length }, (_, i) => {
        const sample = this.muted ? 0 : Math.max(-1, Math.min(1, input?.[i] ?? 0));
        return Math.round(sample * (sample < 0 ? 32768 : 32767));
      }).buffer;
      this.port.postMessage({ type: 'playback', pcm, microphone, sessionId: this.auditSession, offsetSamples: this.auditOffset, startTime: currentTime }, [pcm, microphone]);
      this.auditOffset += output.length;
    }
    if (++this.ticks % 20 === 0) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.inputPower / this.levelSamples), outputRms: Math.sqrt(this.outputPower / this.levelSamples),
        rawRms: Math.sqrt(this.rawInputPower / this.levelSamples), gateThreshold: this.gateThreshold,
        durationMs: this.levelSamples / sampleRate * 1000, endTime: currentTime + output.length / sampleRate });
      this.inputPower = 0; this.outputPower = 0; this.rawInputPower = 0; this.levelSamples = 0;
    }
    return true;
  }
}
registerProcessor('duplex-audio', DuplexAudio);
