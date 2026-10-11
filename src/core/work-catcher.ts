// Catching work GPT Live did not pass on, optional: on when TYPESAFE_API_KEY is set.
// A work request that never reaches the agent is the costly error; a question that also
// reaches it costs little. When the operator has been quiet for a while after speaking and
// GPT Live passed nothing on, Jev judges whether what they said needs the agent, and if it
// likely does, the bridge sends it anyway. Offline, on 65 replayed real moments GPT Live
// answered without passing them on: at 0.6 all 13 work requests among them were caught,
// and 11 of the 52 questions also went to the agent.
type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const URL = 'https://api.typesafe.ai/v1/systemone';
const SETTING = 'An operator talks by voice (transcribed, may be imperfect) to a voice companion that relays a coding agent\'s work. The companion can answer from what the agent already said, or pass the words on to the agent.';
const QUESTIONS = {
  needs_agent: {
    type: 'noul',
    instructions: 'Must `utterance` reach the coding agent itself, rather than only be answered?',
    criteria: {
      true: "It asks for or implies work, a change, a fix, research, a correction of the agent, a decision or instruction the agent should follow (including 'don't do X' or 'stop'), something to be written or saved, or it is the operator's turn in an exercise, drill or walkthrough the agent is running. When in doubt, true.",
      false: "It only asks for information the agent's conversation already holds: status, a recap, an explanation, an opinion, or a check of understanding, and asks nothing to be done.",
    },
  },
};
/** Jev's probability at or above which unpassed speech goes to the agent, and how long the operator must have been quiet. */
export const CATCH_THRESHOLD = .6, CATCH_AFTER_MS = 8000;

export class WorkCatcher {
  apiKey: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  constructor({ apiKey, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.log = log; this.fetch = fetch;
  }
  /** Jev's probability that the operator's words must reach the agent. */
  async needsAgent(utterance: string): Promise<number> {
    const state = { setting: SETTING, utterance: utterance.replace(/\s+/g, ' ').trim().slice(0, 600) };
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const p = Number(answers?.needs_agent?.noul);
    this.log({ type: 'work.judged', needsAgent: p });
    return Number.isFinite(p) ? p : 0;
  }
}
