// Learning the operator's standing instructions, optional: on when TYPESAFE_API_KEY
// is set. After each thing the operator says, Jev (TypeSafe System One, a calibrated
// judge) estimates whether it tells the voice companion how to behave toward them
// from now on. If so, the instruction joins this companion's instructions right away
// (voice-sessions.ts gives it an ID the operator can remove it by). Run on all 869
// recorded utterances, it added 20; checked against the 291 labeled by hand, it
// added 14 of 24 lasting instructions, 5 borderline ones and nothing else.

export interface LearnedInstruction { text: string; scope: 'session' | 'always'; behave: number; design: number; lasting: string }
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
  onLearn: (instruction: LearnedInstruction) => void;
  constructor({ apiKey, onLearn, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; onLearn: (instruction: LearnedInstruction) => void; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.onLearn = onLearn; this.log = log; this.fetch = fetch;
  }
  /** Asks Jev about one utterance; learns it when it is a lasting instruction to the companion. */
  async consider({ utterance, previous = '', companion = '' }: Utterances): Promise<LearnedInstruction | undefined> {
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
    const instruction: LearnedInstruction = { text: kept === text ? text : `${kept.trim()}…`, scope: lasting === 'always' ? 'always' : 'session', behave, design, lasting };
    this.onLearn(instruction);
    return instruction;
  }
}
