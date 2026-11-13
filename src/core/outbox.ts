import type { AgentAdapter, AgentDefinition, DeliveryResult, VoiceRequest } from './adapter.ts';
import { heldForTurnEnd, heldThenPressed, withNote } from './prompts.ts';

export type DeliveryState = 'queued' | 'held' | 'dispatching' | 'sent' | 'uncertain';
export interface OutboxEntry extends VoiceRequest { state: DeliveryState; confirmationSent?: boolean; /** When it was held for the end of the agent's turn. */ heldAt?: number }

interface OutboxOptions {
  agent: Pick<AgentDefinition, 'wire'>;
  adapter: () => AgentAdapter;
  /** Whether the adapter can deliver right now. */
  ready: () => boolean;
  /** Whether the agent is in the middle of a turn: a request that can wait is held until it ends. */
  working?: () => boolean;
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
}

// Voice requests on their way to the agent, keyed by request ID. Each state
// change is logged and shown; delivery itself belongs to the adapter.
// A request reaches the agent in one of two ways. Steered: delivered at once, which every agent takes in the middle of a
// turn (Claude Code at its next tool call: 257 of 267 inside the running turn, Oct 31 to Nov 12; Codex and Pi by their own
// steer). As a follow-up: held here until the agent's turn ends, for a request Jev finds can wait (turn.ts). Held here
// rather than in each agent's own queue, so that it works the same for every agent and a request that can't wait takes
// those held along, before it and in the operator's order: each request carries only what was said since the one before.
export class Outbox extends Map<string, OutboxEntry> {
  options: OutboxOptions;
  constructor(options: OutboxOptions) { super(); this.options = options; }
  add(request: VoiceRequest) {
    if (this.size >= 1000) throw new Error('Too many voice tasks in one session');
    if (this.has(request.id)) return;
    const entry: OutboxEntry = { ...request, content: this.options.clean(request.content), state: 'queued' }; this.set(request.id, entry);
    if (request.followUp && this.options.working?.()) {
      entry.state = 'held'; entry.heldAt = Date.now();
      this.publishRequest(entry); this.options.onHeld?.(entry);
      return;
    }
    // One that can't wait brings those held with it, first.
    this.releaseHeld(true);
    this.publishRequest(entry);
    if (this.options.ready()) this.dispatch(entry);
  }
  /** The agent's turn ended, or a request came that can't wait (`pressed`): what was held goes now, oldest first, saying why it comes when it does. */
  releaseHeld(pressed = false) {
    for (const entry of this.values()) {
      if (entry.state !== 'held') continue;
      const seconds = Math.round((Date.now() - (entry.heldAt ?? Date.now())) / 1000);
      entry.content = this.options.clean(withNote(entry.content, pressed ? heldThenPressed(seconds) : heldForTurnEnd(seconds)));
      entry.state = 'queued';
      this.options.log({ type: 'task.released', id: entry.id, heldSeconds: seconds, pressed });
      this.publishRequest(entry);
      if (this.options.ready()) this.dispatch(entry);
    }
  }
  /** Sends everything that waited for the agent to become ready. */
  dispatchQueued() { for (const entry of this.values()) if (entry.state === 'queued') this.dispatch(entry); }
  dispatch(entry: OutboxEntry) {
    entry.state = 'dispatching';
    this.publishRequest(entry);
    let delivery: Promise<DeliveryResult>;
    try { delivery = this.options.adapter().deliver(entry); }
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
    const event = { type: 'task', id: entry.id, text: entry.content, notification: this.options.agent.wire(entry), state: entry.state, queuedAt: entry.queuedAt };
    this.options.log(event); this.options.publish(event);
  }
}
