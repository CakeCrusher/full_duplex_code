// The Jev audit: every call fdc makes to Jev (jev.ts), one line each in the run's jev.jsonl, owner-only, beside the run's
// events.jsonl (whose jev.read line has the same ID). A line holds what fdc asked, as configured (where, which model, how
// long it waited, the features on, the likelihood from which each answer changes what fdc does) and as sent (the state
// and the questions); what Jev answered, as returned, or why it didn't; and what fdc did with the answers (the decision).
// That is enough to see why fdc did what it did, and to ask Jev the same again. A call is written once fdc has acted on
// it; one fdc hasn't finished acting on within 30 s, or still open when fdc stops, as it is; a failed one at once.
import fs from 'node:fs';

/** One call to Jev, as recorded. */
export interface JevCall {
  id: string; at: number; trigger: string;
  /** The request the operator's words go to the agent by (events.jsonl, delegation-audit.jsonl), when read for one; for words already sent (trigger unsent), how they went. */
  requestId?: string; handOff?: string;
  config: { url: string; model: string; timeoutMs: number; features: string[]; thresholds: Record<string, number> };
  state: Record<string, string>; questions: Record<string, unknown>;
  ms: number; status?: number;
  /** Jev's answers as returned; or why there are none. */
  answers?: unknown; error?: string;
  /** What fdc did with the answers: the voice tool's own actions and the job delegation (turn.ts), the page (presenter.ts), the learner and the tuner (bridge.ts, consider). */
  decision?: Record<string, unknown>;
}

export class JevAudit {
  file: string; clean: (text: string) => string; waitMs: number;
  pending = new Map<string, { call: JevCall; timer: NodeJS.Timeout }>();
  closed = false;
  constructor({ file, clean = text => text, waitMs = 30000 }: { file: string; clean?: (text: string) => string; waitMs?: number }) {
    this.file = file; this.clean = clean; this.waitMs = waitMs;
  }
  /** A call Jev answered waits for what fdc does with it; a failed one is written at once. */
  called(call: JevCall) {
    if (call.error !== undefined || this.closed) return this.write(call);
    const timer = setTimeout(() => this.settle(call.id), this.waitMs);
    timer.unref?.();
    this.pending.set(call.id, { call, timer });
  }
  /** What fdc did with call `id`'s answers, added to its record; `done` writes it. */
  decided(id: string | undefined, decision: Record<string, unknown>, done = false) {
    const entry = id ? this.pending.get(id) : undefined;
    if (!entry) return;
    entry.call.decision = { ...entry.call.decision, ...decision };
    if (done) this.settle(entry.call.id);
  }
  settle(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(id);
    this.write(entry.call);
  }
  /** fdc is stopping: the calls still open are written as they are, and later ones at once. */
  close() { this.closed = true; for (const id of [...this.pending.keys()]) this.settle(id); }
  /** Never throws: the audit only records. */
  write(call: JevCall) { try { fs.appendFileSync(this.file, this.clean(JSON.stringify(call)) + '\n', { mode: 0o600 }); } catch {} }
}
