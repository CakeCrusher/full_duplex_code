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
import { ASKED, ONLY, UNLISTED, type Session } from './delegation-audit.ts';
import type { Screened } from './mediator.ts';
import { sessionsHandled, sessionsOutcome } from './prompts.ts';

type Outcome = { session: Session; ok: boolean; text: string };

const name = (s: Session) => s.current ? 'this session' : s.folder;
const names = (sessions: Session[]) => sessions.map(name).join(', ');
const running = (sessions: Session[]) => sessions.map(s => `${s.folder} (${s.current ? 'this one, ' : ''}voice ${s.on ? 'on' : 'off'})`).join(', ');

export class SessionSwitch {
  bridge: Harness;
  /** How long a companion turned on gets to start voice, and how long this one keeps talking before it goes off. */
  confirmMs = 15000; goodbyeMs = 4000;
  /** The latest ask to start this companion's voice from another, and whether its page could not. */
  asked?: { at: number; from: string; failed?: string };
  constructor(bridge: Harness) { this.bridge = bridge; }

  /** Jev's check of a request GPT Live passed on, before it reaches the harness. */
  async screen(said: string, requestId: string): Promise<Screened> {
    const bridge = this.bridge, companions = await listCompanions(bridge, true, 800);
    // Only companions this one can reach and turn on or off.
    const sessions: Session[] = companions.filter(c => c.current || (c.reachable && c.link)).map(c => ({ id: c.id, folder: c.folder, agent: c.agent, on: c.voice !== 'none', current: c.current }));
    const judgment = await bridge.handOffAudit!.judge(said, sessions, 3000), { needsAgent } = judgment, asked = judgment.sessions!;
    bridge.log({ type: 'sessions.judged', requestId, needsAgent, ...asked });
    if (asked.asked < ASKED) return { needsAgent };
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
      if (!answer.ok) return { session, ok: false, text: `${session.folder}'s voice did not start: ${answer.reason}` };
      for (const until = Date.now() + this.confirmMs; Date.now() < until;) {
        const status = await this.call(entry, '/api/status').catch(() => undefined);
        if (status?.live === 'active') return { session, ok: true, text: `${session.folder}'s voice is on` };
        if (status?.voiceAsked?.failed) return { session, ok: false, text: `${session.folder}'s voice did not start: ${status.voiceAsked.failed}` };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { session, ok: false, text: `${session.folder}'s voice did not start within ${this.confirmMs / 1000} s; its tab may need a click (Chrome allows sound and the microphone only after one)` };
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
    if (action === 'off') {
      if (on) void live!.close(`Turned off from ${origin}`);
      return { ok: true, state: on ? 'turning off' : 'already off' };
    }
    if (action !== 'on') return { ok: false, reason: 'unknown action' };
    if (on) return { ok: true, state: 'already on' };
    if (!bridge.agentReady) return { ok: false, reason: `its ${bridge.agent.profile.name} is not connected` };
    // The page opened last on this computer: a tab of it is where voice starts.
    const page = [...bridge.pages.all.values()].reverse().find(p => p.via === 'local' && p.ws.readyState === WebSocket.OPEN);
    if (!page) return { ok: false, reason: 'no page of it is open' };
    this.asked = { at: Date.now(), from: origin };
    bridge.pages.send(page, { type: 'voice_on', from: origin });
    return { ok: true, state: 'starting' };
  }
  /** Its page could not start voice when asked. */
  failed(message: unknown) { if (this.asked) this.asked.failed = this.bridge.clean(String(message ?? 'the page could not start voice')).slice(0, 200); }
}
