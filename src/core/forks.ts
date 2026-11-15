import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, Observation } from './adapter.ts';
import type { Harness } from './bridge.ts';
import { forkBack, forkFailed, forkNote, forkOpened } from './prompts.ts';
import { openWindow, writeScript } from './window.ts';
import { perceive } from './perceived.ts';

/** The tags the conversation record (perceived.ts) carries where a fork began and ended: the voice, Jev and both sessions read them as they are. */
export const FORK_STARTED = '<fork started>', FORK_ENDED = '<fork ended>';

// A tangent the operator starts while the main session works goes to a fork of the agent's session, opened in a terminal
// window of its own (Jev decides when, and when the tangent is settled: jev.ts, turn.ts). Delegation doesn't change: the
// conversation from the cursor to the latest words goes to whichever session is in focus, and GPT Live carries what it
// learns in either. The voice hears the focused session's work; the other session's weighs nothing for it (nor for
// Standby). Back in the main session, its feed picks up from its latest work. One fork at a time: a fork of a fork is not
// offered.

export type Focus = 'main' | 'fork';

export class Forks {
  bridge: Harness;
  focus: Focus = 'main';
  /** The fork fdc follows, whether its channel is connected, and how many forks this run opened. */
  adapter?: AgentAdapter; ready = false; count = 0;
  open: typeof openWindow;
  constructor(bridge: Harness, { open = openWindow }: { open?: typeof openWindow } = {}) { this.bridge = bridge; this.open = open; }
  /** A tangent can go to a fork: always, when the agent can fork (not Codex yet) and the main session has an ID; Jev decides when. */
  get possible() { const b = this.bridge; return Boolean(b.agent.canFork) && Boolean(b.sessionId); }
  /**
   * Where each session is in the conversation record: when its last request was cut from it (mediator.ts, send). A fork
   * starts where the main session is; the main session, back from it, goes on from its own place, so its next request
   * carries what went to the fork, between the tags.
   */
  cursors: Record<Focus, number> = { main: Date.now(), fork: 0 };
  /** The session the voice hears and requests go to. */
  observer() { return this.focus === 'fork' && this.adapter ? this.adapter.observations : this.bridge.observer; }
  adapterFor(target?: Focus) { return target === 'fork' && this.adapter ? this.adapter : this.bridge.adapter; }
  /** Opens a fork for the tangent and moves the focus to it; returns what the voice is told. */
  async start(said: string): Promise<string | undefined> {
    const b = this.bridge;
    if (!this.possible || this.focus === 'fork') return;
    // An earlier fork's window stays open; fdc stops following it.
    this.retire();
    const n = ++this.count, runDir = path.join(b.runDir, `fork-${n}`);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const adapter = b.agent.create({ ...b.agentSession, runDir, sessionId: undefined, forkOf: b.sessionId, prefix: '/fork', instructions: `${b.agentInstructions}\n\n${forkNote(b.agent)}`, log: event => b.log({ ...event, fork: n }) });
    try {
      const launch = await adapter.launch({ baseUrl: b.baseUrl, token: b.agentToken });
      const how = this.open(writeScript(path.join(runDir, 'fork.command'), launch, b.cwd));
      this.adapter = adapter; this.ready = false; this.focus = 'fork'; this.cursors.fork = this.cursors.main;
      this.wire(adapter, n);
      b.log({ type: 'fork.opened', n, from: b.sessionId, window: how, said: said.slice(-160) });
      b.focusChanged();
      return this.record(`${FORK_STARTED} ${forkOpened(b.agent, how)}`);
    } catch (error) {
      void adapter.close();
      b.log({ type: 'fork.failed', n, message: (error as Error).message });
      return forkFailed(b.agent, (error as Error).message);
    }
  }
  /** The tangent is settled: requests go to the main session again, and the voice hears its work from its latest. */
  back(why: string): string | undefined {
    const b = this.bridge;
    if (this.focus !== 'fork') return;
    this.focus = 'main';
    b.log({ type: 'fork.back', n: this.count, why });
    b.focusChanged();
    return this.record(`${FORK_ENDED} ${forkBack(b.agent, b.observer.state, why)}`);
  }
  /** What the fork does reaches the page and the record always, and the voice, Standby and the stage while it is in focus. */
  wire(adapter: AgentAdapter, n: number) {
    const b = this.bridge, observer = adapter.observations, mine = () => this.adapter === adapter;
    observer.on('input', event => b.log({ type: 'agent.input', fork: n, ...event }));
    observer.on('text', event => b.log({ type: 'agent.text', fork: n, ...event }));
    observer.on('observation', ({ raw, ...event }: Observation) => { if (mine()) b.publish({ type: 'agent_observation', fork: n, ...event, text: event.text.slice(0, 20000) }); });
    observer.on('observation', (observation: Observation) => {
      if (!mine() || observation.child) return;
      if (this.focus === 'fork' && observation.kind !== 'event') b.voiceSessions.activity.add(observation.kind);
      b.stage.observe(observer.toolUse(observation), observation.name === b.agent.profile.turnEnd);
    });
    observer.on('status', event => {
      b.log({ type: 'agent.status', fork: n, ...event });
      // The operator closed the fork's window: back to the main session.
      if (event.state === 'exited' && mine()) { const told = this.back('the fork ended'); this.retire(); if (told) b.tell(told); }
    });
    observer.on('fault', error => b.fault(error));
    adapter.on('connection', (ready: boolean) => { if (!mine()) return; this.ready = ready; if (ready) b.outbox.dispatchQueued(); b.publish(b.status()); });
    adapter.on('delivery', ({ id }: { id: string }) => b.outbox.confirm(id));
    adapter.on('session', (id: string) => b.log({ type: 'fork.session', n, sessionId: id }));
    adapter.on('fault', (error: Error) => b.fault(error));
  }
  /** Into the record at once, before the turn's words are sent; the voice is told the same text (perceive keeps it once). */
  record(text: string) { const run = this.bridge.voiceSessions.run; if (run) perceive(run.record, { at: Date.now(), kind: 'thinking', text }); return text; }
  /** Stops following the fork (its window, if open, stays the operator's). */
  retire() { const adapter = this.adapter; this.adapter = undefined; this.ready = false; if (adapter) void adapter.close(); }
  close() { this.retire(); }
}
