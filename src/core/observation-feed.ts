import { createHash } from 'node:crypto';
import type { AgentDefinition, ObservationKind, TurnState } from './adapter.ts';
import { estimatedTokens } from './text-fragments.ts';
import { thinkingText } from './context-text.ts';
import { feedLabel } from './prompts.ts';
import type { AppendKind } from './context-queue.ts';

type Agent = Pick<AgentDefinition, 'profile' | 'context'>;
/** What the feed needs from an observation. */
export interface FeedObservation { kind: string; name?: string; text: string; state?: TurnState }

// Complete prose is never trimmed or deduplicated. Urgent kinds flush without
// waiting for the collection window.
const PROSE = new Set<string>(['prompt', 'text', 'attention', 'turn_end', 'turn_failed', 'task_completed', 'session_end'] satisfies ObservationKind[]);
const URGENT = new Set<string>(['prompt', 'tool_failure', 'attention', 'turn_end', 'turn_failed', 'task_completed', 'session_end'] satisfies ObservationKind[]);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const excerpt = (value: string, limit: number) => {
  const chars = Array.from(value), n = Math.floor(limit / 2);
  return chars.length <= limit ? value : { excerpt: chars.slice(0, n).join('') + ` … [${chars.length} chars; excerpt] … ` + chars.slice(-n).join(''), originalCharacters: chars.length };
};
interface ContextRecord { id: number; hook: string; historical?: true; data: any; [stateKey: string]: unknown }
interface Fitted { text: string; reducedFields: string[] }

// Budget tool detail, never the operator's request or the agent's prose. Select
// excerpts against the whole record so short results retain all their fields.
function fit(agent: Agent, record: ContextRecord, budget: number, stateKey: string): Fitted {
  const full = JSON.stringify(record);
  let members = 0;
  const count = (value: unknown) => { if (!value || typeof value !== 'object') return; for (const v of Object.values(value)) { if (++members > budget / 2) return; count(v); } };
  count(record.data);
  const wide = members > budget / 2;
  if (!wide && estimatedTokens(full) <= budget) return { text: full, reducedFields: [] };
  let reducedFields: string[] = [];
  const shrink = (value: unknown, limit: number, field = 'data'): unknown => {
    if (typeof value === 'string') {
      const result = excerpt(value, limit);
      if (result !== value) reducedFields.push(field);
      return result;
    }
    if (Array.isArray(value)) return value.map((v, i) => shrink(v, limit, `${field}.${i}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, limit, `${field}.${k}`)]));
    return value;
  };
  let low = 24, high = full.length, best: Fitted | undefined;
  while (!wide && low <= high) {
    const limit = Math.floor((low + high) / 2);
    reducedFields = [];
    const text = JSON.stringify({ ...record, data: shrink(record.data, limit), partial: true });
    if (estimatedTokens(text) <= budget) { best = { text, reducedFields: [...reducedFields] }; low = limit + 1; }
    else high = limit - 1;
  }
  if (best) return best;
  // Thousands of small array/object members can exceed the allowance even
  // without long strings. Retain the outcome and identify the omitted body.
  const data = record.data;
  const essentials = agent.context.essentials(data);
  for (let limit = Math.min(2000, full.length); limit >= 0; limit = Math.floor(limit / 2) - 1) {
    const text = JSON.stringify({ ...record, partial: true, data: { ...shrink(essentials, Math.max(24, limit)) as object,
      ...(limit ? { detail: excerpt(JSON.stringify(data), limit) } : {}) } });
    if (estimatedTokens(text) <= budget) return { text, reducedFields: ['wide tool object'] };
  }
  return { text: JSON.stringify({ id: record.id, hook: record.hook, [stateKey]: record[stateKey],
    ...(record.historical ? { historical: true } : {}), partial: true, detail: 'Wide tool record retained in local hook log' }), reducedFields: ['wide tool object'] };
}

export interface Projection extends Fitted { sourceHash: string; name: string; important: boolean; tokens: number }

// Turns one observation into the context record Live receives.
export class ObservationProjector {
  agent: Agent;
  stateKey: string;
  seen = new Map<string, string>();
  sequence = 0;
  state: TurnState = 'unknown';
  constructor(agent: Agent) { this.agent = agent; this.stateKey = `${agent.profile.id}_turn_state`; }
  // The adapter records the agent's turn state on each observation.
  observe(observation: FeedObservation): TurnState {
    if (observation.state) this.state = observation.state;
    return this.state;
  }
  project(observation: FeedObservation, { budget = 1200, historical = false, state = this.observe(observation) }: { budget?: number; historical?: boolean; state?: TurnState } = {}): Projection {
    let data: any;
    try { data = JSON.parse(thinkingText(observation.text)); } catch { data = { text: observation.text }; }
    const name = observation.name ?? 'observation', id = ++this.sequence;
    const prose = PROSE.has(observation.kind);
    const newStrings: { hash: string; value: string; field: string }[] = [];
    const clean = (value: unknown, field = 'data'): unknown => {
      if (!prose && typeof value === 'string' && value.length >= 80) {
        const hash = digest(value);
        if (this.seen.has(hash)) return { same_as: this.seen.get(hash) };
        newStrings.push({ hash, value, field });
      }
      if (Array.isArray(value)) return value.map((v, i) => clean(v, `${field}.${i}`));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([k]) => field !== 'data' || !this.agent.context.isMetadata(k, name))
        .map(([k, v]) => [k, clean(v, `${field}.${k}`)]));
      return value;
    };
    const record: ContextRecord = { id, hook: name, [this.stateKey]: state, ...(historical ? { historical: true } : {}), data: clean(data) };
    const result = prose ? { text: JSON.stringify(record), reducedFields: [] } : fit(this.agent, record, budget, this.stateKey);
    for (const item of newStrings) {
      const full = result.text.includes(JSON.stringify(item.value));
      // A repeat of an excerpt is still an excerpt. Never imply that Live has
      // seen the complete original merely because it is saved on this machine.
      this.seen.set(item.hash, `hook ${id}${result.reducedFields.includes('wide tool object') ? '' : ' ' + item.field}${full ? ' (complete)' : ' (excerpt only; full value remains local)'}`);
    }
    if (this.seen.size > 2048) this.seen = new Map([...this.seen].slice(-1024));
    return { ...result, sourceHash: digest(observation.text), name, important: prose || URGENT.has(observation.kind), tokens: estimatedTokens(result.text) };
  }
}

/** Where the feed sends prepared context. */
export interface ContextTarget {
  inFlightTokens: number;
  tokensPerSecond: number;
  queue: unknown[];
  add(kind: AppendKind, text: string, delegationId?: string | null, source?: string): void;
}

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
  constructor(context: ContextTarget, log: (event: Record<string, unknown>) => void, { agent, coalesceMs = 250 }: { agent: Agent; coalesceMs?: number }) {
    this.context = context; this.log = log; this.coalesceMs = coalesceMs;
    this.projector = new ObservationProjector(agent); this.label = feedLabel(agent);
  }
  add(observation: FeedObservation, historical = false) {
    if (this.stopped) return;
    const receivedAt = Date.now(), state = this.projector.observe(observation);
    this.pending.push({ ...this.projector.project(observation, { historical, state }), receivedAt });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    if (!this.coalesceMs || (URGENT.has(observation.kind) && !historical)) this.flush();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.stopped || !this.pending.length) return;
    const records = this.pending.splice(0), content = records.map(record => record.text).join('\n');
    this.log({ type: 'context.prepared', representation: 'complete prose; bounded tool detail',
      sources: records.map(({ text, ...source }) => source), content });
    // All observations remain in order. In-flight ACKs do not stall new events,
    // and a burst never silently drops assistant paragraphs or whole events.
    this.context.add('thinking', content, null, this.label);
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.pending.length = 0; }
}
