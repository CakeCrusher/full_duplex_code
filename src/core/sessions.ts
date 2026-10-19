// Turning the voice of the operator's running companions on and off, by voice. Jev reads each
// request GPT Live passes on (delegation-audit.ts) against the companions running now; what it
// finds asked for is carried out here, and GPT Live is told what was done.
//
// Turning one on asks it to start voice in its open page (Resume when it has a conversation);
// turning one off ends its voice. Companions that start come first: this one goes off only once
// another is on, so the operator is never left without a voice. Several can be on at once.
//
// The gate routes every request GPT Live passes on: session changes are carried out here, page requests by the
// presenter (presenter.ts), and the rest goes to the agent, with what the page could not do noted for it.
import { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import { listCompanions, type CompanionEntry } from './companions.ts';
import { ASKED, COMPANION_ONLY, ONLY, PAGE_ONLY, PAGE_OTHER, PAGE_UNHAPPY, PAGE_WORK, UNLISTED, type Session } from './delegation-audit.ts';
import type { Gated } from './mediator.ts';
import { companionHandled, controllerNote, lookingNote, sessionsHandled, sessionsOutcome } from './prompts.ts';

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
      if (judgment.page?.steps.length) return cued ? bridge.presenter.cued(judgment.page, needsAgent) : bridge.presenter.present(judgment.page, needsAgent);
      // Something asked of the page that no command does: a one-off action (none for words the voice already moved the
      // page for). With work in the request too, the request still goes to the agent, noting the page part is done.
      if (judgment.page && (judgment.page.other ?? 0) >= PAGE_OTHER && bridge.fastAction) return cued ? bridge.presenter.cued(judgment.page, needsAgent) : bridge.presenter.improvise(said, needsAgent, !(judgment.page.only >= PAGE_ONLY && (judgment.page.work ?? 1) < PAGE_WORK));
      // Only about how the companion behaves: Jev's tuning and instruction learning take it from here, not the harness.
      if ((judgment.companionOnly ?? 0) >= COMPANION_ONLY) return { needsAgent, handled: companionHandled(bridge.agent), companion: true };
      // Unhappy with the page, and no command answers it: the page's controls are what's lacking, so the agent improves them.
      if (page && (judgment.page?.unhappy ?? 0) >= PAGE_UNHAPPY) return { needsAgent, note: controllerNote(page) };
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
