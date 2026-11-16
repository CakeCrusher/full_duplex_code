import type { AgentAdapter, AgentDefinition, DeliveryResult, VoiceRequest } from './adapter.ts';
import { heldForTurnEnd, heldThenPressed, joinRequests, withNote } from './prompts.ts';

export type DeliveryState = 'queued' | 'held' | 'dispatching' | 'sent' | 'uncertain';
export interface OutboxEntry extends VoiceRequest { state: DeliveryState; confirmationSent?: boolean; /** When it was held for the end of the agent's turn. */ heldAt?: number;
  /** The requests that joined this one while it waited, and when each did: the moments fdc decided to send more. */
  joined?: { id: string; at: number }[] }
/** Every request an entry carries: its own, and those that joined it. */
export const requestIds = (entry: Pick<OutboxEntry, 'id' | 'joined'>) => [entry.id, ...(entry.joined ?? []).map(request => request.id)];

interface OutboxOptions {
  agent: Pick<AgentDefinition, 'wire'>;
  /** The adapter a request goes to: the main session's, or a fork's (forks.ts). */
  adapter: (entry: OutboxEntry) => AgentAdapter;
  /** Whether the adapter can deliver right now. */
  ready: (entry: OutboxEntry) => boolean;
  /** Whether the agent is in the middle of a turn: a request that can wait is held until it ends. */
  working?: (entry: OutboxEntry) => boolean;
  clean: (text: string) => string;
  log: (event: Record<string, unknown>) => void;
  publish: (event: Record<string, unknown>) => void;
  fault: (error: Error) => void;
  /** A request reached the agent. */
  onSent: (entry: OutboxEntry) => void;
  /** A request may not have reached the agent; a later confirmation still counts. */
  onUncertain?: (entry: OutboxEntry) => void;
  /** A request is held until the agent's turn ends. */
  onHeld?: (entry: OutboxEntry) => void;
  /** A request is handed to the adapter now: the voice is told which words went before anything else is read. */
  onDispatched?: (entry: OutboxEntry) => void;
}

// Voice requests on their way to the agent, keyed by request ID. Each state
// change is logged and shown; delivery itself belongs to the adapter.
// A request reaches the agent in one of two ways. Steered: delivered at once, which every agent takes in the middle of a
// turn (Claude Code at its next tool call: 257 of 267 inside the running turn, Oct 31 to Nov 12; Codex and Pi by their own
// steer). As a follow-up: held here until the agent's turn ends, for a request Jev finds can wait (turn.ts). Held here
// rather than in each agent's own queue, so that it works the same for every agent.
// One request at most waits for a session (held for its turn's end, or for it to connect): a request is the conversation
// from the session's place in the record to the latest words, so one made while another waits is that one, reaching
// further. It joins it: one message when it goes, in the operator's order, and each moment fdc decided to send is kept
// (`joined`, logged and drawn on the page's timeline). Words that can't wait take a held request along at once.
export class Outbox extends Map<string, OutboxEntry> {
  options: OutboxOptions;
  /** A request that joined one already waiting answers to that one's ID. */
  joinedTo = new Map<string, string>();
  constructor(options: OutboxOptions) { super(); this.options = options; }
  override get(id: string) { return super.get(this.joinedTo.get(id) ?? id); }
  override has(id: string) { return super.has(this.joinedTo.get(id) ?? id); }
  add(request: VoiceRequest) {
    if (this.size >= 1000) throw new Error('Too many voice tasks in one session');
    if (this.has(request.id)) return;
    const waiting = [...this.values()].find(entry => (entry.state === 'held' || entry.state === 'queued') && entry.target === request.target);
    if (waiting) return this.join(waiting, request);
    const entry: OutboxEntry = { ...request, content: this.options.clean(request.content), state: 'queued' }; this.set(request.id, entry);
    if (request.followUp && this.options.working?.(entry)) {
      entry.state = 'held'; entry.heldAt = Date.now();
      this.publishRequest(entry); this.options.onHeld?.(entry);
      return;
    }
    this.publishRequest(entry);
    if (this.options.ready(entry)) this.dispatch(entry);
  }
  /** A request made while one waits for the same session becomes part of it. */
  join(entry: OutboxEntry, request: VoiceRequest) {
    const held = entry.state === 'held';
    this.joinedTo.set(request.id, entry.id); (entry.joined ??= []).push({ id: request.id, at: Date.now() });
    entry.content = this.options.clean(joinRequests(entry.content, this.options.clean(request.content)));
    entry.said = [entry.said, request.said].filter(text => text?.trim()).join(' ') || undefined;
    // The voice session on now hears of it when it goes, and GPT Live's latest ask is the one answered.
    entry.voiceSessionId = request.voiceSessionId ?? entry.voiceSessionId; entry.delegationId = request.delegationId ?? entry.delegationId;
    this.options.log({ type: 'task.joined', id: entry.id, joined: request.id, held });
    // Words that can wait too wait with it; words that can't take it along now.
    if (held && request.followUp && this.options.working?.(entry)) { this.publishRequest(entry); this.options.onHeld?.({ ...entry, said: request.said }); return; }
    if (held) this.release(entry, true); else this.publishRequest(entry);
    if (this.options.ready(entry)) this.dispatch(entry);
  }
  /** A held request goes: it says why it comes when it does. */
  release(entry: OutboxEntry, pressed: boolean) {
    const seconds = Math.round((Date.now() - (entry.heldAt ?? Date.now())) / 1000);
    entry.content = this.options.clean(withNote(entry.content, pressed ? heldThenPressed(seconds) : heldForTurnEnd(seconds, Boolean(entry.joined))));
    entry.state = 'queued';
    this.options.log({ type: 'task.released', id: entry.id, heldSeconds: seconds, pressed });
    this.publishRequest(entry);
  }
  /** The agent's turn ended: what was held goes now. */
  releaseHeld() { for (const entry of this.values()) if (entry.state === 'held') { this.release(entry, false); if (this.options.ready(entry)) this.dispatch(entry); } }
  /** Sends everything that waited for the agent to become ready. */
  dispatchQueued() { for (const entry of this.values()) if (entry.state === 'queued' && this.options.ready(entry)) this.dispatch(entry); }
  dispatch(entry: OutboxEntry) {
    entry.state = 'dispatching';
    this.publishRequest(entry);
    this.options.onDispatched?.(entry);
    let delivery: Promise<DeliveryResult>;
    try { delivery = this.options.adapter(entry).deliver(entry); }
    catch (error) { delivery = Promise.resolve({ state: 'uncertain', error: error as Error }); }
    delivery.then(result => this.settle(entry, result));
  }
  /** A later confirmation for a request that was reported uncertain. */
  confirm(id: string) {
    const entry = this.get(id);
    if (entry && entry.state !== 'sent') this.settle(entry, { state: 'sent' });
  }
  settle(entry: OutboxEntry, result: DeliveryResult) {
    entry.state = result.state; this.publishRequest(entry);
    if (result.state === 'sent') this.options.onSent(entry);
    else { this.options.fault(result.error); this.options.onUncertain?.(entry); }
  }
  publishRequest(entry: OutboxEntry) {
    const event = { type: 'task', id: entry.id, text: entry.content, notification: this.options.agent.wire(entry), state: entry.state, queuedAt: entry.queuedAt, ...entry.joined && { joined: entry.joined } };
    this.options.log(event); this.options.publish(event);
  }
}
