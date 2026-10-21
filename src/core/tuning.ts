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
  // What each input is worth in Standby's currency (activity.ts): speech per tenth of a second of sound, the rest per event.
  speechPrice: number;
  liveSpeechPrice: number;
  toolPrice: number;
  promptPrice: number;
  messagePrice: number;
  turnEndPrice: number;
  failurePrice: number;
  approvalPrice: number;
  requestPrice: number;
}

/** A setting's range, what it does, and the levels Jev chooses among, each with what it costs and buys (none: set only by hand). */
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
  // Standby's settings. Every consequence below was measured by replaying the operator's 181 recorded voice
  // sessions (59 hours, Sep 13 - Oct 18) through Standby's rules, changing one setting at a
  // time from the defaults, which the operator chose in the Standby sandbox (Oct 18).
  standbyAfterMs: { min: 0, max: 600000, describe:
    "Standby's quiet window (ms): how long everything that happens counts in Standby's currency. Each spend counts at full value for exactly this long and then drops out; nothing else decays. Voice keeps drifting toward Standby: once a voice session has been Live for one window, whenever the currency in the window is worth less than wakeThreshold, GPT Live disconnects and its billing ($0.05 a minute) stops, while the page keeps listening and fdc keeps watching the agent. When the currency reaches the threshold again, voice wakes: it resumes the paused GPT Live session (a fork, keeping the whole conversation; 1 to 8.5 s to start, longer as the conversation grows), or starts a new one seeded with the conversation's text (about 1.7 s) when fdc itself was updated since it started or its context is past 60%, and the operator's held words are replayed to it first. GPT Live bills each session at least 15 s, so a window under 15 s saves nothing on a session that wakes for little. This window is the main lever on cost and on how often voice wakes: shorter saves more and wakes more, disconnecting during the operator's pauses; longer saves less, wakes less and stays connected through pauses. A resumed wake keeps everything; a new one drops agent details older than the startup history. Someone was speaking 46% of the time in recorded conversations, so Standby can save at most about a quarter. Choose shorter when the operator asks to save money or says voice costs too much; longer when they say it keeps disconnecting or waking up, or answers late after a pause; 0 only when they ask for voice never to pause.",
    levels: [
    { value: 0, consequence: 'Never on Standby: voice stays connected and billed the whole time it is on, as before Standby. Nothing wakes and GPT Live misses nothing.' },
    { value: 10000, consequence: "Cheapest: saved 26% of the cost of recorded conversations, but woke 26 times an hour (4.5 of them for noise), and GPT Live missed 84 s an hour of what it would have said. A 10 s pause while the operator thinks disconnects it." },
    { value: 15000, consequence: 'The default, the operator\'s choice: saved 21%, woke 18 times an hour (3.3 of them for noise); GPT Live missed 52 s an hour of what it would have said.' },
    { value: 20000, consequence: 'Saved 18%, woke 13 times an hour (2.4 for noise); GPT Live missed 34 s an hour.' },
    { value: 30000, consequence: 'Saved 14%, woke 8 times an hour (1.6 for noise); GPT Live missed 19 s an hour.' },
    { value: 60000, consequence: 'Saved 8%, woke 3 times an hour (0.7 for noise); GPT Live missed 3 s an hour. It rarely disconnects except when the operator steps away.' },
    { value: 120000, consequence: 'Saved 5%, woke less than once an hour: only long absences disconnect it.' },
  ] },
  wakeThreshold: { min: 1, max: 1000, describe:
    "How much currency in the quiet window keeps voice Live, and wakes it from Standby. Everything is priced in one currency by the price settings, by default: each tenth of a second of the operator's sound or of GPT Live's audio 20; each display batch of an agent message 10 (a message is usually about 3 batches); a finished turn 30; a failed turn 30; an approval request 100; a request GPT Live passes on 100; a tool call or a prompt 1. At the default 50: about 0.3 s of the operator's sound wakes it; an approval or a request always does; a finished turn does when its final message comes with it (30 plus 10 a batch), but a turn end with a one-batch message (40) does not; tool calls practically never do (50 within the window). Higher: voice is on Standby more and wakes less often for noise, but more finished turns wait silently until the operator speaks, and GPT Live misses more of what it would have said; above 100 even an approval request no longer wakes it. Lower: the reverse. Choose higher when the operator says it wakes up for nothing, for coughs or noises; lower when they say they missed that the agent finished, or want to hear about its work right away.",
    levels: [
    { value: 10, consequence: 'Any agent message, finished turn, or tenth of a second of sound wakes it: saved 18%, 5.0 wakes an hour for noise; GPT Live missed 22 s an hour; every finished turn is reported at once.' },
    { value: 30, consequence: 'A finished turn alone wakes it, or 0.2 s of sound: saved 20%, 4.1 noise wakes an hour; GPT Live missed 45 s an hour.' },
    { value: 50, consequence: 'The default: 0.3 s of sound, a finished turn with its message, an approval or a request wakes it: saved 21%, 3.3 noise wakes an hour; GPT Live missed 52 s an hour; 0.1 finished turns an hour waited silently.' },
    { value: 80, consequence: 'It takes 0.4 s of sound, an approval or a request; a finished turn only with a long message: saved 23%, 2.7 noise wakes an hour, but 1.5 finished turns an hour waited silently until the operator spoke; GPT Live missed 85 s an hour.' },
    { value: 100, consequence: 'It takes 0.5 s of sound, an approval or a request: saved 24%, 2.4 noise wakes an hour; 2 finished turns an hour waited silently; GPT Live missed 95 s an hour.' },
    { value: 150, consequence: 'It takes 0.8 s of sound or several agent events together, and an approval request alone no longer wakes it: saved 27%, 2.0 noise wakes an hour; 3 finished turns an hour waited silently; GPT Live missed 126 s an hour.' },
  ] },
  speechPrice: { min: 0, max: 1000, describe:
    "What each tenth of a second of the operator's microphone sound that passes the noise gate is worth in Standby's currency. Sound includes noise the gate lets through: a cough, a door, typing near the microphone. With the threshold at 50, the default 20 means about 0.3 s of sound wakes voice and keeps it Live. Lower: it takes longer sound to wake it, so fewer noise wakes, but voice also stays Live less after the operator stops talking. Higher: the slightest sound wakes it. Choose lower when the operator complains that noise or coughs wake it; higher when they say it doesn't notice them start speaking.",
    levels: [
    { value: 5, consequence: 'About 1 s of sound wakes it: saved 24%, 1.7 noise wakes an hour; GPT Live missed 70 s an hour.' },
    { value: 10, consequence: 'About 0.5 s of sound: saved 22%, 2.3 noise wakes an hour; GPT Live missed 60 s an hour.' },
    { value: 20, consequence: 'The default: about 0.3 s of sound: saved 21%, 3.3 noise wakes an hour.' },
    { value: 30, consequence: 'About 0.2 s of sound: saved 20%, 4.1 noise wakes an hour.' },
    { value: 50, consequence: 'Any tenth of a second of sound, a click or a knock included: saved 19%, 5.3 noise wakes an hour.' },
  ] },
  liveSpeechPrice: { min: 0, max: 1000, describe:
    "What each tenth of a second of GPT Live's audio is worth in Standby's currency. It keeps voice Live while GPT Live talks and for the window after, so Standby never begins mid-answer. GPT Live can't talk on Standby, so this never wakes it. At the defaults it barely changes anything (21% saved at 5, 20 or 50). Keep the default unless the operator says GPT Live gets cut off while answering; then raise it.",
    levels: [
    { value: 5, consequence: 'Saved 21%, 18.3 wakes an hour: a short answer counts for less, so Standby follows it a little sooner.' },
    { value: 20, consequence: 'The default: saved 21%, 17.7 wakes an hour.' },
    { value: 50, consequence: 'Saved 21%, 17.6 wakes an hour: no practical difference from the default.' },
  ] },
  toolPrice: { min: 0, max: 1000, describe:
    "What each of the agent's tool calls and results, failed ones included, is worth in Standby's currency. At the default 1, it would take 50 within the window: tool calls practically never keep voice Live or wake it, so GPT Live stays on Standby while the agent works quietly and hears about the work when its message or turn end arrives. Higher: busy agent work keeps voice Live and wakes it, so GPT Live follows the work as it happens and misses less of what it would have said, for a little less saved. Choose higher when the operator wants running commentary on the agent's work; keep low when they want quiet until results.",
    levels: [
    { value: 0, consequence: 'Tool calls never count: the same as 1 in practice (21% saved).' },
    { value: 1, consequence: 'The default: tool calls hardly count: saved 21%; GPT Live missed 52 s an hour.' },
    { value: 5, consequence: 'Ten tool calls in the window wake it: saved 20%; GPT Live missed 39 s an hour.' },
    { value: 10, consequence: 'Five tool calls in the window wake it: saved 19.5%; GPT Live missed 24 s an hour.' },
  ] },
  promptPrice: { min: 0, max: 1000, describe:
    "What each prompt the agent receives is worth in Standby's currency: one typed in its terminal, or a request delivered by voice (the voice request itself is priced by requestPrice). At the default 1 it barely counts. At 50 a prompt typed in the terminal wakes voice, so GPT Live follows what the operator types. Choose higher when the operator says GPT Live should notice what they type.",
    levels: [
    { value: 1, consequence: 'The default: prompts barely count: saved 21%.' },
    { value: 10, consequence: 'Saved 21%: no practical difference from the default.' },
    { value: 50, consequence: 'A typed prompt wakes voice: saved 20.4%; GPT Live missed 42 s an hour instead of 52.' },
  ] },
  messagePrice: { min: 0, max: 1000, describe:
    "What each display batch of an agent message is worth in Standby's currency (Claude shows a message in about 3 batches). With the threshold at 50, a message alone rarely wakes voice (5 batches), but a finished turn's final message together with its turn end (30) does: that is how GPT Live hears that the agent finished. Higher: the agent's messages wake voice as they come, mid-turn included. Lower: fewer wakes, and at 0 finished turns often wait silently until the operator speaks. Choose higher when the operator wants to hear the agent's messages as they arrive; never 0 unless they ask for silence until they speak.",
    levels: [
    { value: 0, consequence: 'Messages never count: saved 23%, but 1.8 finished turns an hour waited silently until the operator spoke, and GPT Live missed 91 s an hour.' },
    { value: 10, consequence: 'The default: a final message with its turn end wakes it: saved 21%; 0.1 finished turns an hour waited silently.' },
    { value: 30, consequence: 'Longer messages wake it mid-turn: saved 20.6%; GPT Live missed 47 s an hour.' },
    { value: 50, consequence: 'Every message wakes it: saved 19.9%; GPT Live missed 31 s an hour.' },
  ] },
  turnEndPrice: { min: 0, max: 1000, describe:
    "What the agent finishing its turn (or completing a task, or its session ending) is worth in Standby's currency. At the default 30, with its final message it reaches the threshold of 50, so a finished turn wakes voice and GPT Live reports it. At 50 or more a turn end alone wakes it, even without a message. Lower: finished turns wait silently. Choose 50 when the operator says they want to hear every time the agent finishes; lower only if they ask not to be told until they ask.",
    levels: [
    { value: 10, consequence: '1.1 finished turns an hour waited silently until the operator spoke; saved 21.7%.' },
    { value: 30, consequence: 'The default: a finished turn with its message wakes it; 0.1 an hour waited silently; saved 21%.' },
    { value: 50, consequence: 'Every finished turn wakes it, message or not: saved 21%; none waited silently.' },
  ] },
  failurePrice: { min: 0, max: 1000, describe:
    "What the agent's turn failing is worth in Standby's currency. Failed turns were rare in recorded conversations: no measurable effect on cost between 10 and 100. At the default 30, a failure with its error message wakes voice; at 50 or more a failure alone does. Choose 50 or more when the operator wants to hear about failures at once.",
    levels: [
    { value: 30, consequence: 'The default: a failure with its error message wakes it.' },
    { value: 50, consequence: 'Every failure wakes it at once; no measurable cost.' },
  ] },
  approvalPrice: { min: 0, max: 1000, describe:
    "What the agent needing the operator is worth in Standby's currency: an approval, a question, a denial. At the default 100, above the threshold of 50, it always wakes voice, so GPT Live can tell the operator the agent is waiting. Rare in recorded conversations, so no measurable cost. Keep it at or above the threshold; lower it only if the operator says not to be woken for approvals.",
    levels: [
    { value: 30, consequence: 'An approval request alone no longer wakes it: the agent can wait for the operator unnoticed until they speak.' },
    { value: 100, consequence: 'The default: an approval request always wakes it.' },
  ] },
  requestPrice: { min: 0, max: 1000, describe:
    "What a request GPT Live passes on to the agent is worth in Standby's currency. It keeps voice Live for the window after a request, so GPT Live can tell the operator what comes of it. Requests come with the operator's speech, which already keeps voice Live, so it barely changes cost (21% saved from 30 to 100). Keep the default.",
    levels: [
    { value: 30, consequence: 'Saved 21%, 18 wakes an hour: no practical difference from the default.' },
    { value: 100, consequence: 'The default: a request keeps voice Live for the window after it.' },
  ] },
};

// Standby's defaults are the operator's choice in the Standby sandbox (Oct 18).
export const DEFAULT_TUNING: Tuning = { holdFirstMs: 1000, holdPerUpdateMs: 1000, holdLongestMs: 10000, thinkMs: 2000, pauseMs: 0, compactTokens: 900, standbyAfterMs: 15000, wakeThreshold: 50,
  speechPrice: 20, liveSpeechPrice: 20, toolPrice: 1, promptPrice: 1, messagePrice: 10, turnEndPrice: 30, failurePrice: 30, approvalPrice: 100, requestPrice: 100 };

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
