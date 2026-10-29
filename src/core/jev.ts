// Jev (TypeSafe System One, a calibrated judge) reads the conversation whenever the voice tool has to act on it, and
// answers everything the voice tool asks about that moment in one call, over one state. Optional: on when
// TYPESAFE_API_KEY is set.
// - The operator's turn (turn.ts): whether their words need the coding agent (then they go to it: GPT Live passes nothing
//   on), whether they turn voice sessions on or off (sessions.ts), are only about how the companion behaves, or end the
//   conversation for now (Standby).
// - The page on the stage: the next command to run, and whether moving the page is all they ask (presenter.ts).
// - The learner: whether they give the companion a standing instruction (instruction-learner.ts).
// - The tuner: the level of each setting that fits the operator's instructions (jev-tuner.ts, with FDC_JEV_TUNING=1).
// Jev gets the latest words, what happened before them as fdc keeps it (the agent's events and the conversation, in order,
// as far back as the recent history keeps: recent-history.ts), and why it is asked now; it judges from these, with no rule
// about which words each question may use.
import type { StageCommand, StageView } from './stage.ts';
import type { Tuning } from './tuning.ts';
import { tunerQuestions, TUNER_SETTING } from './jev-tuner.ts';
import { spokenLine } from './prompts.ts';

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
const URL = 'https://api.typesafe.ai/v1/systemone';

/** Why Jev is asked now: its provenance, part of what it reads. */
export type Trigger = 'turn' | 'delegation' | 'unsent' | 'cue' | 'step' | 'settings';
const WHY: Record<Trigger, string> = {
  turn: 'The operator has just stopped speaking.',
  delegation: 'The voice companion has asked for the operator\'s latest words to be passed on.',
  unsent: 'The operator\'s latest words are going to the coding agent although the voice companion never passed them on (voice ended, or the voice tool sends them itself).',
  cue: 'The voice companion has just said it is turning to something on the page, by words that are no part\'s name.',
  step: 'The voice tool has run page commands for the latest words (`page_done`), and the page is now where `page` says.',
  settings: 'The operator\'s instructions to the companion have changed, or voice has started.',
};
const SETTING = 'An operator talks by voice (transcribed, may be imperfect) to a voice companion that presents a coding agent\'s work while the agent produces it. The companion answers what it can from what the agent already said; it passes nothing on itself. You are the voice tool between the companion and the agent: what the voice tool can do itself (the page beside the conversation, the companion\'s own behavior and settings, voice sessions, pausing the companion when the conversation is over for now) it does at once, without the agent; everything else must reach the agent, and does from your reading. `latest` holds the latest words: judge those. `history` is what happened just before them, oldest first, as context (what "it", "that one" or "yes, please" refers to): the coding agent\'s events, as JSON records, and the conversation, where `user` is the operator and `voice assistant` the voice companion. `why` says why you are asked now.';
const SESSIONS_SETTING = ' The operator may run several companions at once, each beside its own coding session (`sessions`); each one\'s voice can be on or off, and several can be on together. Each session is listed as the operator sees it in the page\'s list of running companions: its folder, its coding agent, the start of its session ID and its state, then what hovering it shows. The operator may name a session by any of these, and a session ID by its first characters, which speech may spell out ("six two zero" or "620" for an ID that starts with 620). fdc, the voice tool itself, turns them on or off; the coding agent does not. Every listed session is already running, so starting, opening or turning on a listed session means turning its voice on, and stopping or closing one means turning its voice off.';
const PAGE_SETTING = ' A page is open in the browser beside the conversation (`page`). The voice tool can move it, show and highlight its parts with the listed page commands, without the coding agent. Commands whose id starts with page_ are the page\'s own (slides, tabs, views): prefer them when they fit.';

// Probabilities above which Jev's reading is acted on. A request is kept from the harness only when
// it surely asks for nothing but session changes: a work request kept from it is the costly error.
// On 8 sample requests (Oct 13): a plain "switch to video editing" scored only .73, the ones that also asked for work .02.
export const ASKED = .7, ONLY = .7, UNLISTED = .7;
// A request only about how the companion behaves: on 226 real requests from the audit (Oct 18), 4 scored
// .7 or more, two of them questions for the harness about the companion's own code (lost work); none .85.
// Six plain preferences ("stop waking up for every little thing", "don't pause so quickly") scored .85-.93.
export const COMPANION_ONLY = .85;
// A page command is run when Jev's choice of it is at least this likely. On 135 synthetic navigation requests over
// 7 pages (Oct 19): at .5, 96 first steps right, 8 wrong; at .45, 99 right, still 8 wrong; at .4, 101 right, 13 wrong.
// Asked one command at a time over the conversation (Oct 21), at .45: 105 first commands right (the old count and three
// steps: 96), 15 none (29). A request is kept from the harness as page-only from PAGE_ONLY, and only while PAGE_WORK
// says no work is asked: on the same set, every work request scored work .51 or more (the 15 with a move too, .74 or
// more), and at .35, 80 of the 135 moves were page-only, as many as before. Misjudged page-only words still reach the
// agent, with the next request.
export const PAGE_STEP = .45, PAGE_ONLY = .4, PAGE_WORK = .35, PAGE_OTHER = .5;
// A complaint about the page that no command answers goes to the agent to improve the page's controller.
export const PAGE_UNHAPPY = .6;
// A walkthrough asked for: fdc paces it (presenter.ts), unless the request also asks for work. On the operator's lines of
// Oct 20 (fdc-lab), asking for one part or topic in depth ("make walk me through it visually as well", "run me through
// these experiments") still scored .73-.83, real walkthroughs ("walk me through the rest", "present the whole deck",
// "walk me through it") .85-.97: at .6, eleven of fifteen walkthroughs that day were unwanted.
export const PAGE_WALK = .84, WALK_WORK = .6;
// After a command ran, the next runs only when Jev finds more asked.
export const PAGE_MORE = .5;
// A step forward or back is taken only when moving the page is what the words are about: "Please continue running those
// experiments" chose the next section with page-only at .05; "let's continue" scores .34 and more.
export const PAGE_RELATIVE_ONLY = .3;
// The learner's held-out thresholds from the offline test.
export const BEHAVE = .6, DESIGN = .5;
// The operator's words go to the coding agent from this likelihood that they need it: keeping work from it is the costly
// mistake, a question it gets as well costs little. On 984 labeled requests (fdc-ref-c41d07), .4 lost 5 (GPT Live 31,
// .5 eleven) and left the operator 120 to chase (GPT Live 209), for 173 stretches of talk sent that needed nothing (139).
// Asking whether the words were finished, and holding them until they were, sent fewer requests in two parts but more
// of them late.
export const NEEDS_AGENT = .4;
// The operator is done for now: the companion goes on Standby as soon as it has answered.
export const STANDBY = .7;

/** One utterance of the conversation. */
export interface Line { role: 'operator' | 'intermediary'; text: string }
/** A running companion, as Jev is told about it. */
export interface Session { id: string; folder: string; sessionId: string | null; on: boolean; current: boolean; /** The session as the page's list of running companions shows it to the operator (web/companions.ts). */ shown: string }
/** A session by its folder and session ID: two sessions can share a folder. */
export const sessionName = (s: Pick<Session, 'folder' | 'sessionId'>) => s.sessionId ? `${s.folder} (${s.sessionId})` : s.folder;
/** Jev's reading of the words for session orchestration. */
export interface SessionsJudgment { asked: number; only: number; unlisted: number; turnOn: string[]; turnOff: string[] }
/** Jev's reading of the words for the page on the stage. */
export interface PageJudgment {
  /** The command to run next, if Jev is sure enough of one. */
  command?: string;
  /** That moving the page is all the operator asks; that work is asked of the agent besides (unanswered counts as asked). */
  only: number; work: number;
  /** That something is asked of the page that no command does; that the operator asks to be walked through the page; that they are unhappy with what the page did or can't do. */
  other: number; walk: number; unhappy: number;
}
/** Whether the latest words give the companion a standing instruction, and for how long. */
export interface InstructionJudgment { behave: number; design: number; lasting: string }
/** Everything Jev read in one moment. */
export interface Reading {
  trigger: Trigger;
  /** The latest words it judged, and what it read them in (their history, then the words, marked). */
  said: string; transcript: string;
  /** Whether those words must reach the coding agent; null when Jev couldn't be asked. */
  needsAgent: number | null;
  sessions?: SessionsJudgment; companionOnly?: number;
  page?: PageJudgment; instruction?: InstructionJudgment;
  /** The level of each setting Jev chose (jev-tuner.ts). */
  tuning?: Record<string, unknown>;
  /** That the latest words end the conversation for now (the companion then goes on Standby). */
  standby?: number;
  /** Acted on already (learner and tuner): a reading reused for the same words isn't acted on twice. */
  considered?: boolean;
}
/** What Jev is asked about: the moment, the words, what happened before them, and what the voice tool can act on now. */
export interface Moment {
  trigger: Trigger;
  /** The latest words; what happened before them, oldest first (recent-history.ts). */
  latest?: Line; history?: string;
  sessions?: Session[]; page?: StageView;
  /** Page commands already run for these words (trigger step). */
  done?: StageCommand[];
  /** Ask whether the words give a standing instruction (the learner). */
  learn?: boolean;
  /** Ask which settings fit (the tuner): the instructions in force, those from earlier sessions, the current settings and those set by hand. */
  tune?: { instructions: string[]; earlier: string[]; current: Tuning; pinned: (keyof Tuning)[] };
}


const noul = (instructions: string, yes: string, no: string) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// Read at every turn's end (turn.ts), not only for words GPT Live chose to pass on: "When in doubt, true" sent noise and
// narration as requests (101 of 112 stretches that needed nothing, on 15 labeled sessions, Oct 28). With these criteria
// it lost fewer requests than GPT Live and left the operator fewer to chase (fdc-ref-c41d07); without the exercise
// clause, answers in a drill the agent ran stayed unsent.
const GATE = {
  needs_agent: noul('Do the latest words, read with the conversation before them, ask something of the coding agent?',
    "A request for the agent or for the companion to pass on: work, a change, a fix, something to run, research, something to write or save; a correction of the agent's work or a decision it should follow (including 'don't do X' or 'stop'); a question about the work that the conversation doesn't already answer; 'send that', 'go ahead', 'yes, do it' to something asked before; or the operator's turn in an exercise, drill or walkthrough the agent is running (an answer, 'next question', 'task two', 'I\'ll go next').",
    "Talking rather than asking the agent: narrating or presenting, thinking aloud, reacting ('okay', 'interesting', 'got it'), chatting, greeting; a question the companion can answer from the conversation (status, a recap, an explanation); moving through the page; anything only about how the voice companion behaves; noise or fragments that ask nothing."),
  // Done talking for now: fdc pauses the companion (Standby) without waiting out the quiet window.
  standby: noul('Do the latest words end the conversation for now: the operator says goodbye, that they are stepping away or done for now, or asks the voice companion to go quiet, sleep or wait until they call it?',
    'They close the conversation for now or step away: "that\'s all for now", "thanks, bye", "I\'ll be back in a bit", "go to sleep", "stand by until I call you", also with a last request for the coding agent.',
    'Anything else: a question, a request, an acknowledgment while the conversation goes on ("okay", "thanks", "got it"), or "stop" or "wait" asking the companion to stop talking or hold on.'),
  // Preferences and frustration about the companion itself: fdc adjusts its own settings from them (Jev's tuning).
  companion_only: noul('Are the latest words only about how the voice companion itself should behave in this conversation (how much or when it talks, how fast it goes quiet or pauses, what wakes it, what it reports), with nothing for the coding agent to do, change or answer?',
    'Only a preference, complaint or frustration about the voice companion\'s own behavior right now, such as "stop waking up for every little thing", "don\'t pause so quickly" or "talk less", with at most filler or thanks.',
    'Anything for the coding agent: work, a question, a correction, an instruction for its work, a change to code, including building, changing or discussing the voice tool\'s code or design; or anything else. When in doubt, false.'),
};
const sessionQuestions = (sessions: Session[]) => ({
  sessions_asked: noul('In the latest words, does the operator ask to turn the voice of one or more companion sessions on or off: start one, stop one, switch to another, switch away from this one, or talk to several at once?',
    'Asks to start, open, turn on, stop or turn off a listed session, to switch to or between sessions, to bring another session in, or for this session to stop listening, end or shut itself off, with or without the word voice. The session may be named by its folder, project, agent or session ID.',
    'Anything else: work on a project, even one named like a session; questions about how sessions work; designing the voice tool; switching something inside the code, such as a branch, a file or a setting; "stop" or "wait" on its own, which asks the companion to stop talking or stop what it is doing, not to turn voice off.'),
  only_sessions: noul('Is turning companion sessions on or off the only thing the latest words ask for, with nothing for the coding agent to do or answer?',
    'Only session on/off or switching requests, with at most filler or thanks.',
    'They also ask for work, a question, an instruction, a correction or any message for the coding agent, or they are not about sessions at all. When in doubt, false.'),
  unlisted_session: noul('In the latest words, does the operator ask to turn on, or switch to, a session that matches none of `sessions`?',
    'Names a session, project, folder or session ID to start or switch to that is not listed.', 'Every session asked for is listed, or no session is asked for.'),
  ...Object.fromEntries(sessions.map((session, index) => [`session_${index + 1}`, {
    type: 'choice',
    instructions: `What do the latest words ask for session_${index + 1} (${sessionName(session)}${session.current ? ', the session they are speaking to now' : ''})? Its voice is ${session.on ? 'on' : 'off'}.`,
    // The session spoken to is told apart from the others: "turn off video-editing", said to two at once, turned both off.
    criteria: session.current
      ? { turn_off: 'The operator asks the session they are speaking to (here, you, this one, it by its folder or session ID, or all of them) to stop listening, end or shut itself off, or to switch away from it to another session.', leave: 'The operator does not ask this session itself to stop listening: "stop" on its own asks it to stop talking or stop what it is doing. Asking to turn off a different session, named by its folder, project or session ID, leaves this one on.' }
      : session.on
      ? { turn_off: `The operator names or clearly means ${sessionName(session)} (or all of them) and asks for its voice to stop.`, leave: `The operator does not ask the voice of ${sessionName(session)} to stop.` }
      : { turn_on: `The operator names or clearly means ${sessionName(session)} and asks to start its voice, switch to it, or bring it into the conversation.`, leave: `The operator does not ask to start the voice of ${sessionName(session)}.` },
  }])),
});
const sessionLines = (sessions: Session[]) => sessions.map((s, index) => `session_${index + 1}${s.current ? ' (the one the operator is speaking to now)' : ''}: ${s.shown}`).join('\n') || '(none)';

/** The choice for "another action on the page": something asked of it that no command does, for fdc's one-off action (fast-action.ts). */
export const OTHER = 'other_action';
// Which command, one at a time: the page moves, Jev sees where it is now (and what ran), and is asked again, until none
// is wanted. One question with the command list, instead of a count and three copies of the list that each had to agree.
const COMMAND = (trigger: Trigger) => ({
  first: trigger === 'step'
    ? 'Which page command should run next to show what the latest words ask for, now that the commands in `page_done` have run and the page is where `page` says? Choose none when the page already shows it.'
    : trigger === 'cue'
    ? 'Which page command shows what the voice companion meant in the latest words? Choose none if no command shows it.'
    : 'Which page command should run first to show what the latest words ask for (when they ask for several, the first in their order)? Choose none if they ask for no page command.',
  rules: 'Asking to make, add, change or fix something is work for the coding agent, never a page command; asking to explain, present or run through something that is on the page also asks to show it, and so does a part named on its own ("sessions", "issue nine") or described by what it says or by how the page labels it ("highlighting step two", "tonight, the first one"), even with how, why or where. A number said as a word names the numbered part ("move on to four" is section 4, not the next one). With a page open, "continue", "go on", "keep going" or "move on" on their own (with at most "okay" or "let\'s") ask for the page\'s next part, whatever the companion just said. A move repeated ("forward three sections") is one command at a time. When the operator says not to move or change what is on screen, there is no page command.',
});
const pageQuestions = (page: StageView, trigger: Trigger) => {
  const { first, rules } = COMMAND(trigger);
  const criteria = { none: 'No page command: nothing (more) is to be shown, moved or highlighted on the page.', ...Object.fromEntries(page.commands.map(c => [c.id, c.say])), [OTHER]: 'Another action on the page that none of these commands does: find, point at or highlight a specific thing inside a part (a row, a word, a number), click or open a control, switch a view, zoom. Not going to a section, slide or part that a listed command goes to, even when the operator describes it by what it says.' };
  const command = { page_command: { type: 'choice', instructions: `${first} ${rules}`, criteria } };
  // After each command: should another run? A plain yes or no, beside which one.
  // "Okay, continue" ran the next slide five times (Oct 21, live deck): a move with no number asks for one.
  if (trigger === 'step') return { ...command, page_more: noul('Do the latest words ask more of the page than the commands already run for them (`page_done`, in order) have done?', 'Something they named is not done yet: a further part, highlight or switch, or a move they asked for a number of times ("forward two slides", "next, next") that has run fewer times.', 'The commands run have done everything the latest words name. A move asked for without a number ("next", "continue", "go on", "keep going", "go back") is one move, done once it has run.') };
  if (trigger === 'cue') return command;
  return {
    ...command,
    page_only: noul('Is moving, showing or highlighting things on the page all the latest words ask, with nothing for the coding agent to do, change, research or answer?',
      'Only page commands, with at most filler or thanks; or to be walked through or shown what the page already says, which the companion presents itself.',
      'Also asks for work, a change, research, an answer or anything else beyond the page. When in doubt, false.'),
    page_walk: noul('Do the latest words ask to be walked through the page, part after part: a presentation of several parts in turn, not one part, a single move, a question or a change?',
      'A walkthrough or presentation of the page or of several of its parts in turn: "walk me through it", "run me through tonight\'s slides", "present it to me", "go through the rest".',
      'One part, topic or idea, even to be walked, run or talked through it or taken through it in depth ("walk me through the ordered levels", "run me through five", "talk me through the graphs", "teach me RLCD in depth"): that is explaining it, not moving through the page. Also anything said not to move or change what is on screen, a single move, a question, work for the coding agent, or anything else.'),
    page_unhappy: noul('Is the operator unhappy with what the page just did or can\'t do: it didn\'t move, went to the wrong place or page, highlighted the wrong thing, or can\'t show what they mean?',
      'A complaint or correction about the page\'s moves or what it shows ("the page isn\'t moving", "that\'s not where I asked", "you didn\'t highlight it", "no, the other page").',
      'Anything else: a plain request to go somewhere or show something, a question, work for the coding agent, or a complaint about how the voice companion talks.'),
    // The same question from the other side: independent answers, so a request is page-only only when both agree.
    page_work: noul('Besides moving, showing or highlighting things on the page, do the latest words ask the coding agent to make, add, change, fix, explain or look into anything?',
      'Some work, change, research or answer is asked of the coding agent, even alongside a page command: changing how the page looks (bigger, bolder, colours, wording) is work.',
      'Only page commands, or naming, describing, finding or pointing at a part of the page to go to, with at most filler or thanks; or to be walked through or shown what the page already says, which the companion presents itself.'),
  };
};
const pageLine = (page: StageView) => `${page.title} (${page.url})${page.about ? `: ${page.about}` : ''}. The viewer is at: ${page.where}`.slice(0, 900);
/** The part a command goes to, by its name without a number before it ("stage 3: DNS lookup" is "dns lookup"). */
const partOf = (command: StageCommand) => (command.name ?? '').toLowerCase().replace(/^(stage|slide|step|part|section)\s*\d+\s*[:.\-–]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** What a command does, for counting commands that do the same as one: its part, or going back (fdc's own, the page's back or previous), or the page's next. */
const sameAs = (command: StageCommand) => {
  const page = command.id.startsWith('page_');
  if (command.id === 'back' || (page && /(^|_)(previous|prev|back)(_|$)/.test(command.id))) return 'back';
  if (page && /(^|_)(next|forward)(_|$)/.test(command.id)) return 'next';
  return partOf(command) ? `part ${partOf(command)}` : command.id;
};
/**
 * The command Jev chose, if it is sure enough. Commands that do the same thing split its confidence between them, even
 * below "none": one part's (its heading, the page's own command, an annotation on it: "connecting to the server" .43, .38
 * and .11), or going back (fdc's own and the page's: "go back… I don't see it" .26 and .11, with none at .40). They count
 * as one choice, and the page's own command runs.
 */
export function chosenCommand(answer: any, page: StageView): string | undefined {
  if (!answer) return;
  const likely: Record<string, number> = answer.probabilities ?? { [answer.choice]: Number(answer.confidence ?? 1) };
  const groups = new Map<string, StageCommand[]>();
  for (const command of page.commands) if (likely[command.id] !== undefined) groups.set(sameAs(command), [...groups.get(sameAs(command)) ?? [], command]);
  const sum = (group: StageCommand[]) => group.reduce((total, c) => total + Number(likely[c.id] ?? 0), 0);
  const best = [...groups.values()].sort((a, b) => sum(b) - sum(a))[0];
  if (!best || sum(best) < PAGE_STEP || sum(best) < Number(likely.none ?? 0)) return;
  const ranked = best.sort((a, b) => Number(likely[b.id] ?? 0) - Number(likely[a.id] ?? 0));
  return (ranked.find(c => c.id.startsWith('page_')) ?? ranked[0]).id;
}

const LEARNER = {
  behave: { type: 'noul', instructions: 'In the latest words, is the operator telling the voice companion how to behave toward them from now on (not designing the tool, not asking the coding agent to do something, not a one-off cue)?',
    criteria: { true: "A standing request about the companion's own conduct toward the operator for the rest of the conversation or longer: when to speak or stay quiet, how much detail, pace, what to read out, what to relay or delegate.", false: 'Designing or discussing the voice tool or GPT Live; a task for the coding agent; a one-off cue or request (go on, next, repeat, stop this sentence); a question about the work.' } },
  design_talk: noul('The operator is often building this voice tool itself. Is the operator discussing how a voice tool or GPT Live should be designed or built, as a topic for the coding work, rather than telling this voice companion how to behave?',
    "Talks about the voice tool's design, settings or code, or describes GPT Live's behaviour as a problem to solve.", 'Speaks to the companion itself about how it should behave now or from now on.'),
  lasting: { type: 'choice', instructions: 'How long does the operator want the voice companion to follow what their latest words tell it?',
    criteria: { this_moment: 'Only right now, e.g. stop the current sentence or skip this one.', this_session: 'For the rest of this conversation, task or phase.', always: 'In every session: a standing preference.' } },
};

export class Jev {
  apiKey: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  constructor({ apiKey, log, fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; log: (event: Record<string, unknown>) => void; fetch?: Fetch }) {
    this.apiKey = apiKey; this.log = log; this.fetch = fetch;
  }
  /** One call: everything the voice tool asks about this moment. */
  async read(moment: Moment, timeoutMs = 3000): Promise<Reading> {
    const { trigger, latest, history = '', sessions, page, done, learn, tune } = moment, started = Date.now();
    const said = latest?.text.replace(/\s+/g, ' ').trim() ?? '', gate = trigger === 'turn' || trigger === 'delegation';
    // The latest words in their own field: marked inside the conversation instead, Jev read plain page moves as likelier
    // work for the agent (page_work up by .1 on average, Oct 21).
    const state: Record<string, string> = { setting: SETTING + (sessions ? SESSIONS_SETTING : '') + (page ? PAGE_SETTING : '') + (tune ? ` ${TUNER_SETTING}` : ''), why: WHY[trigger], history: history.trim() || '(none)', latest: latest ? spokenLine(latest) : '(none)' };
    if (sessions) state.sessions = sessionLines(sessions);
    if (page) state.page = pageLine(page);
    if (done?.length) state.page_done = done.map((c, i) => `${i + 1}. ${c.say}`).join('\n');
    if (tune) Object.assign(state, { operator_instructions: tune.instructions.join('\n').slice(0, 4000) || '(none)', earlier_sessions: tune.earlier.join('\n').slice(0, 4000) || '(none)', current_settings: JSON.stringify(tune.current) });
    const questions = {
      ...(gate || trigger === 'unsent') && { needs_agent: GATE.needs_agent },
      ...gate && { companion_only: GATE.companion_only, standby: GATE.standby, ...sessions && sessionQuestions(sessions) },
      ...page && pageQuestions(page, trigger),
      ...learn && LEARNER,
      ...tune && tunerQuestions(tune.current, tune.pinned, trigger !== 'settings'),
    };
    const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    const { answers } = await response.json();
    const p = (name: string, missing = 0) => { const value = Number(answers?.[name]?.noul); return Number.isFinite(value) ? value : missing; };
    const reading: Reading = { trigger, said, transcript: `${history}${latest ? `► ${spokenLine(latest)}` : ''}`, needsAgent: 'needs_agent' in questions ? p('needs_agent') : null };
    if (gate) { reading.companionOnly = p('companion_only'); reading.standby = p('standby'); }
    if (gate && sessions) {
      const chosen = (choice: string) => sessions.filter((_, index) => answers?.[`session_${index + 1}`]?.choice === choice).map(s => s.id);
      reading.sessions = { asked: p('sessions_asked'), only: p('only_sessions'), unlisted: p('unlisted_session'), turnOn: chosen('turn_on'), turnOff: chosen('turn_off') };
    }
    if (page) {
      const answer = answers?.page_command, other = answer?.choice === OTHER ? Number(answer.probabilities?.[OTHER] ?? answer.confidence ?? 1) : 0;
      // Work unanswered counts as asked, so the words still reach the agent: keeping them from it is the costly mistake.
      // After a command, another runs only when Jev says more is asked.
      const more = trigger !== 'step' || p('page_more') >= PAGE_MORE;
      reading.page = { command: other >= PAGE_OTHER || !more ? undefined : chosenCommand(answer, page), only: p('page_only'), work: p('page_work', 1), other, walk: p('page_walk'), unhappy: p('page_unhappy') };
      // The likeliest commands, for tuning the page question.
      const top = Object.entries(answer?.probabilities ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3).map(([id, v]) => `${id} ${Number(v).toFixed(2)}`).join(', ');
      this.log({ type: 'page.judged', trigger, said: said.slice(-200), command: top, ...trigger === 'step' ? { more: p('page_more') } : trigger === 'cue' ? {} : { only: reading.page.only, work: answers?.page_work?.noul ?? null, walk: reading.page.walk, unhappy: reading.page.unhappy }, other });
    }
    if (learn) reading.instruction = { behave: p('behave', NaN), design: p('design_talk', NaN), lasting: answers?.lasting?.choice };
    if (tune) reading.tuning = answers;
    this.log({ type: 'jev.read', trigger, said: said.slice(-200), questions: Object.keys(questions).length, chars: JSON.stringify(state).length, ms: Date.now() - started, needsAgent: reading.needsAgent, companionOnly: reading.companionOnly, standby: reading.standby, sessions: reading.sessions, instruction: reading.instruction });
    return reading;
  }
}
