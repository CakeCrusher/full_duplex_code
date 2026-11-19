// The operator's turn, read by one request (jev.ts, trigger turn) that asks everything the voice tool decides about
// their words. It is made twice, the same both times, with what is so at that moment (the operator's rule, Nov 17:
// "one request… both identical, with the same information… they make all decisions"), and each decision is acted on
// once, from the first request that has what it takes:
// - As GPT Live begins to answer, or asks to pass their words on (pageTurn): the page, which must not wait for the
//   companion to finish talking. What they ask for that a command of the page does (choose, set, add, place, show),
//   the voice tool does there, one command after another (presenter.ts).
// - Once the conversation has gone quiet (quietTurn; mediator.ts, the setting quietMs): everything else, from their
//   turn whole and all the companion said in reply. The voice tool keeps the goal they set (what they want shown,
//   taught or walked through) apart from the page, and, with those features on (features.ts), turns voice sessions on
//   or off (sessions.ts), leaves the companion's own behavior to the learner and the tuner (they take this reading),
//   and finds what the operator's instructions keep from the agent. Then whether their words go to the coding agent:
//   the reply shows what the companion could handle itself, and the request says what was done on the page. Words not
//   finished wait for the next quiet, which reads them with what the operator adds; never dropped. Keeping work from
//   the agent is the costly mistake; GPT Live passes nothing on.
// When only the companion spoke since the last reading (voiceTurn; jev.ts, trigger voice): whether what it said leaves
// something with the agent. That is how it asks the agent for anything, and how a reply that came after the turn's
// reading (or went on after a pause) is read.
// What each request led to is added to its call's record (jev-audit.ts).
// Until Nov 18 everything but the sending was decided as the turn ended, from words that were often a fragment: GPT
// Live's "'Kay" or "Mm-hmm, yeah" while the operator was still talking ended their turn, and their goal became ". I"
// and "things". The sending was decided after the reply's first sentence (jev.ts, sending). Until Nov 17 the two
// moments asked different questions; from Oct 30 to Nov 17 the operator's words ran nothing on the page (it followed
// only what the voice said): asked for an order of several settings, the voice said "Sure.", passed it on, and the
// agent made the changes (jev.ts, pageQuestions).
import type { Harness } from './bridge.ts';
import type { Decision } from './mediator.ts';
import type { StageCommand, StageView } from './stage.ts';
import type { Spoken, SpokenRequest } from './voice-history.ts';
import { ADDS, ASKED, COMPANION_ONLY, GOAL, NEEDS_AGENT, NOW, PAGE_ASKED, PRESS, READY, RECENT_MS, SETTLED, STAYS, WITHHELD, type Reading } from './jev.ts';
import { companionNoted, handledNote, lookingNote, sessionsChanging } from './prompts.ts';

type Done = (StageCommand & { shown?: string })[];
/** A command that ran on the page, and whether the operator asked for it (presenter.ts). */
export type Ran = { command: Done[number]; asked: boolean }[];
/** What the voice tool did on the page for the operator's words (presenter.ts, carryOut): the commands that ran, with what the page answered, and what GPT Live hears of it, without waiting. */
export interface Did { told: string; done: Done }
/** The page as the turn's first request left it, for the quiet's: the view it read, and whether it read the operator's latest words (their page request is then not acted on again). */
export interface Early { view?: StageView; read?: boolean }

/**
 * What the mediator knows of a turn when a request is made for it (mediator.ts): all the operator is saying when words
 * of an earlier quiet still wait undecided (they had not finished); whether those have waited too long, or an earlier
 * reading of them found they need the agent; and the request that last went to the agent from this connection: how
 * long ago, and the words in it.
 */
export interface Waiting { saying?: string; overdue?: boolean; needed?: boolean; sent?: { ago: number; said: string; id: string } }

/**
 * Moments after a request reached the agent, Jev is also asked whether these words add to it: its tail, a repeat, an
 * acknowledgment or noise stays with the voice (jev.ts, ADDS). Not for words already found to need the agent. Where
 * that request is now is the outbox's to say: still held for the turn's end, or not known to have arrived (then a
 * repeat of it must go).
 */
function recentRequest(bridge: Harness, { sent, needed }: Waiting) {
  const state = sent && bridge.outbox.get(sent.id)?.state;
  return sent && sent.ago <= RECENT_MS && !needed && state !== 'uncertain' ? { ago: sent.ago, said: sent.said, held: state === 'held' } : undefined;
}
/** The request for the operator's turn: the same each time it is made, with what is so then (the companion's reply so far, the page and what was done on it, the agent's state). */
function readTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], made: 'ended' | 'quiet', waiting: Waiting,
  { reply, view, done, fork }: { reply?: string; view?: StageView; done?: Done; fork?: 'main' | 'fork' }) {
  const recent = recentRequest(bridge, waiting);
  // While the agent is in the middle of a turn it can be steered in, Jev is also asked whether these words must reach it
  // now or can wait for the turn to end (jev.ts, NOW): fdc then holds them until it does (outbox.ts).
  const working = bridge.agent.profile.canSteer ? bridge.agentWorking() : undefined;
  // Read at every request: a companion slower than 300 ms is listed as not answering.
  return Promise.resolve(bridge.features.has('orchestration') ? bridge.sessionSwitch.sessions(300) : undefined).then(sessions => bridge.read({ trigger: 'turn', made, spoken, reply, sessions, page: view, ...done?.length && { done }, requestId: request.id, ...waiting.saying && { saying: waiting.saying },
    ...recent && { sent: recent }, ...working !== undefined && { working }, ...fork && { fork } }).then(reading => ({ reading, sessions })));
}
/** The page on the stage: read for what the operator asks of it, for the job delegation (what its controls can do) and for the agent (what the user was looking at). */
const pageNow = (bridge: Harness) => bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; });
/**
 * What they ask for now that a command of the page does, the voice tool does there, and GPT Live hears what it did.
 * Only what they ask for: a remark about the page, a question, or "walk me through it" (the companion leads) runs
 * nothing; nor do words that ask for voice sessions to be turned on or off.
 */
const carry = (bridge: Harness, reading: Reading, view: StageView | undefined, spoken: Spoken[]) =>
  view && reading.page?.command && (reading.page.asked ?? 1) >= PAGE_ASKED && (reading.sessions?.asked ?? 0) < ASKED ? bridge.presenter.carryOut(reading, view, spoken) : undefined;

/** The turn's request as GPT Live begins to answer: what the operator asks of the page is done there. */
export async function pageTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], waiting: Waiting & { reply?: string } = {}): Promise<{ view?: StageView; did?: Did }> {
  const view = await pageNow(bridge);
  const { reading } = await readTurn(bridge, request, spoken, 'ended', waiting, { reply: waiting.reply, view, fork: forkMoment(bridge) });
  bridge.log({ type: 'turn.read', said: request.fresh.slice(-200), ...reading.page?.asked !== undefined && { asked: reading.page.asked } });
  const did = await carry(bridge, reading, view, spoken);
  bridge.jevAudit?.decided(reading.id, { ...reading.page?.command && { page: did ? 'done' : 'not run' } }, true);
  return { view, did };
}

/**
 * Where a fork decision stands (jev.ts): the main session in focus (words can go to a fork), or a fork in focus (the
 * operator can move back). Whether the agent is working is not part of it (the operator, Nov 18: "it should only be
 * conditioned on what jev thinks"): until then a fork opened only in the middle of the main session's turn.
 */
const forkMoment = (bridge: Harness) => !bridge.forks.possible ? undefined : bridge.forks.focus === 'fork' ? 'fork' as const : 'main' as const;
/** With a fork open, words Jev reads as a question from this likelihood stay with it: STAYS, or the setting that opens a fork if that is lower (what opens a fork stays in one). */
const stays = (bridge: Harness) => Math.min(STAYS, bridge.tuning.forkFrom);
/** When the operator last spoke: a request is cut up to their latest words, so words said since a reading began would go with the ones it read. */
const heardAt = (bridge: Harness) => bridge.mediator?.history.lastInputAt ?? 0;
/**
 * Words on their way to the agent that Jev read as belonging in a fork (from the setting forkFrom, tuning.ts) go to
 * one, opened now: what the voice is told. Not when the operator has gone on speaking since the reading began
 * (`since`): what they added is unread, and may be work.
 */
async function openFork(bridge: Harness, reading: Reading, since: number) {
  if ((reading.tangent ?? 0) < bridge.tuning.forkFrom || heardAt(bridge) > since) return undefined;
  const told = await bridge.forks.start(reading.said);
  if (told) bridge.jevAudit?.decided(reading.id, { fork: bridge.forks.focus === 'fork' ? 'opened' : 'failed' });
  return told;
}

/**
 * The turn's request once the conversation has gone quiet: what the voice tool does itself with the operator's words,
 * and whether they go to the coding agent. `ran` is what ran on the page since their words began: for them, and as
 * the companion replied.
 */
export async function quietTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], reply: string | undefined, ran: Ran = [], early: Early = {}, waiting: Waiting = {}): Promise<Decision> {
  const { overdue = false, needed: neededBefore = false } = waiting, recent = recentRequest(bridge, waiting), done = ran.map(r => r.command);
  const since = heardAt(bridge);
  // The page as it is now: what the voice tool did on it for these words changed what its commands offer.
  const view = done.length || !early.view ? await pageNow(bridge) ?? early.view : early.view;
  let fork = forkMoment(bridge);
  const { reading, sessions } = await readTurn(bridge, request, spoken, 'quiet', waiting, { reply, view, done, fork });
  // What the voice tool does itself. Voice sessions first: the operator's instructions in force keep words like these
  // from the agent (withheld), and words only about how the companion behaves are the learner's and the tuner's.
  const asked = sessions && bridge.sessionSwitch.act(reading, sessions);
  const companion = (reading.companionOnly ?? 0) >= COMPANION_ONLY, withheld = (reading.withheld ?? 0) >= WITHHELD;
  // The page, when GPT Live never began to answer these words: nothing read it for them yet.
  const did = early.read ? undefined : await carry(bridge, reading, view, spoken);
  // A goal they set replaces the one before; one they end is gone.
  const goal = reading.goal && reading.goal.choice !== 'keep' && reading.goal.p >= GOAL ? reading.goal.choice : undefined;
  if (goal) bridge.voiceSessions.setGoal(goal === 'done' ? undefined : request.fresh, { walk: goal === 'walk' });
  const handled = asked ? 'sessions' : companion ? 'companion' : undefined, didAsked = ran.some(r => r.asked) || Boolean(did);
  // Forks (forks.ts). With a fork in focus, words that are no question for it move the focus back to the main session,
  // before anything is sent, when the operator has left the fork's matter (not while its answer is still on the way: an
  // "okay" then answers the voice). Words on their way to the agent open a fork, or move back, as they are sent.
  const left = fork === 'fork' && (reading.tangent ?? 1) < stays(bridge) && (reading.settled ?? 0) >= SETTLED && !bridge.forks.busy ? bridge.forks.back('the operator moved on') : undefined;
  if (left) fork = undefined;
  // Words that add nothing to a request held for the turn's end still go when they press for it ("no, send it now"):
  // steered in, they bring the held request with them (outbox.ts).
  const adds = reading.adds === undefined || reading.adds >= ADDS || Boolean(recent?.held && (reading.now ?? 0) >= PRESS);
  // Once found to need the agent, waiting words keep needing it: a later reading of the whole stretch never drops them
  // (read with the talk around them, a request was sometimes found to need nothing and waited minutes for another).
  // Not words that are only about how the companion behaves: read for the agent anyway, "I want you to be in full
  // control. I don't want you delegating to Claude Code" went to Claude at .48 (Nov 17).
  const needed = !companion && (neededBefore || ((reading.needsAgent ?? 1) >= NEEDS_AGENT && adds)), ready = (reading.ready ?? 1) >= READY;
  // They went on speaking while it was read, so they haven't finished: nothing is sent yet, and the next quiet reads
  // these words with what they add. Sent at once, they went in pieces ("Actually, I like the soft shapes one the"
  // reached Codex a second after the turn ended, Oct 29, while the operator went on about the rim and the face).
  const continued = heardAt(bridge) > since;
  // Sent once the operator has finished saying it and stopped, or once it has waited too long (mediator.ts, HELD_CAP_MS).
  const send = needed && ((ready && !continued) || overdue);
  // Not finished, or still being said: no decision yet. The next reading takes these words with what the operator adds, or
  // they go once the conversation stays quiet (mediator.ts). There is a next time, so a pause is no reason to send half a request.
  const wait = !send && (needed || continued);
  // Forks, as the words are sent: words that belong in a fork open one (it is free, so nothing is held). With a fork in
  // focus, words for the agent that are no question for it are the main session's: back at once, also while they wait
  // for the operator to finish, since waiting words go later without another reading (mediator.ts, sendHeld).
  const forked = send && fork === 'main' ? await openFork(bridge, reading, since) : undefined;
  const returned = (send || needed) && fork === 'fork' && (reading.tangent ?? 1) < stays(bridge) ? bridge.forks.back('work goes to the main session') : undefined;
  // Held only on Jev's clear word that it can wait; words that waited already (overdue, or found needed before) go in now.
  const later = send && !forked && !overdue && !neededBefore && reading.now !== undefined && reading.now < NOW;
  bridge.log({ type: 'turn.job', said: request.fresh.slice(-200), reply: reply?.slice(-200) ?? null, needsAgent: reading.needsAgent, ready: reading.ready, companionOnly: reading.companionOnly, withheld: reading.withheld, ...reading.adds !== undefined && { adds: reading.adds }, ...reading.now !== undefined && { now: reading.now }, send, ...later && { later }, ...wait && { wait }, ...continued && { continued }, ...overdue && { overdue } });
  bridge.jevAudit?.decided(reading.id, { outcome: send ? 'send' : wait ? 'wait' : 'keep', ...(left || returned) && { fork: 'back' }, needed, ...sessions && { sessions: asked?.told ?? false }, ...reading.companionOnly !== undefined && { companionOnly: companion }, ...reading.withheld !== undefined && { withheld },
    ...!early.read && reading.page?.command && { page: did ? 'done' : 'not run' }, ...goal && { goal }, finished: ready, ...reading.adds !== undefined && { adds }, ...reading.now !== undefined && { delivery: later ? 'follow-up' : 'steer' }, ...neededBefore && { neededBefore }, ...continued && { continued }, ...overdue && { overdue } });
  const told = [asked && sessionsChanging(asked.told), companion && companionNoted(bridge.agent, bridge.features), left, forked ?? returned].filter(Boolean).join(' ') || undefined;
  return { reading, send, later, wait, needed: wait && needed, told, ...did && { did },
    // For the agent with their words, should they go: what the user was looking at; kept, what the voice tool did with them.
    note: send ? view && lookingNote(view) : handled && handledNote(handled),
    // Kept, and done on the page or held back by the operator's instructions: these words never go by themselves, at the voice's end either.
    ...!send && !wait && (didAsked || withheld) && { settled: true }, ...!send && withheld && { withheld: true } };
}

/**
 * The companion spoke, the conversation went quiet, and the operator said nothing new (mediator.ts): whether what it
 * said leaves something with the coding agent (jev.ts, trigger voice). Sent at once: what it asks for is for now.
 */
export async function voiceTurn(bridge: Harness, spoken: Spoken[], waiting: Waiting = {}): Promise<Decision> {
  const recent = recentRequest(bridge, waiting), since = heardAt(bridge);
  const reading = await bridge.read({ trigger: 'voice', spoken, ...recent && { sent: recent } });
  // Not once the operator has spoken again: their turn's request then reads what the companion said as its reply.
  const send = (reading.needsAgent ?? 0) >= NEEDS_AGENT && (reading.adds === undefined || reading.adds >= ADDS) && heardAt(bridge) <= since;
  bridge.log({ type: 'turn.voice', said: reading.said.slice(-200), needsAgent: reading.needsAgent, ...reading.adds !== undefined && { adds: reading.adds }, send });
  bridge.jevAudit?.decided(reading.id, { outcome: send ? 'send' : 'keep' }, true);
  const view = send ? await pageNow(bridge) : undefined;
  return { reading, send, note: view && lookingNote(view) };
}

/** Both requests in turn, without waiting for the quiet: the turn as the tests (and a voice tool that heard no reply) read it. */
export async function routeTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], reply?: string): Promise<Decision> {
  const page = await pageTurn(bridge, request, spoken, { reply });
  const quiet = await quietTurn(bridge, request, spoken, reply, (page.did?.done ?? []).map(command => ({ command, asked: true })), { view: page.view, read: true });
  bridge.consider(quiet.reading!, request.id);
  return { ...quiet, ...page.did && { did: page.did } };
}
