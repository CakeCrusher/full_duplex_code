// The voice tool's two readings of the conversation, over the same state (jev.ts), that ask different questions:
// - When GPT Live asks it to act (its delegation, routeActions): it shows on the page what the operator wants to see or
//   what GPT Live is about to talk about (presenter.ts), turns voice sessions on or off (sessions.ts), goes on Standby
//   when the operator is done for now, and leaves the companion's own behavior to the learner and the tuner (they take
//   the reading). It never decides whether words go to the agent; only page controls that fail send them (escalated).
// - When the operator's turn has ended and the voice companion has replied (jobTurn, the job delegation): whether their
//   words need the coding agent, read with what the companion said, what the page's commands can do, and what the voice
//   tool did for them. Keeping work from the agent is the costly mistake; GPT Live passes nothing on.
import type { Harness } from './bridge.ts';
import type { Decision, RouteMoment } from './mediator.ts';
import type { StageCommand, StageView } from './stage.ts';
import type { Spoken, SpokenRequest } from './voice-history.ts';
import { COMPANION_ONLY, NEEDS_AGENT, PAGE_ONLY, READY, STANDBY, type Reading } from './jev.ts';
import { companionNoted, controllerNote, handledNote, lookingNote, sessionsChanging } from './prompts.ts';

/** What the voice tool did itself when GPT Live asked: for GPT Live at once (told, or the page's own news: answered), and for the agent with the operator's words (note). */
export interface Actions {
  reading?: Reading; view?: StageView;
  told?: string; answered?: boolean;
  /** Page commands run. */
  ran?: StageCommand[];
  /** For the agent if their words go to it; if they don't, carried to the next request (keptNote). */
  note?: string; keptNote?: string;
  /** The page moved for their words; their words were about the page; the page's controls failed. */
  moved?: boolean; aboutPage?: boolean; escalated?: boolean;
}

export async function routeActions(bridge: Harness, { spoken, reply, delegationId, ran, cued }: RouteMoment): Promise<Actions> {
  // A companion slower than 300 ms is listed as not answering.
  const [sessions, view] = await Promise.all([bridge.sessionSwitch.sessions(300), bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; })]);
  const reading = await bridge.read({ trigger: 'delegation', spoken, sessions, page: view, reply: reply ?? '', done: ran });
  const said = spoken.at(-1)?.text ?? '';
  bridge.log({ type: 'turn.read', why: 'delegation', said: said.slice(-200), reply: reply?.slice(-200) ?? null, companionOnly: reading.companionOnly, standby: reading.standby, sessions: reading.sessions, page: reading.page });
  if ((reading.standby ?? 0) >= STANDBY) bridge.voiceSessions.standbyAsked();
  const asked = bridge.sessionSwitch.act(reading, sessions);
  // The page's part, unless the voice's own words already moved it for these words (speech cues), or a walkthrough paces it.
  const page = view && reading.page && !cued && !bridge.presenter.walking ? await bridge.presenter.act(reading, said, spoken, view, delegationId) : undefined;
  const companion = (reading.companionOnly ?? 0) >= COMPANION_ONLY;
  const told = [asked && sessionsChanging(asked.told), companion && companionNoted(bridge.agent)].filter(Boolean).join(' ') || undefined;
  const handled = page?.moved ? 'page' : asked ? 'sessions' : companion ? 'companion' : undefined;
  return { reading, view, told, answered: Boolean(page), ran: page?.done, note: page?.note ?? (view ? lookingNote(view) : undefined), keptNote: handled && handledNote(handled), moved: page?.moved, escalated: page?.escalated, aboutPage: (reading.page?.only ?? 0) >= PAGE_ONLY };
}

export async function jobTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], reply: string | undefined, actions: Actions): Promise<Decision> {
  // The page's commands, also when GPT Live asked nothing of the voice tool for these words.
  const view = actions.view ?? await bridge.stage.describe().catch(() => undefined);
  const reading = await bridge.read({ trigger: 'job', spoken, reply, page: view });
  const send = Boolean(actions.escalated) || ((reading.needsAgent ?? 1) >= NEEDS_AGENT && (reading.ready ?? 1) >= READY);
  bridge.log({ type: 'turn.job', said: request.fresh.slice(-200), reply: reply?.slice(-200) ?? null, needsAgent: reading.needsAgent, ready: reading.ready, send });
  // Their words about the page that no command did go to the agent to extend the page's controller.
  const shortOfCommand = send && !actions.escalated && view && actions.aboutPage && !actions.moved;
  return { reading, send, note: send ? (shortOfCommand ? controllerNote(view!) : actions.note ?? (view ? lookingNote(view) : undefined)) : actions.keptNote, moved: actions.moved, escalated: actions.escalated };
}

/** GPT Live asking the voice tool to act, then the job delegation, without waiting for a reply: a turn as the tests read it. */
export async function routeTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], reply?: string): Promise<Decision> {
  const actions = await routeActions(bridge, { spoken, reply, cued: request.cued });
  return { ...await jobTurn(bridge, request, spoken, reply, actions), told: actions.told, actions };
}
