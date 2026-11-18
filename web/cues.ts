// Short audible cues for voice lifecycle and delegation. Bridge events are the
// source of truth: a button click alone never plays a cue.

// Decides which cue an incoming bridge event deserves. Kept free of audio so it
// can be tested without a browser.
export type Cue = 'start' | 'end' | 'delegate' | 'learned' | 'standby';

export class CueTracker {
  session: string | null = null;
  /** Voice is on Standby: its session ended, voice did not. */
  paused = false;
  tasks = new Set<string>();
  // replaying: events restored from history after a page reload are old news.
  cue(event: { type: string; [field: string]: any }, { replaying = false } = {}): Cue | null {
    if (event.type === 'voice_started') {
      if (replaying || this.session === event.sessionId) return null;
      this.session = event.sessionId ?? null; this.paused = false;
      return 'start';
    }
    if (event.type === 'voice_closed' && event.standby) {
      if (!this.session) return null;
      this.session = null; this.paused = true;
      return replaying ? null : 'standby';
    }
    // A wake's session that never started: voice is still waking, on another connection.
    if (event.type === 'voice_closed' && event.waking) return null;
    if (event.type === 'voice_closed') return this.end();
    // Behavior Jev learned, an instruction or a change to the settings: once each, and never from restored history.
    const learned = event.type === 'instruction_learned' || (event.type === 'tuning' && (event.by === undefined || event.by === 'Jev') && event.changes?.some((change: any) => change.from !== change.to));
    if (learned && typeof event.id === 'string') {
      if (this.tasks.has(`learned-${event.id}`)) return null;
      this.tasks.add(`learned-${event.id}`);
      return replaying ? null : 'learned';
    }
    // A request held for the end of the agent's turn sounds when it goes, not when it is held.
    if (event.type === 'task' && typeof event.id === 'string' && event.state !== 'held') {
      if (this.tasks.has(event.id)) return null;
      this.tasks.add(event.id);
      return replaying ? null : 'delegate';
    }
    return null;
  }
  // Also called when the page loses the bridge, since no voice_closed will follow.
  end(): Cue | null {
    if (!this.session && !this.paused) return null;
    this.session = null; this.paused = false;
    return 'end';
  }
}

// Notes as [frequency Hz, start s, duration s]. Start rises, end falls,
// delegation is a quick double tick, and an instruction Jev added is a soft
// three-note rise, so none can be mistaken for another. Standby is two soft,
// slow, low notes falling: settling down, not ending.
const PATTERNS: Record<Cue, { type: OscillatorType; gain: number; notes: [number, number, number][] }> = {
  standby: { type: 'sine', gain: .09, notes: [[523, 0, .32], [392, .3, .6]] },
  start: { type: 'sine', gain: .16, notes: [[660, 0, .11], [990, .11, .16]] },
  end: { type: 'sine', gain: .16, notes: [[990, 0, .11], [590, .11, .2]] },
  delegate: { type: 'triangle', gain: .09, notes: [[1320, 0, .05], [1320, .09, .05]] },
  learned: { type: 'triangle', gain: .1, notes: [[784, 0, .08], [988, .1, .08], [1319, .2, .14]] },
};

export class CuePlayer {
  context?: AudioContext;
  // The context must first be created during a user gesture (Start voice).
  unlock() {
    this.context ??= new AudioContext();
    return this.context.resume().catch(() => {});
  }
  play(name: Cue) {
    const pattern = PATTERNS[name], context = this.context;
    if (!pattern || !context || context.state === 'closed') return;
    const now = context.currentTime + .02;
    for (const [frequency, offset, duration] of pattern.notes) this.tone(pattern.type, pattern.gain, frequency, now + offset, duration);
  }
  tone(type: OscillatorType, gain: number, frequency: number, at: number, duration: number, attack = .01) {
    const context = this.context!, oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = type; oscillator.frequency.value = frequency;
    // A short attack and release avoid clicks at note boundaries.
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + attack);
    envelope.gain.exponentialRampToValueAtTime(.0001, at + duration);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(at); oscillator.stop(at + duration + .02);
  }
  rush?: { filter: BiquadFilterNode; gain: GainNode };
  /**
   * On Standby, while the operator's voice is being picked up: a soft rush of air that rises in pitch and loudness as their
   * voice lasts toward the wake (0 to 1), and falls away if they stop before it. The wake's own note follows it. Noise, not
   * a note: a note repeats itself as a voice does, and the microphone would count it as theirs.
   */
  rising(value: number) {
    const context = this.context;
    if (!context || context.state === 'closed' || (!value && !this.rush)) return;
    if (!this.rush) {
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate), data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain();
      source.buffer = buffer; source.loop = true; filter.type = 'bandpass'; filter.Q.value = .8; gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(context.destination); source.start();
      this.rush = { filter, gain };
    }
    const now = context.currentTime, { filter, gain } = this.rush;
    filter.frequency.setTargetAtTime(500 + 1900 * value, now, .1);
    gain.gain.setTargetAtTime(value ? .03 + .11 * value : 0, now, value ? .1 : .06);
  }
  pulseTimer?: ReturnType<typeof setInterval>;
  /**
   * While voice wakes from Standby: the start cue's first note at once (the operator is heard), then again softly, like
   * breathing, while the session starts and their held words go in (a wake that continues the paused session takes
   * 3-10 s); the page then plays the whole start cue.
   */
  waking(on: boolean) {
    clearInterval(this.pulseTimer); this.pulseTimer = undefined;
    const context = this.context, [[note]] = PATTERNS.start.notes;
    if (!on || !context || context.state === 'closed') return;
    this.tone('sine', .12, note, context.currentTime + .02, .3);
    this.pulseTimer = setInterval(() => this.tone('sine', .06, note, context.currentTime + .02, .45, .15), 800);
  }
}
