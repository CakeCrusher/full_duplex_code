// The operator's turn, read in two calls over the same state (jev.ts) that ask different questions:
// - The voice tool's own actions, at once (routeActions): it keeps the goal they set (what they want shown, taught or
//   walked through) apart from the page, and, with those features on (features.ts), turns voice sessions on or off
//   (sessions.ts) and leaves the companion's own behavior to the learner and the tuner (they take the reading). It never
//   decides whether their words go to the agent, and never moves the page: the page follows what the voice says
//   (presenter.ts), so the operator never has to learn how. Standby is read later, once the conversation has gone quiet
//   after the companion's answer (voice-sessions.ts).
// - The job delegation, once the voice companion has replied (jobTurn): whether their words need the coding agent,
//   read with what the companion said and what the page's commands can do, and whether they have finished saying them.
//   Words not finished wait for the next reading, which takes them with what the operator adds; never dropped. Keeping
//   work from the agent is the costly mistake; GPT Live passes nothing on.
// What each reading led to is added to its call's record (jev-audit.ts).
import type { Harness } from './bridge.ts';
import type { Decision } from './mediator.ts';
import type { StageView } from './stage.ts';
import type { Spoken, SpokenRequest } from './voice-history.ts';
import { ADDS, COMPANION_ONLY, GOAL, NEEDS_AGENT, NOW, PRESS, READY, RECENT_MS, SETTLED, STAYS, type Reading, type Trigger } from './jev.ts';
import { companionNoted, handledNote, lookingNote, sessionsChanging } from './prompts.ts';

/** What the voice tool did itself for the operator's turn: for GPT Live at once (told), and for the agent with their words (note). */
export interface Actions {
  reading?: Reading; view?: StageView;
  told?: string;
  /** For the agent if their words go to it; if they don't, carried to the next request (keptNote). */
  note?: string; keptNote?: string;
  /** These words moved the focus back from a fork: they go to the main session, not to a new fork. */
  back?: boolean;
}

export async function routeActions(bridge: Harness, request: SpokenRequest, spoken: Spoken[], why: Trigger): Promise<Actions> {
  // Read at every turn: a companion slower than 300 ms is listed as not answering. The page on stage is for the job
  // delegation (what its controls can do) and for the agent (what the user was looking at).
  const orchestration = bridge.features.has('orchestration');
  const [sessions, view] = await Promise.all([orchestration ? bridge.sessionSwitch.sessions(300) : undefined, bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; })]);
  const fork = forkMoment(bridge), since = heardAt(bridge);
  const reading = await bridge.read({ trigger: why, spoken, sessions, requestId: request.id, ...fork && { fork } });
  bridge.log({ type: 'turn.read', why, said: request.fresh.slice(-200), companionOnly: reading.companionOnly, sessions: reading.sessions });
  const asked = sessions && bridge.sessionSwitch.act(reading, sessions);
  const companion = (reading.companionOnly ?? 0) >= COMPANION_ONLY;
  // A goal they set replaces the one before; one they end is gone.
  const goal = reading.goal && reading.goal.choice !== 'keep' && reading.goal.p >= GOAL ? reading.goal.choice : undefined;
  if (goal) bridge.voiceSessions.setGoal(goal === 'done' ? undefined : request.fresh, { walk: goal === 'walk' });
  // The learner and the tuner add theirs, and complete the record (bridge.ts, consider).
  bridge.jevAudit?.decided(reading.id, { ...sessions && { sessions: asked?.told ?? false }, ...reading.companionOnly !== undefined && { companionOnly: companion }, ...goal && { goal } });
  const handled = asked ? 'sessions' : companion ? 'companion' : undefined;
  // Forks (forks.ts). With a fork in focus, words that are no question for it move the focus back to the main session,
  // before anything is sent: when the operator has left the fork's matter (not while its answer is still on the way: an
  // "okay" then answers the voice), or when GPT Live asked to pass them on (work goes to the main session). With the
  // main session in focus, a question GPT Live asked to pass on goes to a fork. Words Jev sends itself: jobTurn.
  const passed = why === 'delegation' && !handled;
  const returned = fork === 'fork' && (reading.tangent ?? 1) < stays(bridge) && (passed || ((reading.settled ?? 0) >= SETTLED && !bridge.forks.busy))
    ? bridge.forks.back(passed ? 'work goes to the main session' : 'the operator moved on') : undefined;
  const forked = fork === 'main' && passed ? await openFork(bridge, reading, since) : undefined;
  if (returned) bridge.jevAudit?.decided(reading.id, { fork: 'back' });
  const told = [asked && sessionsChanging(asked.told), companion && companionNoted(bridge.agent, bridge.features), forked, returned].filter(Boolean).join(' ') || undefined;
  return { reading, view, told, note: view ? lookingNote(view) : undefined, keptNote: handled && handledNote(handled), ...returned && { back: true } };
}

/** Where a fork decision stands (jev.ts): the main session in focus and in the middle of a turn (a question asked aside can go to a fork), or a fork in focus (the operator can move back). */
const forkMoment = (bridge: Harness) => !bridge.forks.possible ? undefined : bridge.forks.focus === 'fork' ? 'fork' as const : bridge.agentWorking() !== undefined ? 'main' as const : undefined;
/** With a fork open, words Jev reads as a question from this likelihood stay with it: STAYS, or the setting that opens a fork if that is lower (what opens a fork stays in one). */
const stays = (bridge: Harness) => Math.min(STAYS, bridge.tuning.forkFrom);
/** When the operator last spoke: a request is cut up to their latest words, so words said since a reading began would go with the ones it read. */
const heardAt = (bridge: Harness) => bridge.mediator?.history.lastInputAt ?? 0;
/**
 * Words on their way to the agent that Jev read as a question asked aside (from the setting forkFrom, tuning.ts) go to
 * a fork, opened now: what the voice is told. Not when the operator has gone on speaking since the reading began
 * (`since`): what they added is unread, and may be work.
 */
async function openFork(bridge: Harness, reading: Reading, since: number) {
  if ((reading.tangent ?? 0) < bridge.tuning.forkFrom || heardAt(bridge) > since) return undefined;
  const told = await bridge.forks.start(reading.said);
  if (told) bridge.jevAudit?.decided(reading.id, { fork: bridge.forks.focus === 'fork' ? 'opened' : 'failed' });
  return told;
}
/** GPT Live asked to pass on words Jev had read and kept (mediator.ts, passOn): they go by the same rules, from that reading. */
export async function passingOn(bridge: Harness, reading?: Reading) {
  const fork = forkMoment(bridge);
  if (!reading || !fork) return undefined;
  if (fork === 'main') return openFork(bridge, reading, heardAt(bridge));
  return (reading.tangent ?? 1) < stays(bridge) ? bridge.forks.back('work goes to the main session') : undefined;
}

/** Words waiting undecided before this reading (mediator.ts): the operator went on speaking before the decision, the words have waited too long, or an earlier reading of them found they need the agent. */
export interface Waiting { continued?: boolean; overdue?: boolean; needed?: boolean; /** The request that last went to the agent from this connection: how long ago, and the operator's words in it (mediator.ts). */ sent?: { ago: number; said: string; id: string } }

export async function jobTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], reply: string | undefined, actions: Actions, { continued = false, overdue = false, needed: neededBefore = false, sent }: Waiting = {}): Promise<Decision> {
  // Moments after a request reached the agent, Jev is also asked whether these words add to it: its tail, a repeat, an
  // acknowledgment or noise stays with the voice (jev.ts, ADDS). Not for words already found to need the agent.
  // Where that request is now is the outbox's to say: still held for the turn's end, or not known to have arrived (then a
  // repeat of it must go).
  const state = sent && bridge.outbox.get(sent.id)?.state;
  const recent = sent && sent.ago <= RECENT_MS && !neededBefore && state !== 'uncertain' ? { ago: sent.ago, said: sent.said, held: state === 'held' } : undefined;
  // While the agent is in the middle of a turn it can be steered in, Jev is also asked whether these words must reach it
  // now or can wait for the turn to end (jev.ts, NOW): fdc then holds them until it does (outbox.ts).
  const working = bridge.agent.profile.canSteer ? bridge.agentWorking() : undefined;
  const fork = actions.back ? undefined : forkMoment(bridge), since = heardAt(bridge);
  const reading = await bridge.read({ trigger: 'job', spoken, reply, page: actions.view, requestId: request.id, ...recent && { sent: recent }, ...working !== undefined && { working }, ...fork && { fork } });
  // Words that add nothing to a request held for the turn's end still go when they press for it ("no, send it now"):
  // steered in, they bring the held request with them (outbox.ts).
  const adds = reading.adds === undefined || reading.adds >= ADDS || Boolean(recent?.held && (reading.now ?? 0) >= PRESS);
  // Once found to need the agent, waiting words keep needing it: a later reading of the whole stretch never drops them
  // (read with the talk around them, a request was sometimes found to need nothing and waited minutes for another).
  const needed = neededBefore || ((reading.needsAgent ?? 1) >= NEEDS_AGENT && adds), ready = (reading.ready ?? 1) >= READY;
  // Sent once the operator has finished saying it and stopped, or once it has waited too long (mediator.ts, HELD_CAP_MS).
  const send = needed && ((ready && !continued) || overdue);
  // Not finished, or still being said: no decision yet. The next reading takes these words with what the operator adds, or
  // they go once the conversation stays quiet (mediator.ts). There is a next time, so a pause is no reason to send half a request.
  const wait = !send && (needed || continued);
  // Forks (forks.ts), as the words are sent: a question asked aside opens a fork (it is free, so nothing is held). With a
  // fork in focus, words for the agent that are no question for it are the main session's: back at once, also while they
  // wait for the operator to finish, since waiting words go later without another reading (mediator.ts, sendHeld).
  const forked = send && fork === 'main' ? await openFork(bridge, reading, since) : undefined;
  const returned = (send || needed) && fork === 'fork' && (reading.tangent ?? 1) < stays(bridge) ? bridge.forks.back('work goes to the main session') : undefined;
  // Held only on Jev's clear word that it can wait; words that waited already (overdue, or found needed before) go in now.
  const later = send && !forked && !overdue && !neededBefore && reading.now !== undefined && reading.now < NOW;
  bridge.log({ type: 'turn.job', said: request.fresh.slice(-200), reply: reply?.slice(-200) ?? null, needsAgent: reading.needsAgent, ready: reading.ready, ...reading.adds !== undefined && { adds: reading.adds }, ...reading.now !== undefined && { now: reading.now }, send, ...later && { later }, ...wait && { wait }, ...continued && { continued }, ...overdue && { overdue } });
  bridge.jevAudit?.decided(reading.id, { outcome: send ? 'send' : wait ? 'wait' : 'keep', ...returned && { fork: 'back' }, needed, finished: ready, ...reading.adds !== undefined && { adds }, ...reading.now !== undefined && { delivery: later ? 'follow-up' : 'steer' }, ...neededBefore && { neededBefore }, ...continued && { continued }, ...overdue && { overdue } }, true);
  return { reading, send, later, wait, needed: wait && needed, note: send ? actions.note : actions.keptNote, ...(forked || returned) && { told: forked ?? returned } };
}

/** Both calls in turn, without waiting for a reply: the turn as the tests (and a voice tool that heard none) read it. */
export async function routeTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], why: Trigger, reply?: string): Promise<Decision> {
  const actions = await routeActions(bridge, request, spoken, why);
  const job = await jobTurn(bridge, request, spoken, reply, actions);
  return { ...job, told: [actions.told, job.told].filter(Boolean).join(' ') || undefined, actions };
}
