import type { AgentProfile } from './adapter.ts';
import { thinkingText } from './context-text.ts';
import { historyEntry, historyOmitted } from './prompts.ts';

const OMISSION_RESERVE = 160;
// Keep the start and end of an oversized record within a byte allowance.
function headAndTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const chars = Array.from(text);
  const join = (n: number) => `${chars.slice(0, n).join('')} … [${chars.length} chars; full record in the local hook log] … ${chars.slice(-n).join('')}`;
  let low = 0, high = Math.floor(chars.length / 2), best = '';
  while (low <= high) {
    const n = Math.floor((low + high) / 2), candidate = join(n);
    if (Buffer.byteLength(candidate) <= maxBytes) { best = candidate; low = n + 1; } else high = n - 1;
  }
  return best;
}

export function startupHistory(agent: { profile: AgentProfile }, observations: readonly { text: string }[], maxBytes = 7000, itemBytes = 2400) {
  // A new voice connection starts from the most recent work. Live's startup
  // input is available immediately (unlike timed appends); keep it under the
  // 8,192-token limit with a conservative byte bound. Older observations stay
  // in the local log and are never replayed as appends: a long session would
  // otherwise bury the present under minutes of backlog.
  const budget = maxBytes - OMISSION_RESERVE, entries: string[] = [];
  let used = 0;
  for (let i = observations.length - 1; i >= 0 && budget > 0; i--) {
    const record = headAndTail(thinkingText(observations[i].text), Math.min(itemBytes, budget - 64));
    const next = historyEntry(agent, record);
    if (!record || used + Buffer.byteLength(next) > budget) break;
    entries.unshift(next); used += Buffer.byteLength(next);
  }
  const omitted = observations.length - entries.length;
  const note = omitted && entries.length ? historyOmitted(agent, omitted) : '';
  return { text: note + entries.join(''), count: entries.length, omitted };
}
