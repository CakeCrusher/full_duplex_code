import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, Observation } from './adapter.ts';
import { QUIET_TURN_MS, TURN_ENDS, type Harness } from './bridge.ts';
import { forkBack, forkFailed, forkNote, forkOpened } from './prompts.ts';
import { openWindow, windowAlive, writeScript } from './window.ts';
import { perceive } from './perceived.ts';

/** The tags the conversation record (perceived.ts) carries where a fork began and ended: the voice, Jev and both sessions read them as they are. */
export const FORK_STARTED = '<fork started>', FORK_ENDED = '<fork ended>';

// While the main session works, a question the operator turns aside to ask goes to a fork of the agent's session, opened
// in a terminal window of its own (Jev decides which words, and when the operator has left the matter: jev.ts, turn.ts).
// Delegation doesn't change: the conversation from the cursor to the latest words goes to whichever session is in focus,
// and GPT Live carries what it learns in either. The voice hears the focused session's work; the main session's weighs
// nothing for it (nor for Standby) meanwhile. A fork doesn't last: on the way back to the main session fdc stops following
// it (its window stays the operator's), and the next question aside opens a new one. One fork at a time: a fork of a fork
// is not offered.

export type Focus = 'main' | 'fork';

export class Forks {
  bridge: Harness;
  focus: Focus = 'main';
  /** The fork in focus, if one is (fdc follows no other), whether its channel is connected, and how many forks this run opened. */
  adapter?: AgentAdapter; ready = false; count = 0;
  /** Where the fork in focus is served on the bridge: each fork has its own, so one left behind (its window still open) can't take the next one's place. */
  route = '';
  /** What the fork in focus is told as it starts: fdc's instructions and that it is a fork (an agent that takes them through its hook gets these there: endpoints.ts). */
  instructions = '';
  /** How long a fork has to connect once its window opened (Claude Code asks the operator to confirm its channel there first). */
  static START_MS = 60000; starting?: NodeJS.Timeout;
  /** When a request last went to the fork, and when the fork last ended a turn (as the agent reports it): between the two its answer is on the way. */
  asked = 0; answered = 0; active = 0;
  /** Its answer is on the way: not for ever, when it reports no end and does nothing (as for the main session's turn, bridge.ts). */
  get busy() { return this.asked > this.answered && Date.now() - Math.max(this.asked, this.active) < QUIET_TURN_MS; }
  open: typeof openWindow;
  constructor(bridge: Harness, { open = openWindow }: { open?: typeof openWindow } = {}) { this.bridge = bridge; this.open = open; }
  /** A tangent can go to a fork: always, when the agent can fork and the main session has an ID; Jev decides when. */
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
    const n = ++this.count, runDir = path.join(b.runDir, `fork-${n}`), script = path.join(runDir, 'fork.command');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const adapter = b.agent.create({ ...b.agentSession, runDir, sessionId: undefined, forkOf: b.sessionId, window: script, prefix: this.route = `/fork/${n}`, instructions: this.instructions = `${b.agentInstructions}\n\n${forkNote(b.agent)}`, log: event => b.log({ ...event, fork: n }) });
    try {
      // Followed from before its launch: Codex's fork is made there, and can take requests as the launch returns.
      this.adapter = adapter; this.ready = false; this.wire(adapter, n);
      const launch = await adapter.launch({ baseUrl: b.baseUrl, token: b.agentToken });
      const how = this.open(writeScript(script, launch, b.cwd));
      this.watch(adapter, script);
      this.focus = 'fork'; this.cursors.fork = this.cursors.main; this.asked = this.answered = this.active = 0;
      // A fork that doesn't start (its window waits for the operator, or the agent failed there) gives the focus, and what was sent to it, back to the main session.
      this.starting = setTimeout(() => { if (this.adapter === adapter && !this.ready) { const told = this.back('the fork did not start'); if (told) b.tell(told); } }, Forks.START_MS);
      this.starting.unref();
      b.log({ type: 'fork.opened', n, from: b.sessionId, window: how, said: said.slice(-160) });
      b.focusChanged();
      return this.record(`${FORK_STARTED} ${forkOpened(b.agent, how)}`);
    } catch (error) {
      this.adapter = undefined; this.ready = false;
      void adapter.close();
      b.log({ type: 'fork.failed', n, message: (error as Error).message });
      return forkFailed(b.agent, (error as Error).message);
    }
  }
  /** Back to the main session: requests go to it again, the voice hears its work from its latest, and the fork is left behind. */
  back(why: string, record = true): string | undefined {
    const b = this.bridge;
    if (this.focus !== 'fork') return;
    this.focus = 'main';
    b.log({ type: 'fork.back', n: this.count, why });
    const untaken = this.retire();
    b.focusChanged();
    const text = `${FORK_ENDED} ${forkBack(b.agent, b.observer.state, why)}`, told = record ? this.record(text) : text;
    // What the fork hadn't taken goes to the main session now, after the decisions under way (which may send it themselves).
    const mediator = b.mediator;
    if (untaken && mediator) mediator.inTurn(() => mediator.send(randomUUID(), [], null));
    return told;
  }
  /**
   * The conversation is quiet (voice goes on Standby, or is on it) with a fork in focus that has answered: back to the
   * main session, whose news then wakes the voice. A fork whose answer is still on the way keeps the focus until it has
   * answered. The voice hears of it when it wakes (voice-sessions.ts): it is leaving, or gone, now.
   */
  quiet() { if (this.focus === 'fork' && !this.busy) this.untold = this.back('the conversation went quiet', false); }
  /** What a waking voice session is still to be told: the way back made while it was going on Standby. */
  untold?: string;
  /** What the fork does reaches the page, the record, the voice, Standby and the stage for as long as fdc follows it: until the way back. */
  wire(adapter: AgentAdapter, n: number) {
    const b = this.bridge, observer = adapter.observations, mine = () => this.adapter === adapter;
    observer.on('input', event => b.log({ type: 'agent.input', fork: n, ...event }));
    observer.on('text', event => b.log({ type: 'agent.text', fork: n, ...event }));
    observer.on('observation', ({ raw, ...event }: Observation) => { if (mine()) b.publish({ type: 'agent_observation', fork: n, ...event, text: event.text.slice(0, 20000) }); });
    observer.on('observation', (observation: Observation) => {
      if (!mine() || observation.child) return;
      // Its turn ended: what it was asked is answered (waiting for a permission is not an answer).
      this.active = Date.now();
      if (TURN_ENDS.has(observation.kind)) this.answered = Date.now();
      if (observation.kind !== 'event') b.voiceSessions.activity.add(observation.kind);
      b.stage.observe(observer.toolUse(observation), observation.name === b.agent.profile.turnEnd);
    });
    observer.on('status', event => {
      b.log({ type: 'agent.status', fork: n, ...event });
      // The operator closed the fork's window: back to the main session.
      if (event.state === 'exited' && mine()) { const told = this.back('the fork ended'); if (told) b.tell(told); }
    });
    observer.on('fault', error => b.fault(error));
    adapter.on('connection', (ready: boolean) => { if (!mine()) return; this.ready = ready; if (ready) { clearTimeout(this.starting); b.outbox.dispatchQueued(); } b.publish(b.status()); });
    adapter.on('delivery', ({ id }: { id: string }) => b.outbox.confirm(id));
    adapter.on('session', (id: string) => b.log({ type: 'fork.session', n, sessionId: id }));
    adapter.on('fault', (error: Error) => b.fault(error));
  }
  /**
   * The agent ended in the fork's window, or the operator closed it: back to the main session. Seen from the window's
   * process (window.ts), as not every agent reports its end: Codex's thread lives on in fdc's app server, where requests
   * would go on reaching a fork nobody sees.
   */
  static WATCH_MS = 2000; watching?: NodeJS.Timeout;
  watch(adapter: AgentAdapter, script: string) {
    clearInterval(this.watching);
    this.watching = setInterval(() => {
      if (this.adapter !== adapter) return clearInterval(this.watching);
      if (windowAlive(script) !== false) return;
      const told = this.back('the fork ended'); if (told) this.bridge.tell(told);
    }, Forks.WATCH_MS);
    this.watching.unref();
  }
  /** Into the record at once, before the turn's words are sent; the voice is told the same text (perceive keeps it once). */
  record(text: string) { const run = this.bridge.voiceSessions.run; if (run) perceive(run.record, { at: Date.now(), kind: 'thinking', text }); return text; }
  /**
   * Stops following the fork (its window, if open, stays the operator's). A request the fork hadn't confirmed is taken
   * back as one whose delivery is uncertain (its words are free again, and the voice, told they went, hears so): the way
   * back then sends them to the main session, cut from its own place in the record. Never nowhere.
   */
  retire() {
    const adapter = this.adapter, b = this.bridge; this.adapter = undefined; this.ready = false; clearTimeout(this.starting); clearInterval(this.watching);
    if (!adapter) return false;
    const left = new Error('The fork was left before it took a request: its words go to the main session.');
    const untaken = [...b.outbox.values()].filter(entry => entry.target === 'fork' && (entry.state === 'queued' || entry.state === 'dispatching'));
    for (const entry of untaken) b.outbox.settle(entry, { state: 'uncertain', error: left });
    void adapter.close();
    return untaken.length > 0;
  }
  close() { this.retire(); }
}
