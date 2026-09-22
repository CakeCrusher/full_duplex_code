import { createHash } from 'node:crypto';
import { estimatedTokens } from './text-fragments.js';
import { thinkingText } from './context.js';

const metadata = new Set(['session_id', 'transcript_path', 'scratchpad_dir', 'permission_mode', 'prompt_id', 'effort', 'turn_id', 'stop_hook_active']);
const urgent = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Elicitation', 'TaskCompleted', 'SessionEnd']);
const notable = /\b(error|failed|failure|warning|tests?|passed|saved|wrote|created|requires|caveat|not implemented)\b/i;
const digest = text => createHash('sha256').update(text).digest('hex');
const excerpt = (text, limit) => {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, Math.ceil(limit * .65)).join('') + ` … [${chars.length} chars in local hook log] … ` + chars.slice(-Math.floor(limit * .35)).join('');
};

// This is a view of the hook, not its storage representation. AgentObserver and
// events.jsonl retain the original. No task-specific model or narration engine.
export class HookContext {
  constructor() { this.seen = new Set(); this.state = 'unknown'; }
  observe(observation) {
    let data;
    try { data = JSON.parse(observation.text); } catch { data = {}; }
    const name = observation.name ?? data.hook_event_name ?? data.source ?? 'transcript';
    if (!data.agent_id) {
      if (name === 'UserPromptSubmit' || name === 'PreToolUse') this.state = 'working';
      if (name === 'Stop') this.state = data.background_tasks?.length ? 'working' : 'turn_finished';
      if (name === 'PermissionRequest' || name === 'Elicitation') this.state = 'needs_operator';
      if (name === 'StopFailure') this.state = 'failed';
      if (name === 'SessionEnd') this.state = 'exited';
    }
    return this.state;
  }
  project(observation, { budget = 600, historical = false, state = this.observe(observation) } = {}) {
    const hash = digest(observation.text);
    let data;
    try { data = JSON.parse(thinkingText(observation.text)); }
    catch { data = { text: observation.text }; }
    const name = observation.name ?? data.hook_event_name ?? data.source ?? 'transcript';
    const reduced = [], newHashes = new Set();
    const shrink = (value, key, limit, depth = 0) => {
      if (typeof value === 'string') {
        const fullLimit = ['prompt', 'delta', 'last_assistant_message'].includes(key) ? limit * 6 : limit;
        if (value.length <= fullLimit) return value;
        const id = digest(value).slice(0, 12);
        reduced.push(key);
        if (this.seen.has(id)) return `[Repeated content ${id}; original retained in local hook log]`;
        newHashes.add(id);
        const lines = value.split('\n').filter(line => notable.test(line)).slice(0, 4);
        return { excerpt: excerpt(value, fullLimit), ...(lines.length ? { notableLines: lines.map(line => excerpt(line, Math.min(limit, 180))) } : {}), originalCharacters: value.length, rawId: id };
      }
      if (!value || typeof value !== 'object') return value;
      if (depth > 8) { reduced.push(key); return { excerpt: excerpt(JSON.stringify(value), limit), partial: true }; }
      if (Array.isArray(value)) {
        if (value.length <= 6) return value.map(v => shrink(v, key, limit, depth + 1));
        reduced.push(key);
        const indices = new Set([0, 1, value.length - 2, value.length - 1]);
        value.forEach((v, i) => { if (indices.size < 8 && (typeof v === 'string' ? notable.test(v) : v?.is_error || v?.error)) indices.add(i); });
        return { totalItems: value.length, partial: true, items: [...indices].sort((a, b) => a - b).map(i => ({ index: i, value: shrink(value[i], key, limit, depth + 1) })) };
      }
      return Object.fromEntries(Object.entries(value).filter(([k]) => depth !== 0 || !metadata.has(k)).map(([k, v]) => [k, shrink(v, k, limit, depth + 1)]));
    };
    let view, text;
    for (let limit = 400; ; limit = Math.floor(limit / 2)) {
      reduced.length = 0; newHashes.clear();
      view = { hook: name, claude_turn_state: state, ...(historical ? { historical: true } : {}), data: shrink(data, '', limit) };
      if (reduced.length) view.partial = true;
      text = JSON.stringify(view);
      if (estimatedTokens(text) <= budget || limit <= 25) break;
    }
    if (estimatedTokens(text) > budget) {
      // Exceptionally wide objects need a total bound, not just field limits.
      // Keep an explicit partial view and important scalar fields, never pretend
      // that a clipped nested result is a complete result.
      view = { hook: name, claude_turn_state: state, ...(historical ? { historical: true } : {}), partial: true };
      for (const key of ['error', 'prompt', 'last_assistant_message', 'delta', 'message', 'tool_name', 'agent_id', 'is_error', 'reason', 'tool_response', 'tool_input']) {
        if (data[key] === undefined) continue;
        const value = typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]);
        for (const length of [500, 180, 60]) {
          const candidate = { ...view, [key]: excerpt(value, length) };
          if (estimatedTokens(JSON.stringify(candidate)) <= budget) { view = candidate; break; }
        }
      }
      if (!Object.keys(view).some(key => !['hook', 'claude_turn_state', 'partial'].includes(key))) {
        const candidate = { ...view, fields: Object.keys(data).slice(0, 6), excerpt: excerpt(JSON.stringify(data), 120) };
        if (estimatedTokens(JSON.stringify(candidate)) <= budget) view = candidate;
      }
      text = JSON.stringify(view);
      reduced.push('wide object');
    }
    for (const id of newHashes) this.seen.add(id);
    if (this.seen.size > 2048) this.seen = new Set([...this.seen].slice(-1024));
    return { text, sourceHash: hash, name, important: urgent.has(name), reducedFields: [...new Set(reduced)], tokens: estimatedTokens(text) };
  }
}

export class HookFeed {
  constructor(context, log, { coalesceMs = 500 } = {}) {
    Object.assign(this, { context, log, coalesceMs });
    this.projector = new HookContext(); this.pending = []; this.stopped = false;
  }
  add(observation, historical = false) {
    if (this.stopped) return;
    // Capture lifecycle at receipt even if this observation is later coalesced.
    // A discarded PreToolUse must still mark subsequent observations as working.
    this.pending.push({ observation, historical, receivedAt: Date.now(), state: this.projector.observe(observation) });
    if (this.pending.length > 32) {
      // Keep recent/important state during an exceptional burst. This only
      // coalesces the Live view: every original is already in the local audit.
      let index = this.pending.findIndex(item => !urgent.has(item.observation.name));
      if (index < 0) index = 0;
      const [item] = this.pending.splice(index, 1);
      this.coalesce(item);
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    if (this.coalesceMs === 0 || (urgent.has(observation.name) && !historical)) this.flush();
  }
  coalesce(item) {
    this.coalesced ??= {};
    const name = item.observation.name ?? 'transcript';
    this.coalesced[name] = (this.coalesced[name] ?? 0) + 1;
    this.log({ type: 'context.coalesced', name, sourceHash: digest(item.observation.text), receivedAt: item.receivedAt, reason: 'Burst exceeded the current context allowance; original remains in local audit' });
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.stopped || !this.pending.length) return;
    const backlogSeconds = this.context.inFlightTokens / this.context.tokensPerSecond;
    if (backlogSeconds > 2 || this.context.queue.length) {
      // A bounded pipeline, not one-send-per-ACK serialization. Keep accepting
      // and coalescing raw observations while the existing API work drains.
      this.timer = setTimeout(() => this.flush(), 50);
      return;
    }
    const pressured = backlogSeconds > 1 || this.pending.length > 1;
    let batch = this.pending.splice(0);
    const capacity = Math.max(200, Math.min(1000, this.context.tokensPerSecond * 2.5 - this.context.inFlightTokens));
    const count = Math.max(2, Math.min(8, Math.floor(capacity / 100)));
    if (batch.length > count) {
      const priority = item => item.observation.name === 'Stop' ? 3 : urgent.has(item.observation.name) ? 2 : 1;
      const selected = new Set(batch.map((item, index) => ({ item, index })).sort((a, b) => priority(b.item) - priority(a.item) || b.index - a.index).slice(0, count).map(x => x.item));
      for (const item of batch) if (!selected.has(item)) this.coalesce(item);
      batch = batch.filter(item => selected.has(item)); // Preserve causal order.
    }
    const weights = batch.reduce((n, item) => n + (urgent.has(item.observation.name) ? 6 : 1), 0);
    const records = batch.map(item => {
      const weight = urgent.has(item.observation.name) ? 6 : 1;
      // Routine code/log detail competes with spoken input even before a long
      // ACK backlog develops. Reserve the larger view for requests and outcomes.
      const limit = urgent.has(item.observation.name) ? 600 : 160;
      const budget = pressured ? Math.max(80, Math.min(limit, Math.floor(capacity * weight / weights))) : limit;
      return { ...this.projector.project(item.observation, { budget, historical: item.historical, state: item.state }), receivedAt: item.receivedAt };
    });
    const text = (this.coalesced ? JSON.stringify({ olderObservationsCoalesced: this.coalesced, detail: 'Full observations retained locally; this feed contains the newer and higher-priority observations.' }) + '\n' : '') + records.map(record => record.text).join('\n');
    this.coalesced = null;
    this.log({ type: 'context.prepared', backlogSeconds, representation: pressured ? 'compact' : 'standard', sources: records.map(({ text, ...source }) => source), content: text });
    this.context.add('thinking', `Claude observations, in order. Partial fields are excerpts; full records remain in the local hook log.\n${text}\n`, null, 'Claude hooks');
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.pending.length = 0; }
}
