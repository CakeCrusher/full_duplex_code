// What GPT Live has perceived in this conversation, in order and word for word: what fdc sent it (its startup input, then
// every append: the agent's work, the page, fdc's notes, instructions) and what was said (the operator's speech and its
// own, transcribed). Jev reads the latest of it as each moment's history (bridge.ts, read), so that it judges from the same
// information as the voice companion, with no transformation of its own. Built apart from the agent's raw events, Jev's
// history gave the agent's records a median 93% of its bytes (each tool call often twice, before and after it ran) and
// the conversation 7% (52 hand-offs, Oct 29-30), while GPT Live got one line for a burst of tool work, a reference for a
// repeat, and fdc's notes, which Jev never saw.
// It is kept with the agent session's resume record (voice-resume.ts), as GPT Live keeps its own context: a fork of the
// last voice session continues it; a new session, seeded or fresh, starts it again from its startup input.
import type { Spoken } from './voice-history.ts';
import type { ResumePlan, ResumeRecord } from './voice-resume.ts';
import { spokenLine } from './prompts.ts';

/** How fdc gave GPT Live something: in its startup input, or appended (live-session.ts) as silent context, as something to say, or as an instruction. */
export type SentKind = 'start' | 'thinking' | 'commentary' | 'instructions';
export interface Sent { at: number; kind: SentKind; text: string }
/** One thing GPT Live perceived: something fdc sent it, or a turn of the earlier conversation a new session was seeded with. */
export type PerceivedEntry = Sent | Spoken;

// Each thing fdc sent, as Jev reads it: a line saying how, then the text as GPT Live got it.
const HOW: Record<SentKind, string> = {
  start: '[sent by fdc at the start of the voice connection]',
  thinking: '[sent by fdc as silent context]',
  commentary: '[sent by fdc for the companion to say]',
  instructions: '[sent by fdc as an instruction]',
};
const written = (entry: PerceivedEntry) => 'kind' in entry ? `${HOW[entry.kind]}\n${entry.text}` : spokenLine(entry);
// The end of a text within a byte allowance, from the start of a line when one is within it.
function endOf(text: string, maxBytes: number) {
  const chars = Array.from(text);
  let start = chars.length, bytes = 0;
  while (start > 0 && bytes + Buffer.byteLength(chars[start - 1]) <= maxBytes) bytes += Buffer.byteLength(chars[--start]);
  const end = chars.slice(start).join(''), newline = end.indexOf('\n');
  return newline >= 0 && newline < end.length - 1 ? end.slice(newline + 1) : end;
}
/** An entry cut to its end, its label kept. */
const cut = (entry: PerceivedEntry, maxBytes: number) => {
  const head = 'kind' in entry ? `${HOW[entry.kind]}\n…` : spokenLine({ ...entry, text: '…' });
  const end = endOf(entry.text, maxBytes - Buffer.byteLength(head) - 1);
  return end.trim() ? ('kind' in entry ? `${head}${end}` : spokenLine({ ...entry, text: `…${end}` })) : undefined;
};

// What a record keeps of what fdc sent: several times what Jev reads (HISTORY_BYTES, jev.ts), so the latest is always whole.
const KEPT_BYTES = 48000;

/** A voice session started: a fork continues what its source perceived; a new session starts again from its startup input. */
export function beginPerceived(record: ResumeRecord, plan: ResumePlan, input: readonly PerceivedEntry[], at = Date.now()) {
  if (plan === 'fork') return;
  record.perceivedSince = at; record.perceived = [];
  for (const entry of input) perceive(record, { ...entry, at });
}
/** Something fdc sent the running session. */
export function perceive(record: ResumeRecord, entry: PerceivedEntry) {
  const kept = record.perceived ??= [];
  kept.push(entry);
  let bytes = kept.reduce((total, e) => total + Buffer.byteLength(e.text), 0);
  while (bytes > KEPT_BYTES && kept.length > 1) bytes -= Buffer.byteLength(kept.shift()!.text);
}
/**
 * The latest of what GPT Live perceived by `until`, within `maxBytes`, oldest first: what fdc sent it, what was said
 * in this conversation's voice connections before this one (record.turns, since the session that started it), and what
 * was said in this one (`spoken`: the words before the latest, as the caller reads them). Whole entries, but for the oldest,
 * cut to its end when only part of it fits.
 */
export function perceivedText(record: ResumeRecord, spoken: readonly Spoken[], until: number, maxBytes: number): string {
  const since = record.perceivedSince ?? 0, thisConnection = spoken[0]?.at ?? Infinity;
  const earlier = record.turns.filter(turn => (turn.at ?? 0) >= since && (turn.at ?? 0) < thisConnection).map(turn => ({ ...turn, at: turn.at ?? 0 }));
  // Sent in the same millisecond as `until` (the latest words' first) counts as before it.
  const entries = [...(record.perceived ?? []).filter(e => e.at <= until), ...earlier, ...spoken]
    .map((entry, order) => ({ entry, order })).sort((a, b) => a.entry.at - b.entry.at || a.order - b.order).map(({ entry }) => entry);
  const kept: string[] = [];
  let room = maxBytes;
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = written(entries[i]), bytes = Buffer.byteLength(text) + 1;
    if (bytes <= room) { kept.unshift(text); room -= bytes; continue; }
    const end = cut(entries[i], room - 1);
    if (end) kept.unshift(end);
    break;
  }
  return kept.join('\n');
}
