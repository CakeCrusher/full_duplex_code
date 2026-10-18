// The low-level settings that decide when and how agent updates reach GPT Live,
// and when voice goes on Standby to save its cost while the conversation is quiet.
// Each one trades the core principles in the README against each other; its
// description says how, from measurements on replayed real sessions, so that
// whoever sets it (a person, or Jev from the operator's instructions) knows
// what a change costs and buys. Defaults are the measured best balance.
import type { Hold } from './observation-feed.ts';

export interface Tuning {
  holdFirstMs: number;
  holdPerUpdateMs: number;
  holdLongestMs: number;
  thinkMs: number;
  pauseMs: number;
  compactTokens: number;
  standbyAfterMs: number;
  wakeThreshold: number;
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
    'Updates may land while the operator is actively talking and wait only once they pause this long (ms). Live runs on two real sessions: at 0, 3–6% of updates landed while the operator spoke (long turns reach the 10 s cap); at 700, 13–14%, but one of two spoken requests per run reached the agent 3–5 s later (4.5 and 6.4 s instead of 1.5 s) and GPT Live talked over the operator longer (6.3 and 2.3 s instead of 4.1 and 0.8 s).',
    levels: [
    { value: 0, consequence: 'Updates wait the whole time the operator talks (default): requests reach the agent fastest and GPT Live talks over the operator least.' },
    { value: 700, consequence: 'About three times as many updates land while the operator talks, for operators who want updates as they speak; some requests reach the agent a few seconds later and GPT Live talks over them a little more.' },
  ] },
  compactTokens: { min: 0, max: 1000000, describe:
    "When one batch's tool work (calls and their outputs) is over this many tokens, it becomes a single line saying which tools ran; the agent's own words, failures, prompts and turn ends still arrive whole. On the same 5.5 minutes of a real session, compacting at 900 halved GPT Live's unprompted talk (147 words instead of 304; 76 s of speech instead of 137) and it never started talking over the operator (twice without compaction), for 14% fewer tokens received. It can only cost questions whose answer is in tool details: 19 of the 55 real operator questions answerable from the session (36 need only the agent's own words). It also makes answers more accurate: replaying 19 real questions, GPT Live answered as many itself either way and was wrong less often with compaction (3 against 8); a text reader on 30 real questions was wrong 6 times at 900, 8 at 300, 13 at 2000 and 10 without compaction (10 with only the agent's words): too little detail and too much both cost accuracy. 1000000 never compacts.",
    levels: [
    { value: 900, consequence: 'Heavy tool work becomes one line (default): calmest speech, fewest wrong answers, longest-lasting context; questions whose answer is in heavy tool output go to the agent.' },
    { value: 3000, consequence: 'Only very heavy tool work becomes one line: more detail reaches GPT Live, but a reader was wrong more often with more detail (13 of 30 at 2000, against 6 at 900).' },
    { value: 1000000, consequence: 'Never compact: GPT Live sees every tool result and can answer the most questions itself; its context fills faster.' },
  ] },
  // Measured by replaying 181 real voice sessions (59 hours, Sep 13 – Oct 18) through activity.ts's prices.
  standbyAfterMs: { min: 0, max: 600000, describe:
    "How long the conversation must stay quiet before voice goes on Standby (ms): GPT Live disconnects and its billing ($0.05 a minute) stops, while the page keeps listening on the operator's computer and fdc keeps watching the agent. The operator speaking, or agent news worth wakeThreshold, reconnects it in about 1-2 s; the operator's first words are buffered and replayed. Quiet means everything that happened in this window (the operator's and GPT Live's speech, agent events, requests) is worth less than wakeThreshold. Someone was speaking 46% of the time in real sessions, so Standby can save at most about a quarter. Each wake starts a new GPT Live session seeded with the conversation's text: the conversation carries over, but only the most recent agent work does. 0 never goes on Standby.",
    levels: [
    { value: 0, consequence: 'Never on Standby: GPT Live stays connected the whole time voice is on, as before; it never has to wake, and it keeps the most agent detail.' },
    { value: 20000, consequence: 'Cheapest: saved 18% of the cost of real sessions, but woke about 14 times an hour: 11 times when the operator spoke into Standby (answered a few seconds later), 2 of them noise.' },
    { value: 30000, consequence: 'The default: saved 14% of the cost of real sessions; woke about 9 times an hour, 7 of them when the operator spoke into Standby (1 of them noise), 1 for agent news.' },
    { value: 60000, consequence: 'Calmer: saved 9%; woke under 4 times an hour.' },
    { value: 120000, consequence: 'Only for long pauses, such as the operator stepping away: saved 5%; woke about once an hour.' },
  ] },
  wakeThreshold: { min: 1, max: 1000, describe:
    "How much activity keeps voice Live, and wakes it from Standby, counted in points over the standbyAfterMs window. Agent events are priced by kind: a tool call or typed prompt 1, an agent message 10, a finished or failed turn or a completed task 30, an approval request or a request GPT Live passes on 100. The operator's speech always reaches the threshold within about half a second of sound, and GPT Live's speech keeps voice Live while it talks. Lower: more agent activity keeps voice Live and wakes it; higher: only bigger news wakes it, and GPT Live stays silent about the rest until the operator speaks. In real sessions it barely changed the cost (14-16% saved at 30 s); it changes what wakes the companion.",
    levels: [
    { value: 1, consequence: 'Any agent activity, every tool call included, wakes it and keeps it Live: GPT Live misses almost nothing it would have said (3 s an hour in real sessions).' },
    { value: 10, consequence: 'The default: agent messages, finished or failed turns and approvals wake it; tool calls add up (ten within the window wake it). GPT Live missed about 10 s of speech an hour.' },
    { value: 30, consequence: 'Only finished or failed turns and approvals wake it, not the agent talking mid-turn: GPT Live missed about 18 s of speech an hour.' },
    { value: 100, consequence: 'Only approval requests (and the operator) wake it: GPT Live missed about 34 s an hour of reports, such as a finished turn, until the operator spoke.' },
  ] },
};

export const DEFAULT_TUNING: Tuning = { holdFirstMs: 1000, holdPerUpdateMs: 1000, holdLongestMs: 10000, thinkMs: 2000, pauseMs: 0, compactTokens: 900, standbyAfterMs: 30000, wakeThreshold: 10 };

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

/** The batching hold the settings describe. */
export const holdOf = ({ holdFirstMs, holdPerUpdateMs, holdLongestMs }: Tuning): Hold => ({ firstMs: holdFirstMs, perUpdateMs: holdPerUpdateMs, longestMs: holdLongestMs });
