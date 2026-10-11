import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Learning the operator's standing instructions, optional: on when TYPESAFE_API_KEY
// is set. After each thing the operator says, Jev (TypeSafe System One, a calibrated
// judge) estimates whether it tells the voice companion how to behave toward them
// from now on. If so, the page asks whether to keep it, for this session or always;
// nothing changes without the operator's yes. Kept-always instructions load into
// every later voice session. In an offline test on 291 hand-judged utterances
// (thresholds tuned on one half, measured on the other), about two thirds of what
// it flags is a lasting instruction (nine in ten counting borderline cases), and it
// finds about two thirds of them.

export interface Suggestion { id: string; text: string; scope: 'session' | 'always'; confidence: number }
export interface Utterances { utterance: string; previous?: string; companion?: string }
type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const URL = 'https://api.typesafe.ai/v1/systemone';
const SETTING = "Voice coding session: the operator speaks to a voice companion that answers, reports on a coding agent's work and passes requests on to the agent; the operator is often building this voice tool itself. Utterances are speech-to-text.";
const QUESTIONS = {
  behave: {
    type: 'noul',
    instructions: {
      question: 'Is the operator, in `utterance`, telling the voice companion how to behave toward them from now on (not designing the tool, not asking the coding agent to do something, not a one-off cue)?',
      context: '`previous_operator_utterance` is what the operator said before, and `companion_before` is what the voice companion said just before; use them only as context and judge `utterance`.',
    },
    criteria: {
      true: "A standing request about the companion's own conduct toward the operator for the rest of the conversation or longer: when to speak or stay quiet, how much detail, pace, what to read out, what to relay or delegate.",
      false: 'Designing or discussing the voice tool or GPT Live; a task for the coding agent; a one-off cue or request (go on, next, repeat, stop this sentence); a question about the work.',
    },
  },
  design_talk: {
    type: 'noul',
    instructions: 'Is the operator discussing how a voice tool or GPT Live should be designed or built, as a topic for the coding work, rather than telling this voice companion how to behave?',
    criteria: {
      true: "Talks about the voice tool's design, settings or code, or describes GPT Live's behaviour as a problem to solve.",
      false: 'Speaks to the companion itself about how it should behave now or from now on.',
    },
  },
  lasting: {
    type: 'choice',
    instructions: 'How long does the operator want the voice companion to follow what `utterance` tells it?',
    criteria: { this_moment: 'Only right now, e.g. stop the current sentence or skip this one.', this_session: 'For the rest of this conversation, task or phase.', always: 'In every session: a standing preference.' },
  },
};
// Held-out thresholds from the offline test.
const BEHAVE = .6, DESIGN = .5;

export class InstructionLearner {
  apiKey: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  onSuggest: (suggestion: Suggestion) => void;
  pending = new Map<string, Suggestion>();
  constructor({ apiKey, onSuggest, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; onSuggest: (suggestion: Suggestion) => void; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.onSuggest = onSuggest; this.log = log; this.fetch = fetch;
  }
  /** Asks Jev about one utterance; suggests keeping it when it is a lasting instruction to the companion. */
  async consider({ utterance, previous = '', companion = '' }: Utterances): Promise<Suggestion | undefined> {
    const text = utterance.replace(/\s+/g, ' ').trim();
    if (text.split(' ').length < 3) return;
    const state = { setting: SETTING, utterance: text.slice(0, 600), previous_operator_utterance: previous.slice(0, 400), companion_before: companion.slice(0, 400) };
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const behave = Number(answers?.behave?.noul), design = Number(answers?.design_talk?.noul), lasting = answers?.lasting?.choice;
    this.log({ type: 'instruction.judged', behave, design, lasting });
    if (!(behave >= BEHAVE && design < DESIGN && lasting !== 'this_moment')) return;
    // What gets kept is the operator's own words, within an appended instruction's size limit.
    let kept = text; while (Buffer.byteLength(kept) > 400) kept = kept.slice(0, -10);
    const suggestion: Suggestion = { id: randomUUID(), text: kept === text ? text : `${kept.trim()}…`, scope: lasting === 'always' ? 'always' : 'session', confidence: behave };
    this.pending.set(suggestion.id, suggestion);
    this.onSuggest(suggestion);
    return suggestion;
  }
}

/** Instructions the operator chose to keep always, in the companion's own run folder. */
export class KeptInstructions {
  file: string;
  constructor(root: string) { this.file = path.join(root, '.runs', 'kept-instructions.json'); }
  items(): { text: string; keptAt?: string }[] { try { const items = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(items) ? items.filter(item => typeof item?.text === 'string') : []; } catch { return []; } }
  read(): string[] { return this.items().map(item => item.text); }
  add(text: string) {
    const items = [...this.items().filter(item => item.text !== text), { text, keptAt: new Date().toISOString() }];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
  }
}
