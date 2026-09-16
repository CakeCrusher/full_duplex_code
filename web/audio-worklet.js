class DuplexAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.muted = false; this.ticks = 0;
    this.inputPower = 0; this.outputPower = 0; this.levelSamples = 0;
    this.auditSession = null; this.auditOffset = 0;
    this.gateThreshold = .008; this.gateHoldSamples = 0; this.rawInputPower = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'mute') { this.muted = data.muted; if (this.muted) this.gateHoldSamples = 0; }
      if (data.type === 'audit_start') { this.auditSession = data.sessionId; this.auditOffset = 0; }
      if (data.type === 'gate' && Number.isFinite(data.threshold) && data.threshold >= 0 && data.threshold <= .05) {
        this.gateThreshold = data.threshold; this.gateHoldSamples = 0;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0]; const output = outputs[1][0];
    const remote = inputs[1]?.[0];
    const microphoneOutput = outputs[0][0];
    let rawPower = 0;
    for (let i = 0; i < output.length; i++) rawPower += (this.muted ? 0 : (input?.[i] ?? 0)) ** 2;
    const rawRms = Math.sqrt(rawPower / output.length);
    if (rawRms >= this.gateThreshold) this.gateHoldSamples = sampleRate * .3;
    const gateOpen = this.gateThreshold === 0 || this.gateHoldSamples > 0;
    this.gateHoldSamples = Math.max(0, this.gateHoldSamples - output.length);
    this.rawInputPower += rawPower;
    for (let i = 0; i < output.length; i++) {
      const sample = this.muted || !gateOpen ? 0 : (input?.[i] ?? 0);
      const sent = Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767));
      this.inputPower += (sent / 32768) ** 2;
      microphoneOutput[i] = sent / 32768;
      output[i] = remote?.[i] ?? 0;
      this.outputPower += output[i] * output[i];
    }
    this.levelSamples += output.length;
    if (this.auditSession) {
      const pcm = Int16Array.from(output, sample => Math.round(sample * 32768)).buffer;
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
