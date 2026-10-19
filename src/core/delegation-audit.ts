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
import type { StageView } from './stage.ts';

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
export interface Session { id: string; folder: string; agent: string; on: boolean; current: boolean; /** Why its voice can't start without the operator. */ blocked?: string | null }
/** Jev's reading of a request for session orchestration. */
export interface SessionsJudgment { asked: number; only: number; unlisted: number; turnOn: string[]; turnOff: string[] }
/** Jev's reading of a request for the page on the stage: the commands to run, in order. */
export interface PageJudgment { steps: string[]; only: number; count: number; /** Jev's probability that work is asked of the agent besides the page commands. */ work?: number; /** That something is asked of the page that no command does. */ other?: number }
export interface Judgment { needsAgent: number | null; sessions?: SessionsJudgment; /** Only about how the voice companion behaves, nothing for the agent. */ companionOnly?: number; page?: PageJudgment }

// Probabilities above which Jev's reading is acted on. A request is kept from the harness only when
// it surely asks for nothing but session changes: a work request kept from it is the costly error.
// On 8 sample requests (Oct 13): a plain "switch to video editing" scored only .73, the ones that also asked for work .02.
export const ASKED = .7, ONLY = .7, UNLISTED = .7;
// A request only about how the companion behaves: on 226 real requests from the audit (Oct 18), 4 scored
// .7 or more, two of them questions for the harness about the companion's own code (lost work); none .85.
// Six plain preferences ("stop waking up for every little thing", "don't pause so quickly") scored .85-.93.
export const COMPANION_ONLY = .85;
// A page command is run when Jev's choice of it is at least this likely. On 135 synthetic navigation requests over
// 7 pages (Oct 19): at .5, 96 first steps right, 8 wrong; at .45, 99 right, still 8 wrong; at .4, 101 right, 13 wrong. A request is kept from the
// harness as page-only from PAGE_ONLY, and only while PAGE_WORK says no work is asked: on trial requests
// (Oct 19), page-only ones scored only .55-.96 and work .04-.21, ones with work in them only .02-.67 and
// work .38-.82. Misjudged page-only words still reach the agent, with the next request.
export const PAGE_STEP = .45, PAGE_ONLY = .4, PAGE_WORK = .3, PAGE_OTHER = .5;
// Words before the utterance that no request carried yet still reach the agent later; they are context here.
// What the companion said just before: "yes, please" answers its offer ("want me to show the diagrams?").
const COMPANION_SETTING = ' `companion_before` is what the voice companion said just before `utterance`; use it only to understand short replies such as "yes, please".';
const EARLIER_SETTING = ' `earlier` is what the operator said before `utterance` that has not reached the coding agent yet (the companion answered it, or `utterance` finishes it); it will reach the agent later. Use it only as context and judge `utterance`.';
const PAGE_SETTING = ' A page is open in the browser beside the conversation (`page`). The voice tool can move it, show and highlight its parts with the listed page commands, without the coding agent. Commands whose id starts with page_ are the page\'s own (slides, tabs, views): prefer them when they fit.';
// Each step names a whole command, so Jev's independent answers never have to agree on its arguments.
const pageQuestions = (page: StageView) => {
  // "Or perform another action": something asked of the page that no command does, for fdc's one-off action (fast-action.ts).
  const criteria = { none: 'No page command: nothing is to be shown, moved or highlighted on the page.', ...Object.fromEntries(page.commands.map(c => [c.id, c.say])), [OTHER]: 'Another action on the page that none of these commands does: find, point at or highlight a specific thing inside a part (a row, a word, a number), click or open a control, switch a view, zoom. Not going to a section, slide or part that a listed command goes to, even when the operator describes it by what it says.' };
  const step = (n: number) => ({ type: 'choice', instructions: `List the page commands the operator asks for, in order, writing a command once for each time it should run ("forward three sections" is the next-section command three times). Asking to make, add, change or fix something is work for the coding agent, never a page command; asking to explain, present or run through something that is on the page also asks to show it, and so does a part named on its own ("sessions", "issue nine") or described by what it says, even with how, why or where. Which command is number ${n} in that list? Choose none if the list is shorter.`, criteria });
  return {
    page_steps: { type: 'choice', instructions: 'How many page commands should run, counting each repetition ("forward three sections" is 3, "go to the options and highlight the recommendation" is 2)? Work for the coding agent (making, adding, changing or fixing anything), questions and talk are not page commands.', criteria: { '0': 'No page command.', '1': 'One.', '2': 'Two.', '3': 'Three.', '4': 'Four.', '5': 'Five or more.' } },
    page_step_1: step(1), page_step_2: step(2), page_step_3: step(3),
    page_only: { type: 'noul', instructions: 'Is moving, showing or highlighting things on the page all the operator asks, with nothing for the coding agent to do, change, research or answer?', criteria: { true: 'Only page commands, with at most filler or thanks.', false: 'Also asks for work, a change, research, an answer or anything else beyond the page. When in doubt, false.' } },
    // The same question from the other side: independent answers, so a request is page-only only when both agree.
    page_work: { type: 'noul', instructions: 'Besides moving, showing or highlighting things on the page, does the operator ask the coding agent to make, add, change, fix, explain or look into anything?', criteria: { true: 'Some work, change, research or answer is asked of the coding agent in `utterance`, even alongside a page command: changing how the page looks (bigger, bolder, colours, wording) is work.', false: 'Only page commands, or naming, describing, finding or pointing at a part of the page to go to, with at most filler or thanks. Judge `utterance` alone, not `earlier`.' } },
  };
};
/** The step choice for "another action on the page". */
export const OTHER = 'other_action';
const pageLine = (page: StageView) => `${page.title} (${page.url})${page.about ? `: ${page.about}` : ''}. The viewer is at: ${page.where}`.slice(0, 900);

const SESSIONS_SETTING = ' The operator may run several companions at once, each beside its own coding session in its own folder (`sessions`); each one\'s voice can be on or off, and several can be on together. fdc, the voice tool itself, turns them on or off; the coding agent does not. Every listed session is already running, so starting, opening or turning on a listed session (named by its folder or project) means turning its voice on, and stopping or closing one means turning its voice off.';
const sessionQuestions = (sessions: Session[]) => ({
  // Preferences and frustration about the companion itself: fdc adjusts its own settings from them (Jev's tuning).
  companion_only: {
    type: 'noul',
    instructions: 'Is `utterance` only about how the voice companion itself should behave in this conversation (how much or when it talks, how fast it goes quiet or pauses, what wakes it, what it reports), with nothing for the coding agent to do, change or answer?',
    criteria: {
      true: 'Only a preference, complaint or frustration about the voice companion\'s own behavior right now, such as "stop waking up for every little thing", "don\'t pause so quickly" or "talk less", with at most filler or thanks.',
      false: 'Anything for the coding agent: work, a question, a correction, an instruction for its work, a change to code, including building, changing or discussing the voice tool\'s code or design; or anything else. When in doubt, false.',
    },
  },
  sessions_asked: {
    type: 'noul',
    instructions: 'Does the operator, in `utterance`, ask to turn the voice of one or more companion sessions on or off: start one, stop one, switch to another, switch away from this one, or talk to several at once?',
    criteria: {
      true: 'Asks to start, open, turn on, stop or turn off a listed session, to switch to or between sessions, to bring another session in, or for this session to stop listening, with or without the word voice. The session may be named by its folder, project or agent.',
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
  async judge(utterance: string, sessions?: Session[], timeoutMs = 5000, page?: StageView, earlier?: string, companion?: string): Promise<Judgment> {
    const state: Record<string, string> = { setting: SETTING + (sessions ? SESSIONS_SETTING : '') + (page ? PAGE_SETTING : '') + (earlier ? EARLIER_SETTING : '') + (companion ? COMPANION_SETTING : ''), utterance: utterance.replace(/\s+/g, ' ').trim().slice(-600) };
    if (earlier) state.earlier = earlier.replace(/\s+/g, ' ').trim().slice(-400);
    if (companion) state.companion_before = companion.replace(/\s+/g, ' ').trim().slice(-300);
    if (sessions) state.sessions = sessionLines(sessions) || '(none)';
    if (page) state.page = pageLine(page);
    const questions = { ...QUESTIONS, ...sessions ? sessionQuestions(sessions) : {}, ...page ? pageQuestions(page) : {} };
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const p = (name: string, missing = 0) => { const value = Number(answers?.[name]?.noul); return Number.isFinite(value) ? value : missing; };
    const judgment: Judgment = { needsAgent: p('needs_agent') };
    if (sessions) {
      const chosen = (choice: string) => sessions.filter((_, index) => answers?.[`session_${index + 1}`]?.choice === choice).map(s => s.id);
      judgment.sessions = { asked: p('sessions_asked'), only: p('only_sessions'), unlisted: p('unlisted_session'), turnOn: chosen('turn_on'), turnOff: chosen('turn_off') };
      judgment.companionOnly = p('companion_only');
    }
    if (page) {
      const step = (name: string) => {
        const answer = answers?.[name], id = answer?.choice;
        const likely = Number(answer?.probabilities?.[id] ?? answer?.confidence ?? 1);
        return typeof id === 'string' && likely >= PAGE_STEP && page.commands.some(c => c.id === id) ? id : undefined;
      };
      // Another action at any step: the whole request goes to a one-off action, which can do the rest too.
      const other = Math.max(0, ...['page_step_1', 'page_step_2', 'page_step_3'].map(name => answers?.[name]?.choice === OTHER ? Number(answers[name].probabilities?.[OTHER] ?? answers[name].confidence ?? 1) : 0));
      const count = Number(answers?.page_steps?.choice) || 0, steps = [step('page_step_1'), step('page_step_2'), step('page_step_3')];
      // A step 1 without a count still runs; the count otherwise says where the list ends.
      // Jev's "no page command" with work asked: nothing runs ("make the options section bigger" isn't a move).
      const none = answers?.page_steps?.choice === '0' && p('page_work') >= PAGE_WORK;
      let chosen = none ? [] : steps.slice(0, count ? Math.min(count, 3) : steps[0] ? 1 : 0).filter((id): id is string => !!id);
      // One command repeated ("down three paragraphs"): the count says how often, past the three steps asked.
      if (steps[0] && steps[1] === steps[0] && count > chosen.length && chosen.every(id => id === steps[0])) chosen = Array(count).fill(steps[0]);
      // Work unanswered counts as asked, so the words still reach the agent: keeping them from it is the costly mistake.
      judgment.page = { steps: other >= PAGE_OTHER ? [] : chosen, only: p('page_only'), work: p('page_work', 1), other, count };
      // Each step's likeliest commands, for tuning the page questions.
      const top = (name: string) => Object.entries(answers?.[name]?.probabilities ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3).map(([id, v]) => `${id} ${Number(v).toFixed(2)}`).join(', ');
      this.log({ type: 'page.judged', utterance: state.utterance, count: answers?.page_steps?.choice, step_1: top('page_step_1'), step_2: top('page_step_2'), step_3: top('page_step_3'), only: p('page_only'), work: answers?.page_work?.noul ?? null, other });
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
