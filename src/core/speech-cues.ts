// GPT Live's own words move the page. It is told to say "let's look at" and a part's name as it
// turns to that part (or a page's own cue phrases, such as "next slide"); the moment those words
// appear in its transcript, the stage runs the matching command, so the page keeps time with speech.

/** A cue: the words that run a stage command. A name cue matches after a turning phrase. */
export interface SpeechCue { run: string; label: string; words: string[]; name?: boolean }

const normalize = (text: string) => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Words a name may start with that people drop or swap ("my recommendation", "the options"). */
const LEADING = new Set(['the', 'my', 'your', 'our', 'a', 'this', 'that']);
export const cueWords = (text: string) => { const words = normalize(text).split(' ').filter(Boolean); while (words.length > 1 && LEADING.has(words[0])) words.shift(); return words; };
/** What GPT Live says just before a part's name to move there ("let's look at", "now to"). */
// Also "let's look the flow", as GPT Live said after a wake. Not "now" or "next": narrating the agent's work
// ("now the options parser is fixed") would move the page.
const TURNS = [['look', 'at'], ['go', 'to'], ['turn', 'to'], ['move', 'to'], ['jump', 'to'], ['head', 'to'], ['on', 'to'], ['onto'], ['over', 'to'], ['back', 'to'], ['look']];

export class CueMatcher {
  cues: SpeechCue[] = [];
  /** GPT Live's words in the current response, and how far cues have already fired in them. */
  raw = ''; fired = 0; lastAt = 0;
  set(cues: SpeechCue[]) { this.cues = cues.filter(c => c.words.length); }
  /** Adds GPT Live's latest transcript; returns the cues its completed words newly say. */
  hear(delta: string, at = Date.now()): SpeechCue[] {
    // A pause of a few seconds starts a new response.
    if (at - this.lastAt > 4000) { this.raw = ''; this.fired = 0; }
    this.lastAt = at; this.raw += delta;
    const words = normalize(this.raw).split(' ').filter(Boolean);
    // The last word may still be growing ("opt" then "ions") unless the text has moved past it.
    const complete = /[\s.,!?;:)"']$/.test(this.raw) ? words.length : words.length - 1;
    const found: { cue: SpeechCue; end: number }[] = [];
    for (const cue of this.cues) {
      for (let start = 0; start + cue.words.length <= complete; start++) {
        const end = start + cue.words.length;
        if (end <= this.fired || !cue.words.every((w, i) => words[start + i] === w)) continue;
        if (cue.name) {
          // Up to two filler words ("the", "section") between the turning phrase and the name, and "let's"
          // before it: presenting, GPT Live says "let's look at"; relaying the agent's work ("Claude will look
          // at the options parser") it doesn't.
          const before = words.slice(Math.max(0, start - 7), start).filter(w => !LEADING.has(w) && w !== 'part' && w !== 'section');
          const turn = TURNS.find(t => t.every((w, i) => before[before.length - t.length + i] === w));
          if (!turn) continue;
          const lead = before.slice(Math.max(0, before.length - turn.length - 3), before.length - turn.length);
          if (!lead.includes('lets') && !(lead.includes('let') && lead.includes('us'))) continue;
        }
        found.push({ cue, end });
      }
    }
    // In the order spoken; the longest at one place wins ("system map" over "map").
    found.sort((a, b) => a.end - b.end || b.cue.words.length - a.cue.words.length);
    const out: SpeechCue[] = [];
    for (const { cue, end } of found) if (end > this.fired) { out.push(cue); this.fired = end; }
    return out;
  }
}
