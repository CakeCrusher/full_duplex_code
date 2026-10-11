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
}
// OpenAI keeps stored recordings for 30 days.
export const RECORDING_MS = 30 * 24 * 60 * 60 * 1000;
// Live's startup input: at most 128 messages and 8,192 tokens in all.
export const INPUT_MESSAGES = 128, INPUT_TOKENS = 8192;
const MESSAGE_TOKENS = 8, MARGIN_TOKENS = 256, TURN_CHARS = 4000, KEPT_TURNS = 256;

// A stored session that dropped instead of closing can be forked too, once OpenAI has finished
// storing it: a probe's fork failed 0.35 s after the drop ("not found") and worked about 6 s after.
export const DROPPED_FORK_MS = 8000;
export const forkable = (record: ResumeRecord, now = Date.now()) =>
  Boolean(record.liveSessionId && record.stored && record.endedAt && now - record.endedAt < RECORDING_MS && (record.finalized || now - record.endedAt >= DROPPED_FORK_MS));
export const planFor = (record: ResumeRecord, mode: 'resume' | 'fresh'): ResumePlan =>
  mode === 'fresh' ? 'fresh' : forkable(record) ? 'fork' : record.turns.length ? 'seed' : 'fresh';

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
      return Array.isArray(data.turns) && data.turns.every((t: Turn) => ['operator', 'intermediary'].includes(t?.role) && typeof t.text === 'string') ? data : undefined;
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
