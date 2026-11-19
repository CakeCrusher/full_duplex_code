import { EventEmitter } from 'node:events';
import type { DeliveryResult, VoiceRequest } from '../../core/adapter.ts';
import type { AgyObserver } from './observer.ts';
import type { AgyServer } from './server.ts';
import { turnText, WAKE } from './message.ts';

// Delivers requests to Antigravity as the operator's own messages. Its hook before each model call (PreInvocation) asks
// the bridge, and the answer adds what waits as user messages (injectSteps): a running turn takes a request at its next
// model call, after the tool under way. A session that opens with a first message of fdc's (a new conversation's
// greeting, a fork's opening) takes what waits at that turn's first model call. A conversation at rest is woken through
// its language server (server.ts), once agy has settled (a turn woken before runs without hooks), and the hook of the
// turn that starts adds the request the same way. A turn that ends while a request waits (no model call came after it)
// ends at rest, and is woken. Never resent: a request leaves the queue once a hook has taken it.
export class AgyDelivery extends EventEmitter {
  /** How long after a turn's Stop hook a wake waits: the hook runs inside agy's loop, which must have ended first. */
  static SETTLE_MS = 700;
  /** How long a wake may go unanswered by a model call before it is tried again, once, and then reported. */
  static UNANSWERED_MS = 8000;
  server: AgyServer; observer: AgyObserver;
  log: (event: Record<string, unknown>) => void;
  queue: VoiceRequest[] = [];
  /** The session's first turn is fdc's own first message, still to come: its first model call takes what waits. */
  opening = false;
  waking?: Promise<void>; unanswered?: NodeJS.Timeout; retried = false;
  constructor({ server, observer, log }: { server: AgyServer; observer: AgyObserver; log: (event: Record<string, unknown>) => void }) {
    super(); this.server = server; this.observer = observer; this.log = log;
  }
  /** Requests can go once the language server listens, the terminal shows a conversation, and a turn will take them: its opening, or a wake once agy has settled. */
  get ready() { return this.server.port !== undefined && this.observer.sessionId !== undefined && (this.opening || this.server.settled); }
  async deliver(request: VoiceRequest): Promise<DeliveryResult> {
    if (!this.ready) return { state: 'uncertain', error: new Error('Antigravity has no conversation open yet.') };
    this.queue.push(request);
    this.log({ type: 'agy.queued', id: request.id, running: this.observer.running, opening: this.opening || undefined });
    try { await this.wakeIfResting(); return { state: 'sent' }; }
    catch (error) {
      this.queue = this.queue.filter(waiting => waiting !== request);
      return { state: 'uncertain', error: error as Error };
    }
  }
  /** Wakes the conversation for what waits, unless a turn runs or the opening is to come (their next model call takes it). One wake at a time. */
  async wakeIfResting() {
    const settle = (this.observer.stoppedAt ?? 0) + AgyDelivery.SETTLE_MS - Date.now();
    if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle));
    if (!this.queue.length || this.observer.running || this.opening || !this.server.settled) return;
    this.waking ??= this.wake().finally(() => { this.waking = undefined; });
    return this.waking;
  }
  async wake() {
    const conversation = this.observer.sessionId!;
    await this.server.send(conversation, WAKE);
    this.log({ type: 'agy.woken', conversation, waiting: this.queue.map(request => request.id) });
    clearTimeout(this.unanswered);
    this.unanswered = setTimeout(() => this.unansweredWake(), AgyDelivery.UNANSWERED_MS);
    this.unanswered.unref();
  }
  /** No model call took what waits after a wake: tried once more, then reported. */
  unansweredWake() {
    if (!this.queue.length) return;
    if (!this.retried) { this.retried = true; this.log({ type: 'agy.wake_unanswered', waiting: this.queue.map(request => request.id) }); this.wakeIfResting().catch(error => this.emit('fault', error)); return; }
    this.emit('fault', new Error(`Antigravity woke without taking ${this.queue.length} voice request(s): are its hooks running?`));
  }
  /** fdc's first message never opened a turn (agy took none): what waits is woken instead. */
  openingMissed() {
    if (!this.opening) return;
    this.opening = false; this.log({ type: 'agy.opening_missed', waiting: this.queue.length });
    this.wakeIfResting().catch(error => this.emit('fault', error));
  }
  /** The hook's answer for one of this session's events: before a model call, the requests waiting, as the operator's messages. */
  answer(event: Record<string, any>): unknown {
    if (event.hookEventName === 'Stop') {
      this.opening = false;
      if (this.queue.length) this.wakeIfResting().catch(error => this.emit('fault', error));
      return undefined;
    }
    if (event.hookEventName !== 'PreInvocation') return undefined;
    this.opening = false;
    if (!this.queue.length) return undefined;
    const taken = this.queue.splice(0);
    clearTimeout(this.unanswered); this.retried = false;
    this.log({ type: 'agy.injected', ids: taken.map(request => request.id), invocation: event.invocationNum });
    return { injectSteps: taken.map(request => ({ userMessage: turnText(request) })) };
  }
  close() { clearTimeout(this.unanswered); }
}
