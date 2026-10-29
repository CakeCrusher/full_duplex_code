// The operator's turn: when they finish speaking, Jev reads their latest words once (jev.ts), with what happened before
// them, and the voice tool acts on what it found, without the agent where it can: it turns voice sessions on or off
// (sessions.ts), does what they ask of the page (presenter.ts), goes on Standby when they are done for now, and leaves the
// companion's own behavior to the learner and the tuner (they take the reading). What needs the agent goes to it, with
// what the voice tool did noted. GPT Live passes nothing on. Keeping work from the agent is the costly mistake: only words
// Jev finds need nothing from it, or that asked only what the voice tool did, stay with the voice.
import type { Harness } from './bridge.ts';
import type { Decision } from './mediator.ts';
import type { Spoken, SpokenRequest } from './voice-history.ts';
import { COMPANION_ONLY, FINISHED, NEEDS_AGENT, PAGE_WORK, STANDBY, type Trigger } from './jev.ts';
import { companionHandled, handledNote, lookingNote } from './prompts.ts';

export async function routeTurn(bridge: Harness, request: SpokenRequest, spoken: Spoken[], why: Trigger): Promise<Decision> {
  const [sessions, view] = await Promise.all([bridge.sessionSwitch.sessions(800), bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; })]);
  const reading = await bridge.read({ trigger: why, spoken, sessions, page: view });
  bridge.log({ type: 'turn.read', why, said: request.fresh.slice(-200), needsAgent: reading.needsAgent, companionOnly: reading.companionOnly, standby: reading.standby, sessions: reading.sessions, page: reading.page });
  if ((reading.standby ?? 0) >= STANDBY) bridge.voiceSessions.standbyAsked();
  const asked = bridge.sessionSwitch.act(reading, sessions);
  if (asked?.only) return { reading, send: false, note: handledNote('sessions'), told: asked.told };
  // The page's part, unless the voice already moved it for these words as it answered (speech cues).
  const page = view && reading.page && !request.cued ? await bridge.presenter.act(reading, request.fresh, spoken, view) : undefined;
  if (page?.escalated) return { reading, send: true, note: page.note, told: asked?.told, moved: page.moved, escalated: true };
  if (page?.only) return { reading, send: false, note: handledNote('page'), told: asked?.told, moved: page.moved };
  if ((reading.companionOnly ?? 0) >= COMPANION_ONLY) return { reading, send: false, note: handledNote('companion'), told: companionHandled(bridge.agent) };
  // With a page open, two independent readings of work: either one sends the words, once they are finished; unfinished,
  // they wait for the rest (a turn reading them again with it, or a while with nothing more: turn.ts's caller).
  const work = (reading.needsAgent ?? 1) >= NEEDS_AGENT || (reading.page?.work ?? 0) >= PAGE_WORK, send = work && (reading.finished ?? 1) >= FINISHED;
  return { reading, send, held: work && !send, note: page?.note ?? (send && view ? lookingNote(view) : undefined), told: asked?.told, moved: page?.moved };
}
