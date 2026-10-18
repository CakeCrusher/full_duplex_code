// The activity currency behind Standby. Everything that happens in the voice conversation has a
// price, all in one currency with no input privileged: each tenth of a second of the operator's sound
// or of GPT Live's audio, each of the agent's events by kind, each request GPT Live passes on. Voice
// keeps drifting toward Standby: while what happened in the last standbyAfterMs is worth less than
// wakeThreshold, GPT Live disconnects and its billing stops; once it is worth the threshold again, voice
// wakes. The prices, the window and the threshold are settings (tuning.ts).
import type { ObservationKind } from './adapter.ts';
import type { Tuning } from './tuning.ts';

/** What one of the agent's events is worth, by kind: one table for every agent, since all of them share their kinds. */
export function priceOf(tuning: Tuning, kind: ObservationKind) {
  switch (kind) {
    case 'tool': case 'tool_failure': return tuning.toolPrice;
    case 'prompt': return tuning.promptPrice;
    case 'text': return tuning.messagePrice;
    case 'turn_end': case 'task_completed': case 'session_end': return tuning.turnEndPrice;
    case 'turn_failed': return tuning.failurePrice;
    case 'attention': return tuning.approvalPrice;
    default: return 0;
  }
}
/** GPT Live audio playing on the page, as the timeline draws it. */
export const LIVE_SPEECH_RMS = .003;
// Entries are kept as long as the longest window a setting allows.
const KEPT_MS = 600000;

export interface Spend { at: number; value: number; source: string }

export class Activity {
  entries: Spend[] = [];
  add(source: string, value: number, at = Date.now()) {
    if (!(value > 0)) return;
    this.entries.push({ at, value, source });
    let old = 0;
    while (old < this.entries.length && this.entries[old].at <= at - KEPT_MS) old++;
    if (old) this.entries.splice(0, old);
  }
  /** What happened in the last `windowMs` is worth this much. */
  value(windowMs: number, now = Date.now()) {
    let total = 0;
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].at > now - windowMs; i--) total += this.entries[i].value;
    return total;
  }
  /** The newest spend in the window: what tipped it over. */
  latest(windowMs: number, now = Date.now()) { const last = this.entries.at(-1); return last && last.at > now - windowMs ? last : undefined; }
}
