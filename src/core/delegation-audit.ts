// Jev's check of each request to the harness, optional: on when TYPESAFE_API_KEY is set.
//
// Before a request GPT Live passed on reaches the harness, Jev also reads it for session orchestration:
// turning the voice of the operator's running companions on or off. A request that asks only that is
// carried out by fdc and never reaches the harness; anything else, or any doubt, still does.
//
// Whether the request needed the harness at all is only recorded: deciding that is GPT Live's job.
// For each request that reaches the harness, the record says whether GPT Live passed it on or it
// arrived only because voice ended (GPT Live had kept it), next to Jev's judgment, for learning how
// often GPT Live and Jev disagree, and in which direction.
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
/** A running companion, as Jev is told about it. */
export interface Session { id: string; folder: string; agent: string; on: boolean; current: boolean }
/** Jev's reading of a request for session orchestration. */
export interface SessionsJudgment { asked: number; only: number; unlisted: number; turnOn: string[]; turnOff: string[] }
export interface Judgment { needsAgent: number | null; sessions?: SessionsJudgment }

// Probabilities above which Jev's reading is acted on. A request is kept from the harness only when
// it surely asks for nothing but session changes: a work request kept from it is the costly error.
// On 8 sample requests (Oct 13): a plain "switch to video editing" scored only .73, the ones that also asked for work .02.
export const ASKED = .7, ONLY = .7, UNLISTED = .7;

const SESSIONS_SETTING = ' The operator may run several companions at once, each beside its own coding session in its own folder (`sessions`); each one\'s voice can be on or off, and several can be on together. fdc, the voice tool itself, turns them on or off; the coding agent does not.';
const sessionQuestions = (sessions: Session[]) => ({
  sessions_asked: {
    type: 'noul',
    instructions: 'Does the operator, in `utterance`, ask to turn the voice of one or more companion sessions on or off: start one, stop one, switch to another, switch away from this one, or talk to several at once?',
    criteria: {
      true: 'Asks for a session\'s voice to be turned on or off, to switch to or between sessions, to bring another session in, or for this session to stop listening. The session may be named by its folder, project or agent.',
      false: 'Anything else: work on a project, even one named like a session; questions about how sessions work; designing the voice tool; switching something inside the code, such as a branch, a file or a setting.',
    },
  },
  only_sessions: {
    type: 'noul',
    instructions: 'Is turning companion sessions on or off the only thing `utterance` asks for, with nothing for the coding agent to do or answer?',
    criteria: {
      true: 'Only session on/off or switching requests, with at most filler or thanks.',
      false: 'It also asks for work, a question, an instruction, a correction or any message for the coding agent, or it is not about sessions at all. When in doubt, false.',
    },
  },
  unlisted_session: {
    type: 'noul',
    instructions: 'Does the operator ask to turn on, or switch to, a session that matches none of `sessions`?',
    criteria: { true: 'Names a session, project or folder to start or switch to that is not listed.', false: 'Every session asked for is listed, or no session is asked for.' },
  },
  ...Object.fromEntries(sessions.map((session, index) => [`session_${index + 1}`, {
    type: 'choice',
    instructions: `What does the operator ask for session_${index + 1} (${session.folder}${session.current ? ', the session they are speaking to now' : ''})? Its voice is ${session.on ? 'on' : 'off'}.`,
    // The session spoken to is told apart from the others: "turn off video-editing", said to two at once, turned both off.
    criteria: session.current
      ? { turn_off: 'The operator asks the session they are speaking to (here, you, this one, or all of them) to stop listening, or to switch away from it to another session.', leave: 'The operator does not ask this session itself to stop. Asking to turn off a different session, named by its folder or project, leaves this one on.' }
      : session.on
      ? { turn_off: `The operator names or clearly means ${session.folder} (or all of them) and asks for its voice to stop.`, leave: `The operator does not ask ${session.folder}'s voice to stop.` }
      : { turn_on: `The operator names or clearly means ${session.folder} and asks to start its voice, switch to it, or bring it into the conversation.`, leave: `The operator does not ask to start ${session.folder}'s voice.` },
  }])),
});
const sessionLines = (sessions: Session[]) => sessions.map((s, index) => `session_${index + 1}: ${s.folder} (${s.agent}), voice ${s.on ? 'on' : 'off'}${s.current ? ' (the one the operator is speaking to now)' : ''}`).join('\n');

export class DelegationAudit {
  apiKey: string; file: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  constructor({ apiKey, file, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; file: string; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.file = file; this.log = log; this.fetch = fetch;
  }
  /** Jev's probability that the operator's words must reach the agent, and with running sessions, its reading of them for session changes. */
  async judge(utterance: string, sessions?: Session[], timeoutMs = 5000): Promise<Judgment> {
    const state: Record<string, string> = { setting: SETTING + (sessions ? SESSIONS_SETTING : ''), utterance: utterance.replace(/\s+/g, ' ').trim().slice(-600) };
    if (sessions) state.sessions = sessionLines(sessions) || '(none)';
    const questions = sessions ? { ...QUESTIONS, ...sessionQuestions(sessions) } : QUESTIONS;
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const p = (name: string) => { const value = Number(answers?.[name]?.noul); return Number.isFinite(value) ? value : 0; };
    const judgment: Judgment = { needsAgent: p('needs_agent') };
    if (sessions) {
      const chosen = (choice: string) => sessions.filter((_, index) => answers?.[`session_${index + 1}`]?.choice === choice).map(s => s.id);
      judgment.sessions = { asked: p('sessions_asked'), only: p('only_sessions'), unlisted: p('unlisted_session'), turnOn: chosen('turn_on'), turnOff: chosen('turn_off') };
    }
    return judgment;
  }
  async needsAgent(utterance: string): Promise<number> { return (await this.judge(utterance)).needsAgent ?? 0; }
  /** Judge what the operator said and record it with what GPT Live did. Never throws. */
  async record(entry: { handOff: HandOff; said: string; voiceSessionId?: string | null; delegationId?: string | null; requestId?: string }, judged?: number | null): Promise<number | null> {
    // Judged already when Jev checked the request before it went out.
    let needsAgent: number | null = judged ?? null;
    if (judged === undefined) try { needsAgent = await this.needsAgent(entry.said); } catch (error) { this.log({ type: 'audit.error', message: (error as Error).message }); }
    this.log({ type: 'delegation.audit', handOff: entry.handOff, needsAgent, delegationId: entry.delegationId ?? null });
    // Owner-only, local: the operator's words with both judgments, for learning.
    try { fs.appendFileSync(this.file, JSON.stringify({ at: Date.now(), ...entry, needsAgent }) + '\n', { mode: 0o600 }); } catch {}
    return needsAgent;
  }
}
