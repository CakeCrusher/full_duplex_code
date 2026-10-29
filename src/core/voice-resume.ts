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
  /** The page state GPT Live was last told (pageSeen), and how full its context was at the end (GPT Live's last report). */
  briefed?: string; context?: number;
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
// original instructions"): after fdc's own instructions change, the conversation is rebuilt from its text instead, under
// today's (and so is one from before fdc kept track).
export const planFor = (record: ResumeRecord, mode: 'resume' | 'fresh', prompt?: string): ResumePlan =>
  mode === 'fresh' ? 'fresh' : forkable(record) && (!prompt || record.prompt === prompt) ? 'fork' : record.turns.length ? 'seed' : 'fresh';

// Everything that changes during a conversation is told to GPT Live in it rather than in its instructions: the page on the
// stage, and the operator's learned instructions, which carry over to a fork as conversation (on Oct 21 a later appended
// instruction displaced an earlier one: "end every answer with pineapple" was dropped once "start every answer with
// Captain" followed). Both are told again when GPT Live trims its context (voice-sessions.ts). A fork's startup grows with
// its context, and the operator waits on it: over Oct 19-28, 191 wakes that forked started in a median 2.0 s under 10%
// full, 3.1 s at 10-20%, 5.5 s at 20-30%, 7.1 s at 30-40%, 8.9 s at 40-50% and 10.0 s at 50-60%; 117 that seeded, in 1.7 s
// (90% within 2.4 s) whatever the conversation's length. Once started, GPT Live answers as fast in a full context as in an
// empty one (Oct 28: a median 0.1 to 0.75 s at every tenth). So a wake forks only while the context it continues is small
// (WAKE_FORK_CONTEXT): forking up to 60%, presenting waited 5 to 11 s on each wake (Oct 28). After a wake's fork fails,
// wakes seed for WAKE_FORK_BACKOFF_MS rather than wait on another.
export const WAKE_FORK_CONTEXT = .2, WAKE_FORK_BACKOFF_MS = 10 * 60 * 1000;
/**
 * A wake from Standby resumes the session it paused (a fork keeps everything GPT Live had) while fdc's own instructions
 * are the ones it started with and its context has room; otherwise it starts a new session seeded with the conversation.
 * Returns the plan and, for a seed, why it doesn't fork.
 */
export function wakePlanFor(record: ResumeRecord, prompt: string, forkFailedLately = false): [ResumePlan, string?] {
  const fallback = record.turns.length ? 'seed' : 'fresh';
  if (planFor(record, 'resume', prompt) !== 'fork') return [fallback, 'not forkable'];
  if (forkFailedLately) return [fallback, 'a fork failed lately'];
  if ((record.context ?? 0) >= WAKE_FORK_CONTEXT) return [fallback, `its context was ${Math.round(record.context! * 100)}% full`];
  return ['fork'];
}

const message = (role: 'user' | 'assistant', text: string) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const tokens = (input: readonly any[]) => input.reduce((n, item) => n + MESSAGE_TOKENS + estimatedTokens(item.content[0].text), 0);
/** The newest turns that fit beside the startup input already there (and what goes after them), as operator (user) and GPT Live (assistant) messages. */
export function seedInput(startup: readonly any[], turns: readonly Turn[], after: readonly any[] = []) {
  let room = INPUT_TOKENS - MARGIN_TOKENS - tokens(startup) - tokens(after);
  const seeded = [];
  for (let i = turns.length - 1; i >= 0 && startup.length + seeded.length + after.length < INPUT_MESSAGES; i--) {
    const { role, text } = turns[i];
    const next = message(role === 'operator' ? 'user' : 'assistant', text.length > TURN_CHARS ? `…${text.slice(-TURN_CHARS)}` : text);
    room -= tokens([next]);
    if (room < 0) break;
    seeded.unshift(next);
  }
  return [...startup, ...seeded, ...after];
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
