// Turning the voice of the operator's running companions on and off, by voice. Jev reads each
// request GPT Live passes on (delegation-audit.ts) against the companions running now; what it
// finds asked for is carried out here, and GPT Live is told what was done.
//
// Turning one on asks it to start voice in its open page (Resume when it has a conversation);
// turning one off ends its voice. Companions that start come first: this one goes off only once
// another is on, so the operator is never left without a voice. Several can be on at once.
import { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import { listCompanions, type CompanionEntry } from './companions.ts';
import { StageError, StageNothing } from './stage.ts';
import type { PageAction } from './fast-action.ts';
import { ASKED, COMPANION_ONLY, ONLY, PAGE_ONLY, PAGE_OTHER, PAGE_WORK, UNLISTED, type PageJudgment, type Session } from './delegation-audit.ts';
import type { Gated } from './mediator.ts';
import { companionHandled, cueHandled, improvisedFailedNote, lookingNote, pageAhead, pageAlongside, pageDoneNote, pageFailed, pageFailedNote, pageHandled, pageNothing, pageNothingNote, sessionsHandled, sessionsOutcome } from './prompts.ts';

type Outcome = { session: Session; ok: boolean; text: string };

const localPages = (bridge: Harness) => [...bridge.pages.all.values()].filter(p => p.via === 'local' && p.ws.readyState === WebSocket.OPEN);
const readyPages = (bridge: Harness) => localPages(bridge).filter(p => p.ready?.microphone === 'granted' && p.ready.clicked);
/** Why voice can't start here without the operator, or undefined when a page of it can. */
export function startBlocked(bridge: Harness): string | undefined {
  const pages = localPages(bridge);
  if (!pages.length) return 'no page of it is open (open an fdc page on this computer: it loads every running session)';
  if (readyPages(bridge).length) return;
  if (pages.some(p => p.ready?.microphone === 'denied')) return 'its page is blocked from the microphone; allow it in the address bar';
  if (!pages.some(p => p.ready?.microphone === 'granted')) return 'its page has not been allowed the microphone yet';
  return 'its page has not been clicked since it opened (Chrome allows sound and the microphone only after a click)';
}

// Listening ahead acts before GPT Live delegates, so it needs more certainty than the gate: page only, no work, a sure first step.
export const AHEAD_ONLY = .6, AHEAD_WORK = .2, AHEAD_STEP = .7, AHEAD_OTHER = .7;
const name = (s: Session) => s.current ? 'this session' : s.folder;
const names = (sessions: Session[]) => sessions.map(name).join(', ');
const running = (sessions: Session[]) => sessions.map(s => `${s.folder} (${s.current ? 'this one, ' : ''}voice ${s.on ? 'on' : 'off'}${!s.on && s.blocked ? `, can't start: ${s.blocked}` : ''})`).join(', ');

export class SessionSwitch {
  bridge: Harness;
  /** How long a companion turned on gets to start voice, and how long this one keeps talking before it goes off. */
  confirmMs = 15000; goodbyeMs = 4000;
  /** The latest ask to start this companion's voice from another, and whether its page could not. */
  asked?: { at: number; from: string; failed?: string };
  constructor(bridge: Harness) { this.bridge = bridge; }

  /** The gate: Jev's check of a request GPT Live passed on, before it reaches the harness. */
  async gate(said: string, requestId: string, earlier?: string, companion?: string, cued?: boolean): Promise<Gated> {
    const bridge = this.bridge;
    // The page on the stage is read meanwhile; without one, Jev is asked nothing about a page.
    const [companions, page] = await Promise.all([listCompanions(bridge, true, 800), bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; })]);
    // Only companions this one can reach and turn on or off.
    const sessions: Session[] = companions.filter(c => c.current || (c.reachable && c.link)).map(c => ({ id: c.id, folder: c.folder, agent: c.agent, on: c.voice !== 'none', current: c.current, blocked: c.blocked }));
    const judgment = await bridge.handOffAudit!.judge(said, sessions, 3000, page, earlier, companion), { needsAgent } = judgment, asked = judgment.sessions!;
    bridge.log({ type: 'sessions.judged', requestId, needsAgent, ...asked, companionOnly: judgment.companionOnly, page: judgment.page });
    if (asked.asked < ASKED) {
      if (judgment.page?.steps.length) return cued ? this.cued(judgment.page, needsAgent) : this.present(judgment.page, needsAgent);
      // Something asked of the page that no command does: a one-off action (none for words the voice already moved the
      // page for). With work in the request too, the request still goes to the agent, noting the page part is done.
      if (judgment.page && (judgment.page.other ?? 0) >= PAGE_OTHER && bridge.fastAction) return cued ? this.cued(judgment.page, needsAgent) : this.improvise(said, needsAgent, !(judgment.page.only >= PAGE_ONLY && (judgment.page.work ?? 1) < PAGE_WORK));
      // Only about how the companion behaves: Jev's tuning and instruction learning take it from here, not the harness.
      if ((judgment.companionOnly ?? 0) >= COMPANION_ONLY) return { needsAgent, handled: companionHandled(bridge.agent), companion: true };
      // For the agent: what the user was looking at when they said it ("make this bigger").
      return page ? { needsAgent, note: lookingNote(page) } : { needsAgent };
    }
    // A session named that isn't running: Jev still picks the nearest listed one to turn on ("switch to runta" chose
    // video-editing), so nothing is turned on or off; GPT Live is told which ones are running.
    const unlisted = asked.unlisted >= UNLISTED;
    const on = unlisted ? [] : sessions.filter(s => asked.turnOn.includes(s.id) && !s.on), off = unlisted ? [] : sessions.filter(s => asked.turnOff.includes(s.id) && s.on);
    const plan = [
      on.length ? `Turning on the voice of ${names(on)}.` : '',
      off.length ? `Turning off the voice of ${names(off)}${on.length && off.some(s => s.current) ? ' once the others are on' : ''}.` : '',
      unlisted ? `The operator named a session that is not running; running now: ${running(sessions)}.` : '',
    ].filter(Boolean).join(' ') || `Nothing to change; running now: ${running(sessions)}.`;
    const only = asked.only >= ONLY;
    bridge.publish({ type: 'sessions', text: plan, handled: only });
    if (on.length || off.length) void this.carryOut(on, off);
    if (only) return { needsAgent, handled: sessionsHandled(bridge.agent, plan) };
    // Asked together with something for the harness: the request goes on, and GPT Live hears what changes.
    this.tell(plan);
    return { needsAgent };
  }

  /** The voice moved the page as it answered: nothing moves again ("next slide" twice is two slides), and only the page asked for, nothing goes to the agent. */
  cued({ only, work = 0 }: PageJudgment, needsAgent: number | null): Gated {
    if (only >= PAGE_ONLY && work < PAGE_WORK) return { needsAgent, handled: cueHandled(this.bridge.agent), page: true };
    return { needsAgent };
  }

  /**
   * The page commands Jev picked run on the stage at once. Only page commands: fdc handled it.
   * With more in it: the request goes on, noting the page part is done. If the page's controls
   * fail, the request goes to the harness with the error, to fix them.
   */
  async present({ steps, only, work = 0 }: PageJudgment, needsAgent: number | null): Promise<Gated> {
    const bridge = this.bridge, { agent } = bridge;
    try {
      const { done, onScreen } = await bridge.stage.run(steps);
      bridge.presentedAt = Date.now();
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      if (only >= PAGE_ONLY && work < PAGE_WORK) return { needsAgent, handled: pageHandled(agent, done, onScreen), page: true };
      return { needsAgent, note: pageDoneNote(done), told: pageAlongside(agent, done, onScreen) };
    } catch (error) {
      // Nothing to do there: not the page's fault, but not done either, so the request goes on.
      if (error instanceof StageNothing) return { needsAgent, note: pageNothingNote(error.failed), told: pageNothing(agent, error.failed) };
      // The agent gets the request with the error, to fix its page; GPT Live hears how far it got.
      const message = (error as Error).message, failed = error instanceof StageError ? [error.failed] : steps.map(id => bridge.stage.view?.commands.find(c => c.id === id) ?? { id, say: id });
      const done = error instanceof StageError ? error.done : [];
      if (done.length) bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen: (error as StageError).onScreen });
      return { needsAgent, note: pageFailedNote(failed, message, bridge.stage.view), told: pageFailed(agent, message, done) };
    }
  }

  /** No command fits: a fast model writes a one-off action for the page, which runs at once. A failure goes to the agent. */
  async improvise(said: string, needsAgent: number | null, alongside = false): Promise<Gated> {
    const bridge = this.bridge, { agent } = bridge, started = Date.now();
    let steps: PageAction[] = [];
    try {
      const { actions, say } = await bridge.fastAction!.write(said, await bridge.stage.digest());
      steps = actions;
      const shown = await bridge.stage.act(actions), onScreen = say ? `${say} (${shown})` : shown;
      const done = [{ id: 'one_off', say: `A one-off action for "${said.slice(0, 80)}"` }];
      bridge.log({ type: 'stage.improvised', said, actions, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      if (alongside) return { needsAgent, note: pageDoneNote(done), told: pageAlongside(agent, done, onScreen) };
      return { needsAgent, handled: pageHandled(agent, done, onScreen), page: true };
    } catch (error) {
      const message = (error as Error).message;
      bridge.log({ type: 'stage.improvise_failed', said, actions: steps, message, ms: Date.now() - started });
      return { needsAgent, note: improvisedFailedNote(message), told: pageNothing(agent, { say: `a one-off action (${message.slice(0, 120)})` }) };
    }
  }

  /**
   * Listening ahead: the operator's latest words, read as they pause, before GPT Live decides whether to
   * delegate. First what they ask of the page (nothing moves: the mediator may read words that turn out
   * unfinished), then, once they've paused, only a confident request for the page alone runs; anything
   * else is left to the gate. Resolves to what GPT Live is told, or undefined.
   */
  async aheadJudge(said: string, earlier?: string, companion?: string): Promise<PageJudgment | undefined> {
    const bridge = this.bridge;
    if (!bridge.handOffAudit) return;
    const page = await bridge.stage.describe().catch(() => undefined);
    if (!page) return;
    const judgment = await bridge.handOffAudit.judge(said, undefined, 1500, page, earlier, companion), p = judgment.page;
    bridge.log({ type: 'stage.ahead_judged', said: said.slice(-160), page: p });
    return p;
  }
  /** Runs what aheadJudge found, if confident; `since` is when the operator began the words it is for. */
  async aheadAct(p: PageJudgment | undefined, since: number, said = ''): Promise<{ told: string } | undefined> {
    const bridge = this.bridge;
    if (!p || p.only < AHEAD_ONLY || (p.work ?? 1) >= AHEAD_WORK) return;
    // A page command Jev is sure of, or, when none fits, a one-off action (as the gate would do once GPT Live delegated).
    const command = p.steps.length > 0 && (p.first ?? 0) >= AHEAD_STEP, oneOff = !p.steps.length && (p.other ?? 0) >= AHEAD_OTHER && !!bridge.fastAction;
    if (!command && !oneOff) return;
    // GPT Live moved the page by its own words meanwhile: moving it again would go one too far ("next slide").
    if ((bridge.mediator?.cueAt ?? 0) >= since) { bridge.log({ type: 'stage.ahead_skipped', said: said.slice(-160), reason: 'a cue moved the page meanwhile' }); return; }
    let done: { say: string }[], onScreen: string;
    if (command) ({ done, onScreen } = await bridge.stage.run(p.steps));
    else {
      const started = Date.now(), { actions, say } = await bridge.fastAction!.write(said, await bridge.stage.digest());
      const shown = await bridge.stage.act(actions);
      bridge.log({ type: 'stage.improvised', said, actions, ms: Date.now() - started, ahead: true });
      done = [{ say: `A one-off action for "${said.slice(0, 80)}"` }]; onScreen = say ? `${say} (${shown})` : shown;
    }
    bridge.presentedAt = bridge.aheadAt = Date.now(); bridge.aheadMoved = true;
    bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen, ahead: true });
    return { told: pageAhead(bridge.agent, done, onScreen) };
  }

  async carryOut(on: Session[], off: Session[]) {
    const outcomes: Outcome[] = await Promise.all(on.map(session => this.turnOn(session)));
    for (const session of off.filter(s => !s.current)) outcomes.push(await this.turnOff(session));
    const self = off.find(s => s.current), started = outcomes.filter(o => o.ok && on.includes(o.session));
    const leaving = self && (!on.length || started.length);
    if (self && !leaving) outcomes.push({ session: self, ok: false, text: 'this session stays on, since none of the others started' });
    const text = outcomes.map(o => o.text).join('; ') + (leaving ? `; this session's voice ends in a few seconds` : '');
    this.bridge.log({ type: 'sessions.done', outcomes: outcomes.map(o => ({ id: o.session.id, ok: o.ok, text: o.text })) });
    this.bridge.publish({ type: 'sessions', text: `${text[0].toUpperCase()}${text.slice(1)}.` });
    this.tell(sessionsOutcome(`${text}.`));
    if (leaving) setTimeout(() => this.bridge.live?.close(started.length ? `Switched to ${names(started.map(o => o.session))}` : 'Turned off by voice'), this.goodbyeMs).unref();
  }

  tell(text: string) {
    const mediator = this.bridge.mediator;
    if (mediator && this.bridge.live?.state === 'active') mediator.context.add('thinking', text);
  }

  entry(session: Session): CompanionEntry | undefined { return this.bridge.companions.list().find(e => `${e.pid}-${e.port}` === session.id); }

  async call(entry: CompanionEntry, path: string, init: RequestInit = {}) {
    const response = await fetch(`http://127.0.0.1:${entry.port}${path}`, { ...init, headers: { Authorization: `Bearer ${entry.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000) });
    return response.json() as Promise<any>;
  }

  async turnOn(session: Session): Promise<Outcome> {
    const entry = this.entry(session), from = this.bridge.companionEntry().cwd.split('/').pop() ?? '';
    if (!entry) return { session, ok: false, text: `${session.folder} has stopped` };
    try {
      const answer = await this.call(entry, '/api/voice', { method: 'POST', body: JSON.stringify({ action: 'on', from }) });
      if (!answer.ok) return { session, ok: false, text: `${session.folder}'s voice can't start: ${answer.reason}` };
      for (const until = Date.now() + this.confirmMs; Date.now() < until;) {
        const status = await this.call(entry, '/api/status').catch(() => undefined);
        if (status?.live === 'active') return { session, ok: true, text: `${session.folder}'s voice is on` };
        if (status?.voiceAsked?.failed) return { session, ok: false, text: `${session.folder}'s voice did not start: ${status.voiceAsked.failed}` };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { session, ok: false, text: `${session.folder}'s voice did not start within ${this.confirmMs / 1000} s` };
    } catch (error) { return { session, ok: false, text: `${session.folder} did not answer (${(error as Error).message})` }; }
  }

  async turnOff(session: Session): Promise<Outcome> {
    const entry = this.entry(session), from = this.bridge.companionEntry().cwd.split('/').pop() ?? '';
    if (!entry) return { session, ok: true, text: `${session.folder} has stopped` };
    try {
      const answer = await this.call(entry, '/api/voice', { method: 'POST', body: JSON.stringify({ action: 'off', from }) });
      return answer.ok ? { session, ok: true, text: `${session.folder}'s voice is off` } : { session, ok: false, text: `${session.folder}'s voice did not stop: ${answer.reason}` };
    } catch (error) { return { session, ok: false, text: `${session.folder} did not answer (${(error as Error).message})` }; }
  }

  /** Another companion asks this one to turn its voice on or off. */
  remote(action: unknown, from: unknown): { ok: boolean; state?: string; reason?: string } {
    const bridge = this.bridge, live = bridge.live, origin = bridge.clean(String(from ?? 'another session')).slice(0, 80);
    const on = Boolean(live) && ['new', 'connecting', 'active'].includes(live!.state);
    bridge.log({ type: 'sessions.remote', action, from: origin });
    const standby = bridge.voiceSessions.standby;
    if (action === 'off') {
      if (on) void live!.close(`Turned off from ${origin}`);
      else if (standby) bridge.voiceSessions.endStandby(`Turned off from ${origin}`);
      return { ok: true, state: on || standby ? 'turning off' : 'already off' };
    }
    if (action !== 'on') return { ok: false, reason: 'unknown action' };
    if (on) return { ok: true, state: 'already on' };
    // On Standby, its page is listening already: it wakes.
    if (standby) { this.asked = { at: Date.now(), from: origin }; bridge.voiceSessions.wake(`turned on from ${origin}`, false); return { ok: true, state: 'waking' }; }
    if (!bridge.agentReady) return { ok: false, reason: `its ${bridge.agent.profile.name} is not connected` };
    // A page on this computer that can start voice without the operator; the newest one.
    const blocked = startBlocked(bridge);
    if (blocked) return { ok: false, reason: blocked };
    const page = readyPages(bridge).at(-1)!;
    this.asked = { at: Date.now(), from: origin };
    bridge.pages.send(page, { type: 'voice_on', from: origin });
    return { ok: true, state: 'starting' };
  }
  /** Its page could not start voice when asked. */
  failed(message: unknown) { if (this.asked) this.asked.failed = this.bridge.clean(String(message ?? 'the page could not start voice')).slice(0, 200); }
}
