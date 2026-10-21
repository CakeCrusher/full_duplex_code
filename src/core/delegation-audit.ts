// The hand-off audit, optional: on when TYPESAFE_API_KEY is set. For each request that reaches the harness, the record
// says how it got there (GPT Live passed it on, voice ended with it unsent, or the voice tool sent it), next to Jev's
// judgment of whether it needed the harness (jev.ts) and the conversation Jev read, for learning how often GPT Live and
// Jev disagree, and in which direction. It only records: deciding what reaches the harness is GPT Live's job.
import fs from 'node:fs';

/** Who sent the operator's words on: GPT Live, voice ending (GPT Live had kept them), or the voice tool (the page couldn't do what they meant). */
export type HandOff = 'passed' | 'answered' | 'escalated';

export class DelegationAudit {
  file: string;
  log: (event: Record<string, unknown>) => void;
  constructor({ file, log }: { file: string; log: (event: Record<string, unknown>) => void }) { this.file = file; this.log = log; }
  /** Records what the operator said with what GPT Live did and Jev's judgment (null when Jev couldn't be asked). Never throws. */
  record(entry: { handOff: HandOff; said: string; voiceSessionId?: string | null; delegationId?: string | null; requestId?: string }, needsAgent: number | null, transcript?: string) {
    this.log({ type: 'delegation.audit', handOff: entry.handOff, needsAgent, delegationId: entry.delegationId ?? null });
    // Owner-only, local: the operator's words with both judgments, for learning.
    try { fs.appendFileSync(this.file, JSON.stringify({ at: Date.now(), ...entry, needsAgent, transcript }) + '\n', { mode: 0o600 }); } catch {}
  }
}
