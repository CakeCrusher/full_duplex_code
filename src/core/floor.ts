// Who has the floor in the voice conversation. Agent updates wait while the
// operator is talking and for a moment after: time to finish a thought, and for
// GPT Live to decide whether to pass a request on. The feed and the context
// queue ask; they never wait longer than their own hold allows.
export class Floor {
  thinkMs: number; pauseMs: number;
  heardAt = -Infinity;
  constructor({ thinkMs = 2000, pauseMs = 0 }: { thinkMs?: number; pauseMs?: number } = {}) { this.thinkMs = thinkMs; this.pauseMs = pauseMs; }
  /** The operator was heard at this moment: their microphone, or GPT Live's transcript of them. */
  hear(at = Date.now()) { if (at > this.heardAt) this.heardAt = at; }
  /** The operator stopped less than the thinking time ago (with a pause time, at least that long ago: updates may land while they talk). */
  held(now = Date.now()) { const since = now - this.heardAt; return since < this.thinkMs && since >= this.pauseMs; }
}

/** The microphone level the page reports: speech when the gate passes audio louder than its threshold. */
export interface MicrophoneLevel { at: number; inputRms: number; rawInputRms?: number; gateThreshold?: number }
// With the gate off, every window passes audio; the default gate threshold still separates speech from room noise.
const SPEECH_RMS = .008;
export const operatorSpeaking = ({ inputRms, rawInputRms = inputRms, gateThreshold = 0 }: MicrophoneLevel) =>
  inputRms > 0 && rawInputRms >= Math.max(gateThreshold, SPEECH_RMS);
