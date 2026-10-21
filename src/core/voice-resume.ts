import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { estimatedTokens } from './text-fragments.ts';
import type { Turn } from './voice-history.ts';

/** How a voice session starts: from a fork of the stored last session, seeded with the conversation's text, or without it. */
export type ResumePlan = 'fork' | 'seed' | 'fresh';
/** What resuming one agent session's voice needs, kept across voice sessions and restarts of fdc. */
export interface ResumeRecord {
  /** The last GPT Live session, whether OpenAI stores it, and whether it closed cleanly, finalizing its recording. */
  liveSessionId?: string; stored: boolean; finalized: boolean; endedAt?: number;
  /** The spoken conversation since the last Start fresh, oldest first. */
  turns: Turn[];
  /** The companion's added instructions, to list again after a restart; and those in force in the last session when it ended, which a fork inherits. */
  instructions?: SavedInstruction[]; inForce?: SavedInstruction[];
  /** Agent updates GPT Live had received when the last session ended (a time), and the last context record's number, which a fork continues. */
  deliveredThrough?: number; lastRecordId?: number;
  /** How many instructions Jev has learned for this agent session, so IDs never repeat. */
  learnedCount?: number;
  /** A session whose fork OpenAI connected but never started: Resume rebuilds the conversation from its text instead. */
  forkFailed?: string;
  /** Which of fdc's own instructions the last session started with (a hash): a fork keeps a session's first instructions. */
  prompt?: string;
  /** All the instructions it started with, fdc's own and the companion's (a hash), and the page text in them ('' for none). */
  firstInstructions?: string; pageText?: string;
  /** The page and brief GPT Live was last told, and how full its context has been since the session a fork continues started. */
  told?: string; briefed?: string; context?: number;
}
export interface SavedInstruction { id: string; text: string; learned?: string; learnedIn?: string }
// OpenAI keeps stored recordings for 30 days.
export const RECORDING_MS = 30 * 24 * 60 * 60 * 1000;
// Live's startup input: at most 128 messages and 8,192 tokens in all.
export const INPUT_MESSAGES = 128, INPUT_TOKENS = 8192;
const MESSAGE_TOKENS = 8, MARGIN_TOKENS = 256, TURN_CHARS = 4000, KEPT_TURNS = 256;

// A stored session that dropped instead of closing can be forked too, once OpenAI has finished
// storing it: a probe's fork failed 0.35 s after the drop ("not found") and worked about 6 s after.
export const DROPPED_FORK_MS = 8000;
export const forkable = (record: ResumeRecord, now = Date.now()) =>
  Boolean(record.liveSessionId && record.stored && record.forkFailed !== record.liveSessionId && record.endedAt && now - record.endedAt < RECORDING_MS && (record.finalized || now - record.endedAt >= DROPPED_FORK_MS));
// A fork keeps the instructions its session first started with (OpenAI: "Forks inherit the GPT-Live model, voice, and
// original instructions"), and every brief appended since: after fdc's own instructions change, the conversation is
// rebuilt from its text instead, under today's (and so is one from before fdc kept track).
export const planFor = (record: ResumeRecord, mode: 'resume' | 'fresh', prompt?: string): ResumePlan =>
  mode === 'fresh' ? 'fresh' : forkable(record) && (!prompt || record.prompt === prompt) ? 'fork' : record.turns.length ? 'seed' : 'fresh';

// A fork keeps the instructions its first session started with; what was appended since (instructions too) is conversation:
// it carries over, but a later appended instruction can displace an earlier one (Oct 21: "end every answer with pineapple"
// was dropped once "start every answer with Captain" followed), and when the context passes 90% GPT Live keeps only the first
// instructions and about 8,000 tokens of the rest. So a wake forks while the context has stayed under WAKE_FORK_CONTEXT
// (room for the session it resumes), and the startup stays short: a fork took 2.1 s at 15% full, 4.2 s at 35%, 7.3 s at
// 56% and 8.5 s at 75% (Oct 21; once 17.7 s), a seeded session about 1.7 s. After a wake's fork fails, wakes seed for
// WAKE_FORK_BACKOFF_MS rather than wait on another.
export const WAKE_FORK_CONTEXT = .6, WAKE_FORK_BACKOFF_MS = 10 * 60 * 1000;
// A page's text changes a little as it is used (a deck's "12 / 30" counter): up to this many characters, it's the same page.
export const PAGE_CHANGED_CHARS = 8;
/** How many characters differ between two texts, from their first difference to their last. */
export function changedChars(a: string, b: string) {
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length, b.length) - start - end;
}
/**
 * A wake from Standby resumes the session it paused (a fork keeps everything GPT Live had) while that session's first
 * instructions are still the ones in force now (fdc's own and the companion's, as hashes, and the page on the stage, as
 * text; undefined: the page couldn't be read) and its context has room. Otherwise it starts a new session with all of
 * them in its instructions, seeded with the conversation. Returns the plan and, for a seed, why it doesn't fork.
 */
export function wakePlanFor(record: ResumeRecord, now: { prompt: string; instructions: string; pageText?: string }, forkFailedLately = false): [ResumePlan, string?] {
  const fallback = record.turns.length ? 'seed' : 'fresh';
  if (planFor(record, 'resume', now.prompt) !== 'fork') return [fallback, 'not forkable'];
  if (forkFailedLately) return [fallback, 'a fork failed lately'];
  if (record.firstInstructions !== now.instructions) return [fallback, 'the instructions changed'];
  if ((record.context ?? 0) >= WAKE_FORK_CONTEXT) return [fallback, `its context reached ${Math.round(record.context! * 100)}%`];
  if (now.pageText !== undefined && changedChars(record.pageText ?? '', now.pageText) > PAGE_CHANGED_CHARS) return [fallback, 'the page changed'];
  return ['fork'];
}

const message = (role: 'user' | 'assistant', text: string) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const tokens = (input: readonly any[]) => input.reduce((n, item) => n + MESSAGE_TOKENS + estimatedTokens(item.content[0].text), 0);
/** The newest turns that fit beside the startup input already there, as operator (user) and GPT Live (assistant) messages. */
export function seedInput(startup: readonly any[], turns: readonly Turn[]) {
  let room = INPUT_TOKENS - MARGIN_TOKENS - tokens(startup);
  const seeded = [];
  for (let i = turns.length - 1; i >= 0 && startup.length + seeded.length < INPUT_MESSAGES; i--) {
    const { role, text } = turns[i];
    const next = message(role === 'operator' ? 'user' : 'assistant', text.length > TURN_CHARS ? `…${text.slice(-TURN_CHARS)}` : text);
    room -= tokens([next]);
    if (room < 0) break;
    seeded.unshift(next);
  }
  return [...startup, ...seeded];
}

// One small private file per agent session, beside the usage ledger.
export class ResumeStore {
  dir: string;
  constructor(dir: string) { this.dir = dir; }
  file(sessionId: string) { return path.join(this.dir, `${/^[\w.-]{1,100}$/.test(sessionId) ? sessionId : createHash('sha256').update(sessionId).digest('hex')}.json`); }
  load(sessionId: string): ResumeRecord | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(sessionId), 'utf8'));
      const instructions = (list: unknown) => list === undefined || Array.isArray(list) && list.every(i => typeof i?.id === 'string' && typeof i.text === 'string' && (i.learned === undefined || typeof i.learned === 'string'));
      return Array.isArray(data.turns) && data.turns.every((t: Turn) => ['operator', 'intermediary'].includes(t?.role) && typeof t.text === 'string') && instructions(data.instructions) && instructions(data.inForce) ? data : undefined;
    } catch { return undefined; }
  }
  save(sessionId: string, record: ResumeRecord) {
    record.turns = record.turns.slice(-KEPT_TURNS);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(sessionId), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
