// Short audible cues for voice lifecycle and delegation. Bridge events are the
// source of truth: a button click alone never plays a cue.

// Decides which cue an incoming bridge event deserves. Kept free of audio so it
// can be tested without a browser.
export class CueTracker {
  constructor() { this.session = null; this.tasks = new Set(); }
  // replaying: events restored from history after a page reload are old news.
  cue(event, { replaying = false } = {}) {
    if (event.type === 'voice_started') {
      if (replaying || this.session === event.sessionId) return null;
      this.session = event.sessionId;
      return 'start';
    }
    if (event.type === 'voice_closed') return this.end();
    if (event.type === 'task' && typeof event.id === 'string') {
      if (this.tasks.has(event.id)) return null;
      this.tasks.add(event.id);
      return replaying ? null : 'delegate';
    }
    return null;
  }
  // Also called when the page loses the bridge, since no voice_closed will follow.
  end() {
    if (!this.session) return null;
    this.session = null;
    return 'end';
  }
}

// Notes as [frequency Hz, start s, duration s]. Start rises, end falls, and
// delegation is a quick double tick so it cannot be mistaken for either.
const PATTERNS = {
  start: { type: 'sine', gain: .16, notes: [[660, 0, .11], [990, .11, .16]] },
  end: { type: 'sine', gain: .16, notes: [[990, 0, .11], [590, .11, .2]] },
  delegate: { type: 'triangle', gain: .09, notes: [[1320, 0, .05], [1320, .09, .05]] },
};

export class CuePlayer {
  // The context must first be created during a user gesture (Start voice).
  unlock() {
    this.context ??= new AudioContext();
    return this.context.resume().catch(() => {});
  }
  play(name) {
    const pattern = PATTERNS[name], context = this.context;
    if (!pattern || !context || context.state === 'closed') return;
    const now = context.currentTime + .02;
    for (const [frequency, offset, duration] of pattern.notes) {
      const oscillator = context.createOscillator(), envelope = context.createGain();
      oscillator.type = pattern.type; oscillator.frequency.value = frequency;
      // A short attack and release avoid clicks at note boundaries.
      envelope.gain.setValueAtTime(0, now + offset);
      envelope.gain.linearRampToValueAtTime(pattern.gain, now + offset + .01);
      envelope.gain.exponentialRampToValueAtTime(.0001, now + offset + duration);
      oscillator.connect(envelope).connect(context.destination);
      oscillator.start(now + offset); oscillator.stop(now + offset + duration + .02);
    }
  }
}
