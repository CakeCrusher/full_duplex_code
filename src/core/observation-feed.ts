import { createHash } from 'node:crypto';
import type { Observation, ObservationKind } from './adapter.ts';
import type { ObservedAgent } from './agent-observer.ts';
import { estimatedTokens } from './text-fragments.ts';
import { contextData } from './context-rules.ts';
import { feedLabel, toolWorkLine } from './prompts.ts';
import type { Floor } from './floor.ts';
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

/**
 * How long a burst of updates is collected before it goes to Live as one batch:
 * the first update waits `firstMs`, each further one adds `perUpdateMs`, and the
 * batch never waits longer than `longestMs`. While the operator holds the floor
 * the batch keeps waiting, within the same limit. Urgent kinds skip the wait for
 * more updates, but not the operator.
 */
export interface Hold { firstMs: number; perUpdateMs: number; longestMs: number }
export const SOFT_HOLD: Hold = { firstMs: 1000, perUpdateMs: 1000, longestMs: 10000 };
// Tool work in one batch above this many tokens becomes a single line saying what
// ran: Live learns that the work happened, and the agent's own words, failures,
// prompts and turn ends still arrive whole.
const COMPACT_TOKENS = 900;

// Collects observations into batches, then sends them to the context queue in order.
export class ObservationFeed {
  context: ContextTarget;
  log: (event: Record<string, unknown>) => void;
  hold: Hold | null;
  floor?: Floor;
  agent: ObservedAgent;
  projector: ObservationProjector;
  label: string;
  pending: (Projection & { kind: string; receivedAt: number })[] = [];
  first = 0; due = 0;
  stopped = false;
  timer: NodeJS.Timeout | null = null;
  constructor(context: ContextTarget, log: (event: Record<string, unknown>) => void, { agent, hold = SOFT_HOLD, floor }: { agent: ObservedAgent; hold?: Hold | null; floor?: Floor }) {
    this.context = context; this.log = log; this.hold = hold; this.floor = floor; this.agent = agent;
    this.projector = new ObservationProjector(agent); this.label = feedLabel(agent);
  }
  add(observation: FeedObservation) {
    if (this.stopped) return;
    const projection = this.projector.project(observation), now = Date.now();
    if (projection) {
      const { firstMs, perUpdateMs, longestMs } = this.hold ?? { firstMs: 0, perUpdateMs: 0, longestMs: 0 };
      if (!this.pending.length) { this.first = now; this.due = now + firstMs; }
      else this.due = Math.min(this.first + longestMs, this.due + perUpdateMs);
      this.pending.push({ ...projection, kind: observation.kind, receivedAt: now });
    }
    // An urgent event sends what is waiting, even when the table leaves the event itself out
    // (a turn end whose text already arrived as a message).
    if (URGENT.has(observation.kind)) this.due = now;
    this.wait();
  }
  // Sends the batch once it is due and the operator has finished, or at the longest hold.
  wait() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.stopped || !this.pending.length) return;
    const now = Date.now(), last = this.first + (this.hold?.longestMs ?? 0);
    if (now < this.due) { this.timer = setTimeout(() => this.wait(), this.due - now); return; }
    if (this.floor?.held(now) && now < last) { this.timer = setTimeout(() => this.wait(), Math.min(250, last - now)); return; }
    this.flush();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.stopped || !this.pending.length) return;
    const records = this.pending.splice(0), tools = records.filter(record => record.kind === 'tool');
    let lines = records.map(record => record.text);
    if (tools.reduce((sum, record) => sum + record.tokens, 0) > COMPACT_TOKENS) {
      const at = records.indexOf(tools[0]);
      lines = records.flatMap((record, i) => i === at ? [toolWork(this.agent, tools)] : record.kind === 'tool' ? [] : [record.text]);
    }
    const content = lines.join('\n');
    this.log({ type: 'context.prepared', sources: records.map(({ text, ...source }) => source), content, compacted: lines.length < records.length ? tools.length : undefined });
    // All observations remain in order. In-flight ACKs do not stall new events.
    this.context.add('thinking', content, null, this.label);
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.pending.length = 0; }
}

// One line for a batch of tool work: the finished calls by tool, when the adapter names them.
function toolWork(agent: ObservedAgent, tools: { name: string; text: string }[]) {
  const names = tools.map(record => agent.toolCall?.(record.name, JSON.parse(record.text).data)).filter((name): name is string => !!name);
  const counts = [...names.reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map<string, number>())];
  return toolWorkLine(agent, counts.length ? counts.map(([name, n]) => `${n} ${name} call${n > 1 ? 's' : ''}`).join(', ') : `${tools.length} tool events`);
}
