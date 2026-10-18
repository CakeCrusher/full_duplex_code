// Jev tuning the companion, optional: on with TYPESAFE_API_KEY and FDC_JEV_TUNING=1.
// Whenever the operator's instructions change (one Jev learned, one they added or
// removed), when voice starts, and after each of the operator's requests, Jev reads
// the instructions, with those it learned in earlier sessions and the operator's
// latest words, and picks a level for each low-level setting (tuning.ts) from what
// that level is measured to cost and buy. The bridge applies the choice at once and logs it.
import { KNOBS, type Tuning } from './tuning.ts';

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export interface TuningChange { name: keyof Tuning; from: number; to: number }

const URL = 'https://api.typesafe.ai/v1/systemone';
const SETTING = "Voice coding session: the operator talks to a voice companion (GPT Live) that answers them, reports on a coding agent's work and passes their requests to the agent. These are the companion's low-level settings for when and how the agent's updates reach it. The core principles, in order: 1 the operator comes first (never lose a work request, don't talk over them); 2 answer the operator's questions instead of delegating them; 3 synthesis, not narration; 4 know as much as possible; 5 fresh enough.";

export class JevTuner {
  apiKey: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  constructor({ apiKey, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.log = log; this.fetch = fetch;
  }
  /** The settings that fit the operator's instructions; a setting Jev gives no valid level for keeps its value. */
  async choose({ instructions, earlier, current, pinned = [], latest }: { instructions: string[]; earlier: string[]; current: Tuning; pinned?: (keyof Tuning)[]; /** What the operator just said. */ latest?: string }): Promise<{ tuning: Tuning; changes: TuningChange[] }> {
    // Settings the operator set by hand are theirs; those without measured levels are set only by hand.
    const knobs = Object.entries(KNOBS).filter(([name, knob]) => !pinned.includes(name as keyof Tuning) && knob.levels.length) as [keyof Tuning, typeof KNOBS[keyof Tuning]][];
    // After a request, the current levels stand unless the operator's words change them: a setting
    // their earlier words changed must not go back on the next unrelated request.
    const ask = latest ? 'Keep the current level unless their instructions, or their latest words, ask for something this setting changes.' : 'Choose the default unless they ask for something this setting changes.';
    const questions = Object.fromEntries(knobs.map(([name, knob]) => [name, {
      type: 'choice',
      instructions: `${knob.describe} Which level fits the operator's instructions and preferences best? ${ask}`,
      criteria: Object.fromEntries(knob.levels.map(level => [`level_${level.value}`, level.consequence])),
    }]));
    const state: Record<string, string> = { setting: SETTING, operator_instructions: instructions.join('\n').slice(0, 4000) || '(none)', earlier_sessions: earlier.join('\n').slice(0, 4000) || '(none)', current_settings: JSON.stringify(current) };
    if (latest) state.operator_latest_words = latest.slice(-600);
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const tuning = { ...current }, changes: TuningChange[] = [];
    for (const [name, knob] of knobs) {
      // No answer is no change (an empty choice would read as level 0).
      const choice = answers?.[name]?.choice;
      if (typeof choice !== 'string' || !/^level_\d+$/.test(choice)) continue;
      const value = Number(choice.slice('level_'.length));
      if (!knob.levels.some(level => level.value === value) || value === current[name]) continue;
      changes.push({ name, from: current[name], to: value }); tuning[name] = value;
    }
    this.log({ type: 'tuning.judged', answers, changes });
    return { tuning, changes };
  }
}
