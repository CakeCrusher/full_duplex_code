import type { AgentAdapter, AgentDefinition, DeliveryResult, VoiceRequest } from './adapter.ts';

export type DeliveryState = 'queued' | 'dispatching' | 'sent' | 'uncertain';
export interface OutboxEntry extends VoiceRequest { state: DeliveryState; confirmationSent?: boolean }

interface OutboxOptions {
  agent: Pick<AgentDefinition, 'wire'>;
  adapter: () => AgentAdapter;
  /** Whether the adapter can deliver right now. */
  ready: () => boolean;
  clean: (text: string) => string;
  log: (event: Record<string, unknown>) => void;
  publish: (event: Record<string, unknown>) => void;
  fault: (error: Error) => void;
  /** A request reached the agent. */
  onSent: (entry: OutboxEntry) => void;
}

// Voice requests on their way to the agent, keyed by request ID. Each state
// change is logged and shown; delivery itself belongs to the adapter.
export class Outbox extends Map<string, OutboxEntry> {
  options: OutboxOptions;
  constructor(options: OutboxOptions) { super(); this.options = options; }
  add(request: VoiceRequest) {
    if (this.size >= 1000) throw new Error('Too many voice tasks in one session');
    if (this.has(request.id)) return;
    const entry: OutboxEntry = { ...request, content: this.options.clean(request.content), state: 'queued' }; this.set(request.id, entry);
    this.publishRequest(entry);
    if (this.options.ready()) this.dispatch(entry);
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
    else this.options.fault(result.error);
  }
  publishRequest(entry: OutboxEntry) {
    const event = { type: 'task', id: entry.id, text: entry.content, notification: this.options.agent.wire(entry), state: entry.state, queuedAt: entry.queuedAt };
    this.options.log(event); this.options.publish(event);
  }
}
