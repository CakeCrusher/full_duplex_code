// Learning the operator's standing instructions, optional: on when TYPESAFE_API_KEY is set.
// With each reading of the operator's words (jev.ts), Jev (TypeSafe System One, a calibrated
// judge) estimates whether their latest words tell the voice companion how to behave toward
// them from now on. If so, the instruction joins this companion's instructions right away
// (voice-sessions.ts gives it an ID the operator can remove it by). Run on all 869 recorded
// utterances, it added 20; checked against the 291 labeled by hand, it added 14 of 24 lasting
// instructions, 5 borderline ones and nothing else.

import fs from 'node:fs';
import { BEHAVE, DESIGN, type Reading } from './jev.ts';

export interface LearnedInstruction { text: string; scope: 'session' | 'always'; behave: number; design: number; lasting: string; /** What the operator said, and the conversation Jev read it in, for writing the instruction. */ said?: string; transcript?: string; /** The request to the harness it came from. */ requestId?: string }
export interface Judged { requestId?: string; said: string; behave: number; design: number; lasting: string; learned: boolean }

export class InstructionLearner {
  log: (event: Record<string, unknown>) => void;
  onLearn: (instruction: LearnedInstruction) => void;
  /** Every judgment, learned or not, for the page. */
  onJudged?: (judged: Judged) => void;
  constructor({ onLearn, onJudged, log }: { onLearn: (instruction: LearnedInstruction) => void; onJudged?: (judged: Judged) => void; log: (event: Record<string, unknown>) => void }) {
    this.onLearn = onLearn; this.onJudged = onJudged; this.log = log;
  }
  /** Learns the latest words Jev read when they are a lasting instruction to the companion. */
  consider({ said, transcript, instruction }: Reading, requestId?: string): LearnedInstruction | undefined {
    const text = said.replace(/\s+/g, ' ').trim();
    if (!instruction || text.split(' ').length < 3) return;
    const { behave, design, lasting } = instruction;
    this.log({ type: 'instruction.judged', behave, design, lasting, requestId });
    const learned = behave >= BEHAVE && design < DESIGN && lasting !== 'this_moment';
    this.onJudged?.({ requestId, said: text, behave, design, lasting, learned });
    if (!learned) return;
    // What gets kept is the operator's own words, within an appended instruction's size limit.
    let kept = text; while (Buffer.byteLength(kept) > 400) kept = kept.slice(0, -10);
    const learnedInstruction: LearnedInstruction = { text: kept === text ? text : `${kept.trim()}…`, scope: lasting === 'always' ? 'always' : 'session', behave, design, lasting, said: text, transcript, requestId };
    this.onLearn(learnedInstruction);
    return learnedInstruction;
  }
}

/**
 * The instructions Jev learned, across sessions and companions, so that a later session can take
 * the operator's preferences into account (Jev's tuning). Owner-only; a removal is recorded too.
 */
export class LearnedLog {
  file: string;
  constructor(file: string) { this.file = file; }
  add(entry: { session?: string; id: string; text: string; scope: string }) { this.write({ ...entry }); }
  remove(entry: { session?: string; id: string }) { this.write({ ...entry, removed: true }); }
  write(entry: Record<string, unknown>) {
    try { fs.appendFileSync(this.file, JSON.stringify({ at: Date.now(), ...entry }) + '\n', { mode: 0o600 }); } catch {}
  }
  /** The newest instructions still in force from other sessions than this one; those meant for their own session only say so. */
  earlier(session?: string, limit = 30): string[] {
    let lines: string[] = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const kept = new Map<string, string>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line), key = `${entry.session}:${entry.id}`;
        if (entry.session === session) continue;
        if (entry.removed) kept.delete(key); else if (typeof entry.text === 'string') kept.set(key, entry.scope === 'always' ? entry.text : `(for that session only) ${entry.text}`);
      } catch {}
    }
    return [...kept.values()].slice(-limit);
  }
}
