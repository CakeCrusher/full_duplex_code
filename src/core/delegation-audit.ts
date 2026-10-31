// The hand-off audit, optional: on when TYPESAFE_API_KEY is set. For each of the operator's turns, the record says what
// came of their words (passed on to the harness, kept from it, sent when voice ended with them unsent, or sent because the
// page couldn't do what they meant), next to Jev's judgment of whether they needed the harness (jev.ts) and the
// conversation Jev read: what was kept is where lost work would show. It only records.
import fs from 'node:fs';

/** What came of the operator's words: passed on (by Jev, or by GPT Live without it), kept from the harness, sent when voice ended, or sent because the page couldn't do what they meant. */
export type HandOff = 'passed' | 'kept' | 'answered' | 'held';

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
