import type { Observation } from './adapter.ts';
import type { ObservedAgent } from './agent-observer.ts';
import { contextData } from './context-rules.ts';
import { historyEntry, historyOmitted, spokenLine } from './prompts.ts';
import type { Utterance } from './voice-history.ts';

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

/** Something that happened, as fdc keeps it: one of the agent's events, or an utterance of the voice conversation. */
export type HistoryItem = Pick<Observation, 'name' | 'text'> | Pick<Utterance, 'role' | 'text'>;

/**
 * The most recent of what happened, oldest first, within a byte allowance: the agent's events filtered as live context is
 * (the adapter's table, context-rules.ts), the conversation as the agent reads it (spokenLine); what doesn't fit is
 * counted, not shown. A new voice connection starts from it (Live's startup input is available at once, unlike timed
 * appends: kept under its 8,192-token limit with a conservative byte bound), and Jev reads the operator's words in it.
 * Older events stay in the local log and are never replayed: a long session would otherwise bury the present under
 * minutes of backlog.
 */
export function recentHistory(agent: ObservedAgent, items: readonly HistoryItem[], maxBytes = 7000, itemBytes = 2400) {
  const budget = maxBytes - OMISSION_RESERVE, entries: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0 && budget > 0; i--) {
    const item = items[i];
    let entry: string;
    if ('role' in item) entry = `${headAndTail(spokenLine(item), Math.min(itemBytes, budget - 64))}\n`;
    else {
      const data = contextData(agent, item);
      if (data === undefined) continue;
      const record = headAndTail(JSON.stringify(data), Math.min(itemBytes, budget - 64));
      if (!record) break;
      entry = historyEntry(agent, record);
    }
    if (used + Buffer.byteLength(entry) > budget) break;
    entries.unshift(entry); used += Buffer.byteLength(entry);
  }
  const omitted = items.length - entries.length;
  const note = omitted && entries.length ? historyOmitted(agent, omitted) : '';
  return { text: note + entries.join(''), count: entries.length, omitted };
}
