import { createHash } from 'node:crypto';
import { estimatedTokens } from './text-fragments.js';
import { thinkingText } from './context.js';

const metadata = new Set(['session_id', 'transcript_path', 'scratchpad_dir', 'permission_mode', 'prompt_id', 'effort', 'turn_id', 'stop_hook_active', 'hook_event_name', 'tool_use_id', 'message_id', 'index', 'final', 'session_crons']);
const complete = new Set(['MessageDisplay', 'Stop', 'UserPromptSubmit', 'StopFailure', 'PermissionRequest', 'PermissionDenied', 'Elicitation', 'TaskCompleted', 'SessionEnd']);
const immediate = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Elicitation', 'TaskCompleted', 'SessionEnd']);
const digest = text => createHash('sha256').update(text).digest('hex');
const excerpt = (value, limit) => {
  const chars = Array.from(value), n = Math.floor(limit / 2);
  return chars.length <= limit ? value : { excerpt: chars.slice(0, n).join('') + ` … [${chars.length} chars; excerpt] … ` + chars.slice(-n).join(''), originalCharacters: chars.length };
};

// Budget tool detail, never the operator's request or Claude's prose. Select
// excerpts against the whole record so short results retain all their fields.
function fit(record, budget) {
  const full = JSON.stringify(record);
  let members = 0;
  const count = value => { if (!value || typeof value !== 'object') return; for (const v of Object.values(value)) { if (++members > budget / 2) return; count(v); } };
  count(record.data);
  const wide = members > budget / 2;
  if (!wide && estimatedTokens(full) <= budget) return { text: full, reducedFields: [] };
  let reducedFields = [];
  const shrink = (value, limit, field = 'data') => {
    if (typeof value === 'string') {
      const result = excerpt(value, limit);
      if (result !== value) reducedFields.push(field);
      return result;
    }
    if (Array.isArray(value)) return value.map((v, i) => shrink(v, limit, `${field}.${i}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, limit, `${field}.${k}`)]));
    return value;
  };
  let low = 24, high = full.length, best;
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
  const data = record.data, result = data.tool_response;
  const essentials = { tool_name: data.tool_name, error: data.error, exitCode: result?.exitCode ?? result?.exit_code,
    stderr: result?.stderr, file_path: data.tool_input?.file_path ?? result?.filePath };
  for (let limit = Math.min(2000, full.length); limit >= 0; limit = Math.floor(limit / 2) - 1) {
    const text = JSON.stringify({ ...record, partial: true, data: { ...shrink(essentials, Math.max(24, limit)),
      ...(limit ? { detail: excerpt(JSON.stringify(data), limit) } : {}) } });
    if (estimatedTokens(text) <= budget) return { text, reducedFields: ['wide tool object'] };
  }
  return { text: JSON.stringify({ id: record.id, hook: record.hook, claude_turn_state: record.claude_turn_state,
    ...(record.historical ? { historical: true } : {}), partial: true, detail: 'Wide tool record retained in local hook log' }), reducedFields: ['wide tool object'] };
}

export class HookContext {
  constructor() { this.seen = new Map(); this.sequence = 0; this.state = 'unknown'; }
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
  project(observation, { budget = 1200, historical = false, state = this.observe(observation) } = {}) {
    let data;
    try { data = JSON.parse(thinkingText(observation.text)); } catch { data = { text: observation.text }; }
    const name = observation.name ?? data.hook_event_name ?? data.source ?? 'transcript', id = ++this.sequence;
    const prose = complete.has(name) || (name === 'transcript' && ['user', 'assistant'].includes(data.role) && data.block?.type === 'text');
    const newStrings = [];
    const clean = (value, field = 'data') => {
      if (!prose && typeof value === 'string' && value.length >= 80) {
        const hash = digest(value);
        if (this.seen.has(hash)) return { same_as: this.seen.get(hash) };
        newStrings.push({ hash, value, field });
      }
      if (Array.isArray(value)) return value.map((v, i) => clean(v, `${field}.${i}`));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([k]) => field !== 'data' || (!metadata.has(k) && (k !== 'cwd' || name === 'CwdChanged')))
        .map(([k, v]) => [k, clean(v, `${field}.${k}`)]));
      return value;
    };
    const record = { id, hook: name, claude_turn_state: state, ...(historical ? { historical: true } : {}), data: clean(data) };
    const result = prose ? { text: JSON.stringify(record), reducedFields: [] } : fit(record, budget);
    for (const item of newStrings) {
      const full = result.text.includes(JSON.stringify(item.value));
      // A repeat of an excerpt is still an excerpt. Never imply that Live has
      // seen the complete original merely because it is saved on this machine.
      this.seen.set(item.hash, `hook ${id}${result.reducedFields.includes('wide tool object') ? '' : ' ' + item.field}${full ? ' (complete)' : ' (excerpt only; full value remains local)'}`);
    }
    if (this.seen.size > 2048) this.seen = new Map([...this.seen].slice(-1024));
    return { ...result, sourceHash: digest(observation.text), name, important: prose || immediate.has(name), tokens: estimatedTokens(result.text) };
  }
}

export class HookFeed {
  constructor(context, log, { coalesceMs = 250 } = {}) {
    Object.assign(this, { context, log, coalesceMs });
    this.projector = new HookContext(); this.pending = []; this.stopped = false;
  }
  add(observation, historical = false) {
    if (this.stopped) return;
    const receivedAt = Date.now(), state = this.projector.observe(observation);
    this.pending.push({ ...this.projector.project(observation, { historical, state }), receivedAt });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    if (!this.coalesceMs || (immediate.has(observation.name) && !historical)) this.flush();
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.stopped || !this.pending.length) return;
    const records = this.pending.splice(0), content = records.map(record => record.text).join('\n');
    this.log({ type: 'context.prepared', representation: 'complete prose; bounded tool detail',
      sources: records.map(({ text, ...source }) => source), content });
    // All observations remain in order. In-flight ACKs do not stall new hooks,
    // and a burst never silently drops assistant paragraphs or whole events.
    this.context.add('thinking', content, null, 'Claude hooks');
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.pending.length = 0; }
}
