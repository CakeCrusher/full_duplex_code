// The operator's turn, read in two calls over the same state (jev.ts) that ask different questions:
// - The voice tool's own actions, at once (routeActions): it turns voice sessions on or off (sessions.ts), does what they
//   ask of the page (presenter.ts), goes on Standby when they are done for now, and leaves the companion's own behavior
//   to the learner and the tuner (they take the reading). It never decides whether their words go to the agent; only
//   page controls that fail send them (escalated).
// - The job delegation, once the voice companion has replied (jobTurn): whether their words need the coding agent,
//   read with what the companion said and what the page's commands can do, and whether they have finished saying them.
//   Words not finished wait for the next reading, which takes them with what the operator adds; never dropped. Keeping
//   work from the agent is the costly mistake; GPT Live passes nothing on.
import type { Harness } from './bridge.ts';
import type { Decision } from './mediator.ts';
import type { StageView } from './stage.ts';
import type { Spoken, SpokenRequest } from './voice-history.ts';
import { COMPANION_ONLY, NEEDS_AGENT, PAGE_ONLY, READY, STANDBY, type Reading, type Trigger } from './jev.ts';
import { companionNoted, controllerNote, handledNote, lookingNote, sessionsChanging } from './prompts.ts';

/** What the voice tool did itself for the operator's turn: for GPT Live at once (told), and for the agent with their words (note). */
export interface Actions {
  reading?: Reading; view?: StageView;
  told?: string;
  /** For the agent if their words go to it; if they don't, carried to the next request (keptNote). */
  note?: string; keptNote?: string;
  /** The page moved for their words; their words were about the page; the page's controls failed. */
  moved?: boolean; aboutPage?: boolean; escalated?: boolean;
}

export async function routeActions(bridge: Harness, request: SpokenRequest, spoken: Spoken[], why: Trigger): Promise<Actions> {
  // Read at every turn, page moves wait on it: a companion slower than 300 ms is listed as not answering.
  const [sessions, view] = await Promise.all([bridge.sessionSwitch.sessions(300), bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; })]);
  const reading = await bridge.read({ trigger: why, spoken, sessions, page: view });
  bridge.log({ type: 'turn.read', why, said: request.fresh.slice(-200), companionOnly: reading.companionOnly, standby: reading.standby, sessions: reading.sessions, page: reading.page });
  if ((reading.standby ?? 0) >= STANDBY) bridge.voiceSessions.standbyAsked();
  const asked = bridge.sessionSwitch.act(reading, sessions);
  // The page's part, unless the voice already moved it for these words as it answered (speech cues).
  const page = view && reading.page && !request.cued ? await bridge.presenter.act(reading, request.fresh, spoken, view) : undefined;
  const companion = (reading.companionOnly ?? 0) >= COMPANION_ONLY;
  const told = [asked && sessionsChanging(asked.told), companion && companionNoted(bridge.agent)].filter(Boolean).join(' ') || undefined;
  const handled = page?.moved ? 'page' : asked ? 'sessions' : companion ? 'companion' : undefined;
  return { reading, view, told, note: page?.note ?? (view ? lookingNote(view) : undefined), keptNote: handled && handledNote(handled), moved: page?.moved, escalated: page?.escalated, aboutPage: (reading.page?.only ?? 0) >= PAGE_ONLY };
}

/** Words waiting undecided before this reading (mediator.ts): the operator went on speaking before the decision, the words have waited too long, or an earlier reading of them found they need the agent. */
export interface Waiting { continued?: boolean; overdue?: boolean; needed?: boolean }

export async function jobTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], reply: string | undefined, actions: Actions, { continued = false, overdue = false, needed: neededBefore = false }: Waiting = {}): Promise<Decision> {
  const reading = await bridge.read({ trigger: 'job', spoken, reply, page: actions.view });
  // Once found to need the agent, waiting words keep needing it: a later reading of the whole stretch never drops them
  // (read with the talk around them, a request was sometimes found to need nothing and waited minutes for another).
  const needed = neededBefore || (reading.needsAgent ?? 1) >= NEEDS_AGENT, ready = (reading.ready ?? 1) >= READY;
  // Sent once the operator has finished saying it and stopped, or once it has waited too long (mediator.ts, HELD_CAP_MS).
  const send = Boolean(actions.escalated) || (needed && ((ready && !continued) || overdue));
  // Not finished, or still being said: no decision yet. The next reading takes these words with what the operator adds, or
  // they go once the conversation stays quiet (mediator.ts). There is a next time, so a pause is no reason to send half a request.
  const wait = !send && (needed || continued);
  bridge.log({ type: 'turn.job', said: request.fresh.slice(-200), reply: reply?.slice(-200) ?? null, needsAgent: reading.needsAgent, ready: reading.ready, send, ...wait && { wait }, ...continued && { continued }, ...overdue && { overdue } });
  // Their words about the page that no command did go to the agent to extend the page's controller.
  const shortOfCommand = send && !actions.escalated && actions.view && actions.aboutPage && !actions.moved;
  return { reading, send, wait, needed: wait && needed, note: send ? (shortOfCommand ? controllerNote(actions.view!) : actions.note) : actions.keptNote, moved: actions.moved, escalated: actions.escalated };
}

/** Both calls in turn, without waiting for a reply: the turn as the tests (and a voice tool that heard none) read it. */
export async function routeTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], why: Trigger, reply?: string): Promise<Decision> {
  const actions = await routeActions(bridge, request, spoken, why);
  return { ...await jobTurn(bridge, request, spoken, reply, actions), told: actions.told, actions };
}
