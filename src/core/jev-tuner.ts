// Jev tuning the companion, optional: on with TYPESAFE_API_KEY and FDC_JEV_TUNING=1.
// Whenever the operator's instructions change (one Jev learned, one they added or
// removed), when voice starts, and with every reading of the operator's words (jev.ts), Jev
// reads the instructions, with those it learned in earlier sessions and the conversation,
// and picks a level for each low-level setting (tuning.ts) from what that level is measured
// to cost and buy. The bridge applies the choice at once and logs it.
import { KNOBS, type Tuning } from './tuning.ts';

export interface TuningChange { name: keyof Tuning; from: number; to: number }

export const TUNER_SETTING = "The companion's low-level settings decide when and how the agent's updates reach it, and Standby: voice costs $0.05 a minute while the companion is connected, and Standby disconnects it while the conversation is quiet, at the price of waking it again. Each setting describes, with measurements from the operator's own recorded conversations, what each level costs and buys and which of the operator's words call for it; `operator_instructions` are the companion's instructions in force, `earlier_sessions` those from the operator's earlier sessions, `current_settings` the levels now. The core principles, in order: 1 the operator comes first (never lose a work request, don't talk over them); 2 answer the operator's questions instead of delegating them; 3 synthesis, not narration; 4 know as much as possible; 5 fresh enough.";

/** Settings the operator set by hand are theirs; those without measured levels are set only by hand. */
const knobs = (pinned: (keyof Tuning)[]) => Object.entries(KNOBS).filter(([name, knob]) => !pinned.includes(name as keyof Tuning) && knob.levels.length) as [keyof Tuning, typeof KNOBS[keyof Tuning]][];

/** One choice per setting. With the operator's words to read, the current levels stand unless they ask for a change: a setting their earlier words changed must not go back on the next unrelated request. */
export function tunerQuestions(current: Tuning, pinned: (keyof Tuning)[] = [], words = true) {
  const ask = words ? 'Keep the current level unless their instructions, or their latest words, ask for something this setting changes.' : 'Choose the default unless they ask for something this setting changes.';
  return Object.fromEntries(knobs(pinned).map(([name, knob]) => [name, {
    type: 'choice',
    instructions: `${knob.describe} Which level fits the operator's instructions and preferences best? ${ask}`,
    criteria: Object.fromEntries(knob.levels.map(level => [`level_${level.value}`, level.consequence])),
  }]));
}

// A setting changes only when Jev prefers another level to the current one by this much. Asked with every reading of the
// operator's words (Oct 21, 150 real turns), 21 of its 22 changes were near coin tosses between the current level and
// the next (.42-.61 against .38-.49, never more than .23 apart), from words like "Okay, sounds good. Next"; the
// operator's own "increase the time it takes to go to sleep to one minute" chose its level at .65 against .09.
export const TUNE_MARGIN = .3;
/** The settings Jev's answers choose; a setting it gives no valid level for, or no clear preference over its current one, keeps its value. */
export function tuningFrom(answers: Record<string, any> | undefined, current: Tuning, pinned: (keyof Tuning)[] = []): { tuning: Tuning; changes: TuningChange[] } {
  const tuning = { ...current }, changes: TuningChange[] = [];
  for (const [name, knob] of knobs(pinned)) {
    // No answer is no change (an empty choice would read as level 0).
    const choice = answers?.[name]?.choice, likely = answers?.[name]?.probabilities;
    if (typeof choice !== 'string' || !/^level_\d+$/.test(choice)) continue;
    const value = Number(choice.slice('level_'.length));
    if (!knob.levels.some(level => level.value === value) || value === current[name]) continue;
    if (likely && Number(likely[choice] ?? 0) - Number(likely[`level_${current[name]}`] ?? 0) < TUNE_MARGIN) continue;
    changes.push({ name, from: current[name], to: value }); tuning[name] = value;
  }
  return { tuning, changes };
}
