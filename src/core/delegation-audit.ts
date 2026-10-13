// Auditing GPT Live's hand-off decisions, optional: on when TYPESAFE_API_KEY is set. Deciding what
// reaches the harness is GPT Live's job; this only records, for each request that reaches the
// harness, whether GPT Live passed it on or it arrived only because voice ended (GPT Live had kept
// it), next to Jev's judgment of whether it needed the harness. Nothing is sent because of it. The
// record is for learning: how often GPT Live and Jev disagree, and in which direction.
import fs from 'node:fs';

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
export type HandOff = 'passed' | 'answered';

export class DelegationAudit {
  apiKey: string; file: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  constructor({ apiKey, file, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; file: string; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.file = file; this.log = log; this.fetch = fetch;
  }
  /** Jev's probability that the operator's words must reach the agent. */
  async needsAgent(utterance: string): Promise<number> {
    const state = { setting: SETTING, utterance: utterance.replace(/\s+/g, ' ').trim().slice(-600) };
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const p = Number(answers?.needs_agent?.noul);
    return Number.isFinite(p) ? p : 0;
  }
  /** Judge what the operator said and record it with what GPT Live did. Never throws. */
  async record(entry: { handOff: HandOff; said: string; voiceSessionId?: string | null; delegationId?: string | null; requestId?: string }): Promise<number | null> {
    let needsAgent: number | null = null;
    try { needsAgent = await this.needsAgent(entry.said); } catch (error) { this.log({ type: 'audit.error', message: (error as Error).message }); }
    this.log({ type: 'delegation.audit', handOff: entry.handOff, needsAgent, delegationId: entry.delegationId ?? null });
    // Owner-only, local: the operator's words with both judgments, for learning.
    try { fs.appendFileSync(this.file, JSON.stringify({ at: Date.now(), ...entry, needsAgent }) + '\n', { mode: 0o600 }); } catch {}
    return needsAgent;
  }
}
