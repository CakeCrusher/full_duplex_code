import { createHash } from 'node:crypto';
import type { Observation, ObservationKind } from './adapter.ts';
import type { ObservedAgent } from './agent-observer.ts';
import { estimatedTokens } from './text-fragments.ts';
import { contextData } from './context-rules.ts';
import { feedLabel } from './prompts.ts';
import type { AppendKind } from './context-queue.ts';

/** What the feed needs from an observation. */
export type FeedObservation = Pick<Observation, 'kind' | 'name' | 'text' | 'state'>;

// Prose is never turned into references or noted as large. Urgent kinds flush
// without waiting for the collection window.
const PROSE = new Set<string>(['prompt', 'text', 'attention', 'turn_end', 'turn_failed', 'task_completed', 'session_end'] satisfies ObservationKind[]);
const URGENT = new Set<string>(['prompt', 'tool_failure', 'attention', 'turn_end', 'turn_failed', 'task_completed', 'session_end'] satisfies ObservationKind[]);
// Only the adapter's table trims. A record still this large goes whole, with a
// short note, so a missing row shows instead of quietly slowing Live down.
const LARGE_TOKENS = 1200;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export interface Projection { text: string; name: string; tokens: number }

// Turns one observation into the context record Live receives.
export class ObservationProjector {
  agent: ObservedAgent;
  stateKey: string;
  seen = new Map<string, string>();
  sequence = 0;
  constructor(agent: ObservedAgent) { this.agent = agent; this.stateKey = `${agent.profile.id}_turn_state`; }
  // The record for one observation, or null when the adapter's table removes the
  // event. Its turn state is the one the observer recorded, so a removed event
  // still moves the state that later records carry.
  project(observation: FeedObservation): Projection | null {
    const data = contextData(this.agent, observation);
    if (data === undefined) return null;
    const id = ++this.sequence, prose = PROSE.has(observation.kind);
    // A long string Live already has becomes a reference to the record that carried it.
    const refer = (value: unknown, field: string): unknown => {
      if (!prose && typeof value === 'string' && value.length >= 80) {
        const hash = digest(value), first = this.seen.get(hash);
        if (first) return { same_as: first };
        this.seen.set(hash, `hook ${id} ${field}`);
      }
      if (Array.isArray(value)) return value.map((item, i) => refer(item, `${field}.${i}`));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refer(item, `${field}.${key}`)]));
      return value;
    };
    const record = { id, hook: observation.name, [this.stateKey]: observation.state, data: refer(data, 'data') };
    let text = JSON.stringify(record), tokens = estimatedTokens(text);
    if (!prose && tokens > LARGE_TOKENS) { text = JSON.stringify({ note: 'large result, shown untrimmed', ...record }); tokens = estimatedTokens(text); }
    if (this.seen.size > 2048) this.seen = new Map([...this.seen].slice(-1024));
    return { text, name: observation.name, tokens };
  }
}

/** Where the feed sends prepared context. */
export interface ContextTarget { add(kind: AppendKind, text: string, delegationId?: string | null, source?: string): void }

// Collects observations briefly, then sends them to the context queue in order.
export class ObservationFeed {
  context: ContextTarget;
  log: (event: Record<string, unknown>) => void;
  coalesceMs: number;
  projector: ObservationProjector;
  label: string;
  pending: (Projection & { receivedAt: number })[] = [];
  stopped = false;
  timer: NodeJS.Timeout | null = null;
  constructor(context: ContextTarget, log: (event: Record<string, unknown>) => void, { agent, coalesceMs = 250 }: { agent: ObservedAgent; coalesceMs?: number }) {
    this.context = context; this.log = log; this.coalesceMs = coalesceMs;
    this.projector = new ObservationProjector(agent); this.label = feedLabel(agent);
  }
  add(observation: FeedObservation) {
    if (this.stopped) return;
    const projection = this.projector.project(observation);
    if (!projection) return;
    this.pending.push({ ...projection, receivedAt: Date.now() });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    if (!this.coalesceMs || URGENT.has(observation.kind)) this.flush();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.stopped || !this.pending.length) return;
    const records = this.pending.splice(0), content = records.map(record => record.text).join('\n');
    this.log({ type: 'context.prepared', sources: records.map(({ text, ...source }) => source), content });
    // All observations remain in order. In-flight ACKs do not stall new events.
    this.context.add('thinking', content, null, this.label);
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.pending.length = 0; }
}
