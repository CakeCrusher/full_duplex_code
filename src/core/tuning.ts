// The low-level settings that decide when and how agent updates reach GPT Live.
// Each one trades the core principles in the README against each other; its
// description says how, from measurements on replayed real sessions, so that
// whoever sets it (a person, or Jev from the operator's instructions) knows
// what a change costs and buys. Defaults are the measured best balance.
export interface Tuning {
  holdFirstMs: number;
  holdPerUpdateMs: number;
  holdLongestMs: number;
  thinkMs: number;
  pauseMs: number;
  compactTokens: number;
}

/** A setting's range, what it does, and the levels Jev chooses among, each with what it costs and buys. */
export interface Knob { min: number; max: number; describe: string; levels: { value: number; consequence: string }[] }

export const KNOBS: Record<keyof Tuning, Knob> = {
  holdFirstMs: { min: 0, max: 5000, describe:
    'How long the first agent update of a quiet stretch waits for more before going to GPT Live (ms). Longer turns bursts into fewer, larger batches: GPT Live speaks less often and more coherently (5 Fresh enough pays). 0 sends each update at once.',
    levels: [
    { value: 500, consequence: 'Fresher: updates arrive about half a second sooner; GPT Live gets more, smaller batches and remarks more often.' },
    { value: 1000, consequence: 'The measured balance (default).' },
    { value: 2000, consequence: 'Calmer: fewer, larger batches and fewer unprompted remarks; updates arrive about a second later.' },
  ] },
  holdPerUpdateMs: { min: 0, max: 5000, describe:
    'How much each further update in a burst extends the wait (ms), up to holdLongestMs. Higher groups a flood into one batch; lower keeps updates fresher.',
    levels: [
    { value: 500, consequence: 'A burst goes in sooner, in smaller pieces.' },
    { value: 1000, consequence: 'The measured balance (default).' },
    { value: 2000, consequence: 'A burst is gathered longer into one batch: calmer, less fresh.' },
  ] },
  holdLongestMs: { min: 0, max: 30000, describe:
    'The longest any agent update waits, also while the operator talks (ms). This caps staleness: at 10000 the slowest update arrived within 10 s and the median within about 2 s on real sessions.',
    levels: [
    { value: 5000, consequence: 'No update waits more than 5 s, also while the operator talks: fresher, but more of them land around the operator\'s speech.' },
    { value: 10000, consequence: 'No update waits more than 10 s (default): median wait about 2 s on real sessions.' },
    { value: 20000, consequence: 'For operators who talk at length: updates can wait up to 20 s rather than land while they speak.' },
  ] },
  thinkMs: { min: 0, max: 5000, describe:
    'How long after the operator stops talking agent updates keep waiting (ms). GPT Live decides whether to pass a request on 0.6–1 s after the operator stops; every request it dropped in live tests had an update land in that second (0 of 14 requests reached the agent in time without this wait, 31 of 32 with 2000). Lower: fresher updates, more risk to 1 You come first.',
    levels: [
    { value: 1000, consequence: 'Updates resume 1 s after the operator stops: fresher, but they can land while GPT Live decides whether to pass a request on, which dropped requests in live tests.' },
    { value: 2000, consequence: 'The measured balance (default): 31 of 32 requests reached the agent on time in live tests.' },
    { value: 3000, consequence: 'Agent updates, which can prompt GPT Live to speak up, wait 3 s after the operator stops: fewer interruptions for operators who pause mid-thought, think aloud, or ask not to be cut off.' },
  ] },
  pauseMs: { min: 0, max: 2000, describe:
    'Updates may land while the operator is actively talking and wait only once they pause this long (ms). 0 holds updates for the whole time they talk: on 54 real sessions 0.9% of batches landed while they spoke and 1.6% in the second after. 700 lets 13.6% land mid-speech, which a full-duplex model handles, but 7.7% landed in the risky second after.',
    levels: [
    { value: 0, consequence: 'Updates wait the whole time the operator talks (default).' },
    { value: 700, consequence: 'Updates may land while the operator is talking and wait once they pause: more updates reach GPT Live during long turns.' },
  ] },
  compactTokens: { min: 0, max: 1000000, describe:
    "When one batch's tool work (calls and their outputs) is over this many tokens, it becomes a single line saying which tools ran; the agent's own words, failures, prompts and turn ends still arrive whole. Lower: more coherent speech and a context that lasts longer, but GPT Live can answer fewer of the operator's questions itself (2 Answer instead of delegating, 4 Know as much as possible). 1000000 never compacts.",
    levels: [
    { value: 900, consequence: 'Heavy tool work becomes one line: calmest speech, longest-lasting context, fewest questions answered without the agent.' },
    { value: 3000, consequence: 'Only very heavy tool work becomes one line.' },
    { value: 1000000, consequence: 'Never compact: GPT Live sees every tool result and can answer the most questions itself; its context fills faster.' },
  ] },
};

export const DEFAULT_TUNING: Tuning = { holdFirstMs: 1000, holdPerUpdateMs: 1000, holdLongestMs: 10000, thinkMs: 2000, pauseMs: 0, compactTokens: 900 };

/** Settings from partial overrides: unknown names and values out of range are refused. */
export function tuning(overrides: unknown = {}, base: Tuning = DEFAULT_TUNING): Tuning {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Tuning must be an object of setting names and numbers.');
  const result = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    const knob = KNOBS[name as keyof Tuning];
    if (!knob) throw new Error(`Unknown tuning setting: ${name}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < knob.min || value > knob.max) throw new Error(`${name} must be a number from ${knob.min} to ${knob.max}.`);
    result[name as keyof Tuning] = value;
  }
  return result;
}
