// The page audit: everything that changes the page on the stage or is seen on it, one line each in the run's page.jsonl,
// owner-only, beside events.jsonl and jev.jsonl. A line says who acted (Jev reading the voice's sentence, a phrase the
// voice said, the ring following its words, a switch of tabs, the coding agent's own browser tools, the operator's own
// move), why (the words, and the Jev call when there is one), each command with what the page answered, where the page
// and the ring were before and after, and then, on lines of their own, what GPT Live was told about it, word for word.
// Nothing here changes what is sent or run: it only records, in the one place every page action passes (stage.ts).
// Before, a move had to be pieced together from several events, and where it landed was in none of them.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Where the page is: its address, where the viewer is in words, and what the ring is on (stage-page.js, here). */
export interface PagePlace { url?: string; where?: string; focus?: unknown; ring?: { on: boolean; at: string | null } }
/** One command sent to the page, and what came back from it. */
export interface PageCommand { id: string; say?: string; outcome: 'ran' | 'nothing to do' | 'failed' | 'not reached'; answer?: string }
/** Who caused a page action. */
export type PageActor = 'jev' | 'phrase' | 'ring' | 'tab' | 'agent' | 'operator';
/** Why: the voice's words read for the page, the Jev call that chose the command and its step, or the agent's tool. */
export interface PageCause { said?: string; jevCall?: string; step?: number; tool?: string; input?: unknown }
export interface PageAction {
  by: PageActor; because?: PageCause;
  tabId?: number; commands?: PageCommand[]; before?: PagePlace; after?: PagePlace;
  ms?: number; error?: string;
}

export class PageAudit {
  file: string; clean: (text: string) => string;
  constructor({ file, clean = text => text }: { file: string; clean?: (text: string) => string }) { this.file = file; this.clean = clean; }
  /** Records an action; returns its ID, for what GPT Live is then told about it. */
  action(action: PageAction): string {
    const id = randomUUID();
    this.write({ type: 'action', id, at: Date.now(), ...action });
    return id;
  }
  /** What GPT Live was told about the page, as it was sent: after an action (its ID), or because the page itself changed. */
  told(text: string, action?: string) { this.write({ type: 'told', at: Date.now(), ...action && { action }, text }); }
  /** Never throws: the audit only records. */
  write(line: Record<string, unknown>) { try { fs.appendFileSync(this.file, this.clean(JSON.stringify(line)) + '\n', { mode: 0o600 }); } catch {} }
}
