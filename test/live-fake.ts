// A stand-in LiveSession whose promise and event ordering follows src/core/live-session.ts:
// start() resolves on session.started (resolveReady before the 'event' emit), close() of an active
// session finishes on a later macrotask (as when GPT Live's session.closed arrives), and finish()
// rejects pending appends, then resolves `closed`, then emits 'closed'. greet() is async around append().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TestContext } from 'node:test';
import { Harness } from '../src/core/bridge.ts';
import { claude } from '../src/adapters/claude/index.ts';
import type { Moment, PageJudgment, Reading, Trigger } from '../src/core/jev.ts';
import { routeTurn } from '../src/core/turn.ts';

export const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
export const until = async <T>(check: () => T) => { for (let i = 0; i < 300; i++) { const v = check(); if (v) return v; await settle(); } throw new Error('timed out'); };

export class Live extends EventEmitter {
  state = 'new'; id?: string; reservation: string; transport = 'webrtc'; usageSeconds = 0; instructions: string;
  requested = false; answered = false; stored = false; store: boolean; greeting?: string; appended: [string, string][] = []; options: any; name: string;
  closeReason?: string; startedAt?: number; ws = { bufferedAmount: 0 };
  pending = new Set<{ resolve: (v: unknown) => void; reject: (e: Error) => void; kind: string; text: string }>();
  closed: Promise<any>; resolveClosed!: (r: any) => void;
  resolveReady?: (v: unknown) => void; rejectReady?: (e: Error) => void;
  /** Names of sessions whose start waits for begin(); a predicate for appends that wait for ack(). */
  static deferStart = new Set<string>();
  static hold: (kind: string, text: string) => boolean = () => false;
  constructor(options: any, name: string) {
    super(); this.options = options; this.name = name; this.instructions = options.instructions; this.store = options.store; this.reservation = `run-${name}`;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  start(_sdp?: string) {
    this.state = 'connecting';
    const ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    if (!Live.deferStart.has(this.name)) this.begin();
    return ready;
  }
  begin() {
    if (this.state !== 'connecting') return;
    this.state = 'active'; this.id = `voice-${this.name}`; this.startedAt = Date.now(); this.stored = this.options.store;
    this.answered = true;
    const event = { type: 'session.started', session: { id: this.id } };
    this.resolveReady!(event); this.emit('event', event);
  }
  append(kind: string, text: string, _delegationId: string | null = null) {
    this.appended.push([kind, text]);
    if (this.state !== 'active') return Promise.reject(new Error(`Live session is ${this.state}`));
    if (!Live.hold(kind, text)) return Promise.resolve({});
    return new Promise((resolve, reject) => { this.pending.add({ resolve, reject, kind, text }); });
  }
  /** Acknowledges held appends. */
  ack(match: (kind: string, text: string) => boolean = () => true) {
    for (const p of [...this.pending]) if (match(p.kind, p.text)) { this.pending.delete(p); p.resolve({}); }
  }
  /** Rejects held appends, as an error event or a stalled acknowledgment would. */
  rejectHeld(message = 'Context acknowledgments stalled for 20 seconds') { for (const p of [...this.pending]) { this.pending.delete(p); p.reject(new Error(message)); } }
  async greet(text: string) { this.greeting = text; await this.append('commentary', text); }
  close(reason = 'requested') {
    this.closeReason ??= reason; this.requested = true;
    if (this.state === 'active') { this.state = 'closing'; setImmediate(() => this.finish(true)); }
    else if (this.state === 'new' || this.state === 'connecting') this.abort(reason);
    return this.closed;
  }
  abort(reason: string) { if (this.state === 'closed') return; this.closeReason ??= reason; this.rejectReady?.(new Error(reason)); this.finish(false); }
  drop() { this.finish(false); }
  finish(finalized: boolean) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.rejectReady?.(new Error('Connection closed before startup'));
    for (const p of this.pending) p.reject(new Error('Session closed'));
    this.pending.clear();
    const result = { finalized, reserved: true, usageSeconds: 1, sessionId: this.id, reason: this.closeReason ?? 'connection to GPT Live lost' };
    this.resolveClosed(result); this.emit('closed', result);
  }
  audio() {}
  say(role: 'operator' | 'intermediary', delta: string, startMs: number) {
    this.emit('event', { type: role === 'operator' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta, start_ms: startMs, end_ms: startMs + 800 });
  }
}

export const page = (id: string) => ({ id, ws: { readyState: 1, send() {}, bufferedAmount: 0 } }) as any;

export async function harness(t: TestContext, extra: Record<string, unknown> = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-live-')), sessionId = randomUUID()) {
  const h = await new Harness({ agent: claude, root, runDir: path.join(root, `run-${randomUUID()}`), cwd: root, sessionId, apiKey: 'unused', ...extra }).start();
  h.agentReady = true;
  const lives: Live[] = [];
  h.voiceSessions.createLive = (options: any) => { const live = new Live(options, `${lives.length}`); lives.push(live); return live as any; };
  // Every published event, with the page it went to (undefined: every page).
  const published: { event: any; page?: string }[] = [], publish = h.publish;
  h.publish = ((event: any, p: any) => { published.push({ event, page: p?.id }); publish(event, p); }) as typeof h.publish;
  const fault = h.fault;
  h.fault = ((error: Error, p: any) => { published.push({ event: { type: 'fault', message: error.message }, page: p?.id }); fault(error, p); }) as typeof h.fault;
  h.pages.send = () => {};
  t.after(async () => { Live.deferStart.clear(); Live.hold = () => false; await h.close(); });
  return { h, lives, published, root, sessionId };
}
export const learn = (h: Harness, text: string) => h.voiceSessions.learn({ text, scope: 'session', behave: .9, design: .1, lasting: 'this_session' });
export const disregarded = (live: Live, id: string) => live.appended.some(([kind, text]) => kind === 'instructions' && text.startsWith(`Disregard instruction ${id}`));

/** A page judgment as Jev would give it: nothing asked unless the test says so. */
export const pageReading = (page: Partial<PageJudgment> = {}): PageJudgment => ({ only: 0, work: 1, other: 0, walk: 0, unhappy: 0, ...page });
/** A stand-in for Jev (jev.ts): the test's reading of each moment; returns every moment it was asked about. */
export function fakeJev(h: Harness, reading: (moment: Moment) => Partial<Reading> = () => ({})) {
  const moments: Moment[] = [];
  h.jev = { read: async (moment: Moment) => { moments.push(moment); return { trigger: moment.trigger, said: moment.latest?.text ?? '', transcript: '', needsAgent: .3, ...reading(moment) }; } } as any;
  return moments;
}
/** What the voice tool makes of the operator's turn with these words as the latest (turn.ts), as the mediator asks it. */
export const turn = (h: Harness, said: string, { why = 'turn', cued }: { why?: Trigger; cued?: boolean } = {}) =>
  routeTurn(h, { utterances: [{ role: 'operator', text: said, endMs: 0 }], through: 0, seqs: [0], fresh: said, ...cued && { cued } }, [{ role: 'operator', text: said, at: Date.now() }], why);
