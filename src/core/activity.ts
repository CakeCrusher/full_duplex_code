// The activity currency behind Standby. Everything that happens in the voice conversation has a
// price: the operator's speech, GPT Live's speech, the agent's events by kind, and requests GPT Live
// passes on. While what happened in the last standbyAfterMs is worth less than wakeThreshold, voice
// goes on Standby (GPT Live disconnects and its billing stops); once it is worth the threshold again,
// voice wakes. The window and the threshold are settings (tuning.ts), set by hand or by Jev.
import type { ObservationKind } from './adapter.ts';

/** The agent's events by kind: one table for every agent, since all of them share their kinds. */
export const PRICES: Record<ObservationKind, number> = {
  tool: 1, prompt: 1, tool_failure: 1, event: 0,
  text: 10,
  turn_end: 30, turn_failed: 30, task_completed: 30, session_end: 30,
  attention: 100,
};
/** A request GPT Live passes on: always worth a wake. */
export const REQUEST_PRICE = 100;
// Speech, per microphone level report from the page (about 0.1 s each). GPT Live's is worth the
// threshold, so it stays Live while it talks; the operator's a fifth of it, so about half a second of
// sound reaches the threshold and a click or a knock doesn't.
export const operatorSpeechPrice = (threshold: number) => threshold / 5;
export const liveSpeechPrice = (threshold: number) => threshold;
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
