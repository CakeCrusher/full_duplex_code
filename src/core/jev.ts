// Jev (TypeSafe System One, a calibrated judge) reads the conversation whenever the voice tool has to act on it.
// Optional: on when TYPESAFE_API_KEY is set.
// - The operator's turn (trigger turn, turn.ts): one request that asks everything the voice tool decides about their
//   words, over one state: whether they need the coding agent and whether they have finished saying them (the job
//   delegation; GPT Live passes nothing on); which command of the page on the stage does what they ask for; their goal
//   (what they want shown, taught or walked through); what their instructions keep from the agent; and, with those
//   features on (features.ts), a standing instruction to learn (instruction-learner.ts), the settings that fit
//   (jev-tuner.ts) and voice sessions to turn on or off (sessions.ts). The same request is made as their turn ends
//   (GPT Live asks to pass their words on, starts answering, or they have been quiet a moment) and again once the
//   voice companion's reply is in (mediator.ts): the operator's rule of Nov 17, "one request… both identical, with the
//   same information… the questions being asked are the same". Until then the two moments asked different questions
//   (the voice tool's own actions, then the job delegation), over states that differed.
// - The page, apart (the operator: "quite distinct because it's only focused on the controller commands"): as the
//   voice companion talks, which command shows what it is talking about (trigger cue); and once a command has run,
//   whether another must follow (trigger step; a part's own control is listed once that part is on screen): the page
//   moves one command at a time until none is needed (presenter.ts).
// - The quiet after the companion has spoken (trigger quiet): Standby. The settings alone, when the operator's
//   instructions change or voice starts (trigger settings). Words that reached the agent without a reading (unsent).
// Jev gets the latest words, what the voice companion had perceived before them, word for word as it got it
// (perceived.ts), the operator's instructions to the companion in force, and why it is asked now; it judges from these,
// with no rule about which words each question may use. Who does what is the same account the companion is given
// (roles.ts). Every call is recorded with what fdc did with it (jev-audit.ts).
import { randomUUID } from 'node:crypto';
import type { AgentProfile } from './adapter.ts';
import type { HandOff } from './delegation-audit.ts';
import type { JevCall } from './jev-audit.ts';
import { focusLine, type StageCommand, type StageView } from './stage.ts';
import { DEFAULT_TUNING, type Tuning } from './tuning.ts';
import { DEFAULT_FEATURES, type Feature, type Features } from './features.ts';
import { tunerQuestions, TUNER_SETTING } from './jev-tuner.ts';
import { spokenLine } from './prompts.ts';
import { roles } from './roles.ts';

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
const URL = 'https://api.typesafe.ai/v1/systemone', MODEL = 'jev-latest';

/** Why Jev is asked now: its provenance, part of what it reads. */
export type Trigger = 'turn' | 'unsent' | 'cue' | 'step' | 'quiet' | 'settings';
const WHY: Record<Trigger, string> = {
  // The job delegation's own line, when it had a request to itself (until Nov 17): its answers are the ones that send.
  turn: 'The operator has just stopped speaking and the voice companion has replied to them (`voice_reply`, what it has said so far).',
  unsent: 'The operator\'s latest words are going to the coding agent although the voice companion never passed them on (voice ended, or the voice tool sends them itself).',
  cue: 'The voice companion has just said the latest words, with a page open beside the operator.',
  step: 'Page commands just ran for the voice companion\'s latest words (`page_done`, in order), and the page is now where `page` says.',
  quiet: 'The conversation has gone quiet: the voice companion finished speaking a moment ago and the operator has said nothing since.',
  settings: 'The operator\'s instructions to the companion have changed, or voice has started.',
};
// The same step when the commands ran for what the operator asked for (their words are the latest).
const STEP_ASKED = 'Page commands just ran for what the operator asks for in the latest words (`page_done`, in order), and the page is now where `page` says.';
// The same quiet when the companion gave the operator's last words no answer.
const QUIET_UNANSWERED = 'The conversation has gone quiet: the operator stopped speaking several seconds ago and the voice companion has not answered.';
/** What Jev is told of its place, by the agent and the features on: who does what (shared with the companion), then its own part and how to read its state. */
const setting = (agent: { profile: Pick<AgentProfile, 'name'> }, features: Features) => `An operator talks by voice (transcribed, may be imperfect) to a voice companion that presents the work of a coding agent, ${agent.profile.name}, while it works. ${roles(agent, features)} You judge for the voice tool: what it does itself follows your reading, and everything else must reach ${agent.profile.name} unless the companion handled it; keeping work from ${agent.profile.name} is the costly mistake. \`latest\` holds the latest words: judge those. \`history\` is what the voice companion had heard and been told before them, oldest first, word for word as it got it: \`user:\` lines are the operator's speech and \`voice assistant:\` lines the companion's own, transcribed; a block that opens with a line in square brackets is something fdc sent the companion, and that line says how, and how long before the latest words. It is context: what "it", "that one" or "yes, please" refers to, and what the companion knows already. \`operator_instructions\` are the operator's instructions to the companion in force now; they hold for your reading too, such as what should or shouldn't reach ${agent.profile.name}. \`why\` says why you are asked now.`;
const SESSIONS_SETTING = ' The operator may run several companions at once, each beside its own coding session (`sessions`); each one\'s voice can be on or off, and several can be on together. Each session is listed as the operator sees it in the page\'s list of running companions: its folder, its coding agent, the start of its session ID and its state, then what hovering it shows. The operator may name a session by any of these, and a session ID by its first characters, which speech may spell out ("six two zero" or "620" for an ID that starts with 620). fdc, the voice tool itself, turns them on or off; the coding agent does not. Every listed session is already running, so starting, opening or turning on a listed session means turning its voice on, and stopping or closing one means turning its voice off.';
const PAGE_SETTING = ' A page is open in the browser beside the conversation (`page`). The voice tool runs the listed page commands itself, without the coding agent: they move the page, show and highlight its parts, and work its controls (choose, set, add, remove, place). Commands whose id starts with page_ are the page\'s own: prefer them when they fit.';

// Probabilities above which Jev's reading is acted on: sessions turned on or off when asked, and none when the one asked
// for isn't running.
export const ASKED = .7, UNLISTED = .7;
// Words about how the companion behaves: it is told to follow them (the learner and the tuner act on the reading). On 226
// real requests from the audit (Oct 18), 4 scored .7 or more, two of them questions for the harness about the companion's
// own code; none .85. Six plain preferences ("stop waking up for every little thing", "don't pause so quickly") scored .85-.93.
export const COMPANION_ONLY = .85;
// The operator's instructions in force keep words like these from the agent ("don't delegate", "take the order
// yourself"). From this likelihood, such words the job delegation keeps are settled: they never go by themselves, at
// the voice's end either (other kept words go then), and GPT Live, if it asked to pass them on, hears why nothing went
// (turn.ts). Not a bar to sending, which is the job delegation's alone: in a run where "keep Claude out of it
// for now" stayed in force for two days (Nov 9 to 11) the operator went on asking for work, and Jev sent 56 of its 138
// requests there at .4 to .6. Of the 29 turns under such an instruction in the two sessions of Nov 17, the 25 orders,
// questions and remarks scored .80 to .97, and the four that asked for the agent by name .03 to .35. In 13 other runs
// with instructions in force (289 turns) three passed it: a request to be walked through a section, "you don't need to
// delegate this", and a gulp.
export const WITHHELD = .7;
// What the operator asks of the page is done there when Jev finds, this likely, that they ask for something to be done
// or shown now (and is sure enough of the command, PAGE_REQUEST). On 400 of their turns with a page open, in 15 runs of
// Oct 31 to Nov 16, a command was likely enough for 42 at PAGE_STEP: 30 pass this ("take me to the second slide",
// "let's move on to nineteen", "show me the evidence", "Okay, next"); the 12 that don't are remarks about what is on
// the page, questions, and "walk me through it", where "next step" would have skipped the step the voice was on. Every
// order of the Nov 17 sessions scored .82 or more.
export const PAGE_ASKED = .5;
// A page command is run when Jev's choice of it is at least this likely. On 135 synthetic navigation requests over 7 pages
// (Oct 19): at .5, 96 first steps right, 8 wrong; at .45, 99 right, still 8 wrong; at .4, 101 right, 13 wrong.
export const PAGE_STEP = .45;
// After a command ran, the next is asked for only when Jev finds another needed (page_more).
export const PAGE_MORE = .5;
// A command for the operator's request runs from this likelihood, if it is likelier than none: that they ask something
// of the page now is read apart (PAGE_ASKED), and a request for several things, or for something two commands show,
// splits Jev's choice between them. "Add it to my order, I want it small and very hot" chose the size at .42, adding at
// .12 and none at .33; "Let's keep going" the next section at .41 and the section that came next at .21 (Nov 17):
// nothing ran. On 400 earlier turns with a page open this runs three more than PAGE_STEP would: "I would like to see
// the matrix" and "No, stay on content and placement", where the voice's own words then moved the page to the same
// place, and one "Yeah, let's do it". At .3 it would also have added a drink for the tail of a question about it.
export const PAGE_REQUEST = .35;
// The voice saying it can't answer or find what the operator asked: their words that stayed with it are then read again
// for the agent, with all it has said since (mediator.ts, reconsider).
export const GAVE_UP = .7;
// The operator's words set a new goal, or end it, from this likelihood.
export const GOAL = .6;
// The learner's held-out thresholds from the offline test.
export const BEHAVE = .6, DESIGN = .5;
// Words that ask for an instruction Jev learned to go are passed to the harness's one-off run, which decides what changes
// in the list (instruction-distiller.ts), when Jev is this sure of which one. On 14 made-up removal requests over real
// moments it chose the right one 13 times, at .79 or more; on 117 real turns it chose one once, at .70, where the operator
// was replacing it. In the recordings of Oct 31 to Nov 12 nobody asked by voice: the eight removals since Oct 11 were
// clicks on the page.
export const REMOVE = .7;
// The operator's words go to the coding agent from this likelihood that they need it, read once the voice companion has
// replied, and once they have finished saying them (READY). The companion answers from what it was told and general
// knowledge and says when it doesn't know (prompts.ts), so its reply shows what it can't handle. On the 56 validation
// sessions of the labeled set (fdc-ref-c41d07; replies simulated for that companion, decided 3 s after the turn): 106
// of 176 moments right against 90 for GPT Live delegating itself and 94 for the question alone (.5, ready .2): 50 of 79
// stretches of talk kept from the agent (GPT Live 29), 4 requests lost (5), 20 late (11). That was at .4, when the
// question was asked with one other. In the turn's one request (Nov 17), beside the page's, the learner's and the
// tuner's questions, Jev's answer to it runs lower: by .03 on average on 200 recorded turns of Nov 6 to 17 put to it
// both ways (95 at or over .4 before, 76 after; the tuner's questions account for half of the drop). From .35 as many
// are over the line as before (95), and what is sent, kept or left waiting differs for 8 of the 200, five toward the
// agent and three away; at .4 it differed for 15, eleven of them away. Asked the same way twice, it differs for 3 of 300.
export const NEEDS_AGENT = .35, READY = .2;
// Right after a request has reached the agent (within RECENT_MS), the operator's next words go to it only if they add to
// it (ADDS): its tail, a repeat, an acknowledgment or noise stays with the voice. Jev used to send them as a second
// request seconds later (prompts.ts, sentWords). When that request is held for the end of the agent's turn, words that
// press for it (PRESS, on the now-or-later reading: "no, send it now") go even though they add nothing: they bring it in.
export const ADDS = .4, RECENT_MS = 10000, PRESS = .5;
// While the agent is in the middle of a turn, a request is steered into it unless Jev finds it can wait (below NOW): then
// fdc holds it until the turn ends (outbox.ts). Steering is the default: a correction made to wait costs the operator more
// than an interruption that could have waited.
export const NOW = .3;
// Forks (the questions and what they were measured on are below, forking): words that belong in a fork open one from the
// setting forkFrom (tuning.ts); with a fork open, words stay with it from STAYS (from forkFrom, set lower: what opens
// a fork stays in one), and the focus moves back to the main session from SETTLED.
export const STAYS = .5, SETTLED = .5;
// What Jev reads of what the voice companion perceived: its latest 14 KB (perceived.ts).
export const HISTORY_BYTES = 14000;
/** For the record (jev-audit.ts): the likelihood at which each question's answer changes what fdc does. */
const THRESHOLDS: Record<string, number> = { needs_agent: NEEDS_AGENT, ready: READY, adds: ADDS, now: NOW, remove: REMOVE, gave_up: GAVE_UP, standby: DEFAULT_TUNING.standbyFrom, tangent: DEFAULT_TUNING.forkFrom, settled: SETTLED, companion_only: COMPANION_ONLY, withheld: WITHHELD, sessions_asked: ASKED, unlisted_session: UNLISTED, page_command: PAGE_STEP, page_more: PAGE_MORE, page_asked: PAGE_ASKED, goal: GOAL, behave: BEHAVE, design_talk: DESIGN };

/** One utterance of the conversation. */
export interface Line { role: 'operator' | 'intermediary'; text: string }
/** A running companion, as Jev is told about it. */
export interface Session { id: string; folder: string; sessionId: string | null; on: boolean; current: boolean; /** The session as the page's list of running companions shows it to the operator (web/companions.ts). */ shown: string }
/** A session by its folder and session ID: two sessions can share a folder. */
export const sessionName = (s: Pick<Session, 'folder' | 'sessionId'>) => s.sessionId ? `${s.folder} (${s.sessionId})` : s.folder;
/** Jev's reading of the words for session orchestration. */
export interface SessionsJudgment { asked: number; unlisted: number; turnOn: string[]; turnOff: string[] }
/** Jev's reading for the page on the stage: of the voice companion's words (what they show), or of the operator's (what they ask for). */
export interface PageJudgment {
  /** The command that shows what the voice meant, or does what the operator asked, if Jev is sure enough of one. */
  command?: string;
  /** How likely another command is needed after it (page_more); and how likely each command was, to choose again when the first has nothing to do. */
  more?: number; likely?: Record<string, number>;
  /** How likely the operator's words ask for something to be done or shown on the page now (their turn's reading). */
  asked?: number;
  /** How likely the voice is saying that it can't answer or find what the operator asked (trigger cue). */
  gaveUp?: number;
}
/** Whether the operator's latest words set a new goal (what they want shown, taught or walked through), end it, or neither. */
export interface GoalJudgment { choice: 'keep' | 'new' | 'walk' | 'done'; p: number }
/** Whether the latest words give the companion a standing instruction, and for how long. */
export interface InstructionJudgment { behave: number; design: number; lasting: string }
/** Everything Jev read in one moment. */
export interface Reading {
  trigger: Trigger;
  /** The call it came from (jev-audit.ts). */
  id?: string;
  /** The latest words it judged, and what it read them in (their history, then the words, marked). */
  said: string; transcript: string;
  /** Whether those words must reach the coding agent, and whether the operator has finished saying them (trigger turn); null when Jev couldn't be asked. */
  needsAgent: number | null; ready?: number;
  /** Whether they add to the request the agent got moments before (asked only then). */
  adds?: number;
  /** Whether they must reach the agent in the middle of the turn it is running (asked only while it is working). */
  now?: number;
  sessions?: SessionsJudgment; companionOnly?: number;
  /** That the operator's instructions in force keep these words from the agent (asked only while some are in force). */
  withheld?: number;
  page?: PageJudgment; instruction?: InstructionJudgment; goal?: GoalJudgment;
  /** The learned instruction the words ask to remove, and how likely (asked only while some are in force). */
  remove?: { id: string; p: number };
  /** The level of each setting Jev chose (jev-tuner.ts). */
  tuning?: Record<string, unknown>;
  /** That no meaningful exchange is about to begin, now that the conversation has gone quiet (trigger quiet): from the setting standbyFrom the companion goes on Standby at once. */
  standby?: number;
  /** The latest words are a question asked aside (a fork's), and, with a fork in focus, whether the operator has left its matter (forks.ts). */
  tangent?: number; settled?: number;
  /** Acted on already (learner and tuner): a reading reused for the same words isn't acted on twice. */
  considered?: boolean;
}
/** What Jev is asked about: the moment, the words, what happened before them, and what the voice tool can act on now. */
export interface Moment {
  trigger: Trigger;
  /** The latest words; what the voice companion perceived before them, oldest first (perceived.ts). */
  latest?: Line; history?: string;
  /**
   * All the operator has said that no request has decided yet, ending with the latest words, when some of it was said
   * before them: they had not finished at an earlier turn, and those words wait (mediator.ts). The questions about what
   * goes to the agent then read all of it, while `latest` stays the new words, from which the voice tool's own actions
   * are read (a page command never runs twice for the same words, an instruction is learned once).
   */
  saying?: string;
  /** The operator's instructions to the companion in force. */
  instructions?: readonly string[];
  sessions?: Session[]; page?: StageView;
  /** The page commands already run for the latest words (trigger step; and trigger turn, when the voice tool did what the operator asked), each with what the page answered. */
  done?: (StageCommand & { shown?: string })[];
  /** The operator's goal in force, as Jev reads it: what they asked to be shown or taught, when, and what was shown since. */
  goal?: string;
  /** What the voice companion has said in reply to the latest words so far (trigger turn). */
  reply?: string;
  /** The agent is in the middle of a turn, for this long (trigger turn): Jev is asked whether the words must reach it now or can wait for the turn's end. */
  working?: number;
  /** The request that went to the agent moments before this reading, within RECENT_MS (trigger turn): how long ago, the operator's words in it, and whether it is held until the agent's turn ends. The latest words may only be its tail. */
  sent?: { ago: number; said: string; held?: boolean };
  /** The conversation has gone quiet (trigger quiet) and the voice companion gave the operator's last words no answer. */
  unanswered?: boolean;
  /** Forks (forks.ts): the session in focus when a fork decision can be made: the main one while it works (a question asked aside can go to a fork), or the fork (the operator can move back). */
  fork?: 'main' | 'fork';
  /** Ask whether the words give a standing instruction (the learner). */
  learn?: boolean;
  /** The instructions Jev learned that are in force (their IDs and text): ask whether the words ask for one of them to be removed. */
  removable?: { id: string; text: string }[];
  /** Ask which settings fit (the tuner): the instructions from earlier sessions, the current settings and those set by hand. */
  tune?: { earlier: string[]; current: Tuning; pinned: (keyof Tuning)[] };
  /** For the record only (jev-audit.ts), not sent: the request the words go to the agent by, and how words already sent went (trigger unsent). */
  requestId?: string; handOff?: HandOff;
  /** For the record only: which of the turn's two requests this is, the one made as the turn ended or the one made once the companion's reply was in (mediator.ts). */
  made?: 'ended' | 'replied';
  /** For the record only: the thresholds that are settings (tuning.ts), as in force. */
  thresholds?: Record<string, number>;
}


const noul = (instructions: string, yes: string, no: string) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// The job delegation: whether the operator's words go to the coding agent. Acted on once the voice companion has replied
// (turn.ts): its reply is evidence, not the verdict; work goes whatever it said, and a request the page can't do (no
// command does it) goes to the agent to extend the page's controller. Its first form, read at every turn's end with
// "When in doubt, true", sent noise and narration as requests (101 of 112 stretches that needed nothing, on 15 labeled
// sessions, Oct 28); without the exercise clause, answers in a drill the agent ran stayed unsent.
// With words still waiting from an earlier turn (`saying`), these questions read all of them: read as fragments, "…send
// it" then "over" was read as "over" and kept. On recorded turns with words waiting (Nov 1 to 17), against the request
// that had all of them as its latest words: with the questions reading `saying`, needs_agent crossed its line on 6 of
// 100 turns and what was sent, kept or left waiting differed on 3 (asked the same way twice: 6 and 3 of 150); with the
// waiting words only in the history it crossed on 24 of 150, and in a field the questions did not name on 19.
const sending = (whole: boolean) => {
  const words = whole ? 'what the operator is saying (`saying`: all they have said that is not decided yet, ending with the latest words)' : 'the latest words';
  return {
    needs_agent: noul(`${whole ? 'Does' : 'Do'} ${words} need the coding agent, now that the voice companion has replied (\`voice_reply\`)?`,
      "A request for work on the project: to make, change, fix, run, save, write or look into something; telling the agent something, or asking for words to be sent to it; a correction or decision about the agent's work, or input on it the agent should hear; asking the page for something none of its commands does (`page_commands`), or being unhappy with what the page did, which the agent fixes; a question the companion said it doesn't know, or that only the agent can answer from its work; agreeing to or answering what the agent proposed or asked; the operator's turn in an exercise or walkthrough the agent runs ('next question', 'task two'). The companion saying it doesn't know, can't do it, or that it is the agent's to do is strong evidence.",
      "Words the companion handled itself: it answered them from what it was told or from general knowledge, or it asked the operator to clarify (their answer comes next); talk that asks nothing (narrating or presenting to an audience, thinking aloud, reacting, chatting); a side question to the companion while giving an instruction (to repeat or explain something); anything only about how the companion behaves or what it should pass on; turning voice sessions on or off; anything the page's commands do (`page_commands`: moving through it, showing a part, working its controls), which the voice tool does on the page itself (`page_done`, when it has just done so for these words); fragments."),
    ready: noul(`Have the operator finished saying what they want for now${whole ? ' (`saying`: all they have said that is not decided yet, ending with the latest words)' : ''}, so that a good listener would act on it at this moment, or are they still in the middle of saying it?`,
      "They have said a whole request or question, enough to act on, and stopped: even if it trails off into filler ('um', 'yeah', 'so', 'and yeah') or they might add more later. A short cue or command is whole as soon as it is said ('show them', 'take it from here', 'carry on', 'send it').",
      "They broke off in the middle of a sentence or a list ('and the…', 'I want you to…', 'can you also'), or are still building up to what they want (setting context before the actual ask), so acting now would miss its point."),
    // Asked only while the agent is in the middle of a turn: steered into it now, or held until it ends (issue 24).
    now: noul(`The coding agent is in the middle of a turn: its latest work is at the end of \`history\`. Must ${whole ? 'what the operator is saying (`saying`)' : 'the latest words'} reach it now, in the middle of that turn, rather than when the turn ends?`,
      'They correct, stop, redirect or change the work under way; answer something the agent asked or is waiting on; give information without which the current work would come out wrong or be wasted; or the operator says it is urgent or wants it right away.',
      "They can wait for the turn to end: a new, separate task; an addition that doesn't change what the agent is doing now; a question or remark about results the agent will produce anyway; anything where interrupting would only disturb work that should finish first."),
    // Asked only when a request reached the agent moments before these words.
    adds: noul(`The operator's words went to the coding agent moments ago, or are held for it until its turn ends: the latest such line in \`history\` says which. ${whole ? 'Does what the operator is saying (`saying`) give' : 'Do the latest words give'} the agent anything it needs beyond that request?`,
      "They hold something that request didn't: an instruction, detail, constraint, correction, decision or question the agent needs; an addition to it, a change to it, or another request.",
      'Nothing the agent needs beyond it: the tail end of the same sentence, filler, an acknowledgment or thanks, a repeat or rewording of what was sent, words meant only for the voice companion (to go on, repeat, wait or stop talking), or stray fragments and noise.'),
  };
};
// Standby on Jev's word (trigger quiet; voice-sessions.ts): once the conversation has gone quiet after the voice
// companion has had its say, is a meaningful exchange about to begin? If Jev is sure enough that none is (the setting
// standbyFrom, tuning.ts), voice goes on Standby at once instead of waiting out the quiet window. The operator's rule
// (Nov 14, after labeling ten recorded moments by hand): judge it once the companion has spoken, by how engaged they
// seem, whether they have just handed the agent a long task, and whether they asked something that gets an immediate
// answer; and what counts afterward is a meaningful exchange (a steer, or news they listened to and accepted), not the
// companion talking. Measured on the recorded quiets of Oct 31 to Nov 14 (.scratch/round2/standby; 400 of them judged
// blind on that definition from the three minutes that followed, half held out): this question tells the quiets that
// last from those that don't at AUC .66 (.64 held out, on the operator's 20 s horizon of Nov 16). Ten wordings were
// tried, among them the event itself, a present fact ("is anything still open between them?") and the two ways an
// exchange begins asked apart: .51 to .67, and a stronger model forecasting blind did no better, so the wording stays
// as measured (its "15 seconds" included: the thresholds were set on its scores). What each threshold buys with the
// quiet window is in tuning.ts. Every recorded request for Standby in words passed .5 (7 of 7). The question it
// replaces was asked as the operator stopped speaking, before the companion answered, and only caught such requests.
const QUIET = {
  standby: noul("The conversation has gone quiet. The voice companion costs money while it stays connected and could disconnect now; it is back a few seconds after the operator next speaks or the coding agent finishes. Will the next 15 seconds pass without a meaningful exchange: the operator giving direction or asking something, or the companion telling them something they want (an answer, news of the agent's work, the next part of an explanation they asked for)? Filler, the companion saying it is checking or waiting, and noise do not count. Judge it as the operator does, by three things: how engaged they seem (a live back-and-forth, or drifting off); whether they have just handed the agent a long task and now wait for it; and whether they asked something that gets an immediate answer (if nothing was passed to the agent, the companion will answer itself and the exchange goes on).",
    'No meaningful exchange is about to begin: the operator handed off work and waits, has drifted off or stepped away, or the companion has finished and nothing it owes is ready yet. Certainly so when the operator said goodbye, that they are stepping away or done for now, or asked the companion to go quiet, sleep, stand by or wait until they call it.',
    'One is about to begin or still going: the operator is in a live back-and-forth, the companion owes an answer it can give now or is partway through what they asked for, or the operator was just asked something.'),
};
// Forks (forks.ts): words the operator turns aside with go to a fork of the agent's session, and they move back to the
// main session after it. The operator's rule (Nov 14, from their own labels of 12 recorded requests): a fork is for a
// clarifying question, an answer or explanation for themselves; anything to be done or executed is main work, also on
// another topic or "in the background"; what should not have gone to the agent at all is neither. On Nov 18 they added
// two things: a fork they ask for by name is one, whatever goes there ("I want you to basically branch off as we
// continue running through this presentation", "I want you to fork": Jev "should have absolutely forked"), and whether
// the agent is working is not part of it ("it should only be conditioned on what jev thinks"). A fork is left behind
// on the way back, so work sent to one unasked is the costly mistake; a question sent to the main session goes as it
// did without forks.
// - `tangent`: do the operator's words belong in a fork? With the main session in focus, it decides as the words are
//   sent: from the setting forkFrom they go to a fork. Measured on 671 recorded requests (Nov 2 to 18; 317 made while
//   the agent worked, 354 while it was idle), each in the turn's request as it is made once the voice has replied,
//   labeled on the operator's rule by blind judges (.scratch/forks-nov18): 123 forks, 414 requests for work, 134 that
//   should not have gone to the agent. It separates forks from main work at AUC .93 (.96 while the agent works, .92
//   while it is idle; the wording before it, which began "The coding agent is in the middle of its work" and knew no
//   fork asked for by name: .92, and it read the three recorded requests for a fork at .04, .13 and .09, where this
//   one reads .94, .72 and .84). At the default .5 it finds 102 of the 123 forks and forks 40 of the 414 requests for
//   work, most of them questions about the work or pushing back on it. Asked in every turn's request, it leaves the
//   other answers where they were: on 200 recorded turns that were not sent, needs_agent moved by .001 on average and
//   3 came out differently (asked the same way twice, 3 of 300 do).
// - `settled`: with a fork in focus, has the operator left its matter? Read with `tangent`, as their turn ends. No recorded session has a fork, so it was measured on 133 turns that followed requests a fork would have
//   opened for, with the fork's tag put in their history (.scratch/round2/forks/back): words that are no question
//   (below STAYS) move the focus back when the operator has left the matter (from SETTLED) or when they are on their way
//   to the agent, which moves back for 33 of 45 turns that should and leaves the fork in 7 of 39 that go on with it
//   (the same with the wording of `tangent` before Nov 18). The
//   wording before it ("do the latest words settle the tangent?") was near chance there (AUC .59 against .83; both
//   answers together .88).
const forking = (whole: boolean) => ({
  tangent: noul(`${whole ? 'Does what the operator is saying (\`saying\`) belong' : 'Do the latest words belong'} in a fork of the coding agent's session (a copy of it, opened beside the main session): ${whole ? 'does it' : 'do they'} turn aside to ask something the operator wants answered or explained for themselves now, with nothing asked to be done, or ask for a fork?`,
    "A clarifying question or a request to explain: what something means, why something is so, what a number or a state currently is, how two things differ, to be walked through something. Answering may take looking something up, but nothing is to be built, changed, fixed, run, added or tried, and the agent's work is not steered. Or the operator asks for a fork themselves: to fork, to branch off, to open a fork or a side session for something. Then whatever is to go there belongs in it, work included.",
    "A request for work, on any topic: to make, change, fix, run, add, try, explore, compare, measure or find something, even 'in the background' or 'as a subagent' when no fork is asked for; a correction, redirection, stop, decision, preference or added requirement for the agent's work; an answer to what the agent asked; the next step of a process the agent runs; feedback on what the agent built or is building, including a question that is really a criticism of it or that needs new work to answer. Also words that are not for the agent: talk with or about the voice companion, a question the companion can answer from what it was told, thinking aloud, fragments."),
  settled: noul('A fork of the coding agent\'s session is open for a question the operator turned aside to ask (`<fork started>` in `history`), while the main session goes on with its work. Do the latest words leave it: the operator is done with that question, turns to the main work, or asks for something to be done?',
    "They accept or close the answer ('okay, got it', 'thanks, that answers it') and move on; they turn to the main work or ask how it is going; or they ask for something to be made, changed, fixed, run or tried, or steer the work: work belongs to the main session, also when it follows from the answer.",
    'They stay with it: a follow-up question, another thing they want explained, asking for the answer again or in more detail, or talk with the voice companion about it.'),
});
// What the voice tool does itself with the operator's words (turn.ts).
const GATE = {
  // Preferences and frustration about the companion itself: fdc adjusts its own settings from them (Jev's tuning).
  companion_only: noul('Are the latest words about how the voice companion itself should behave in this conversation: how much or when it talks, how fast it goes quiet or pauses, what wakes it, what it reports or passes on?',
    'A preference, complaint or frustration about the voice companion\'s own behavior, such as "stop waking up for every little thing", "don\'t pause so quickly" or "talk less".',
    'Anything else: what the operator asks, says or decides about the work, the page or the sessions; designing or discussing the voice tool\'s code. When in doubt, false.'),
};
// Asked while the operator's instructions are in force: words they keep from the agent, once the job delegation keeps
// them, are settled (turn.ts); what they ask now comes before a standing instruction ("tell Codex that…" goes).
const INSTRUCTED = {
  withheld: noul('Do the operator\'s instructions in force (`operator_instructions`) keep the latest words from the coding agent?',
    'An instruction in force tells the companion not to pass on, send or delegate things like this, or to handle them itself, and the latest words do not ask for the coding agent or for something to be told or sent to it.',
    'No instruction in force is about what reaches the coding agent, or none covers these words; or the operator now asks for the coding agent, or for something to be told or sent to it: what they ask now comes before a standing instruction.'),
};
const sessionQuestions = (sessions: Session[]) => ({
  sessions_asked: noul('In the latest words, does the operator ask to turn the voice of one or more companion sessions on or off: start one, stop one, switch to another, switch away from this one, or talk to several at once?',
    'Asks to start, open, turn on, stop or turn off a listed session, to switch to or between sessions, to bring another session in, or for this session to stop listening, end or shut itself off, with or without the word voice. The session may be named by its folder, project, agent or session ID.',
    'Anything else: work on a project, even one named like a session; questions about how sessions work; designing the voice tool; switching something inside the code, such as a branch, a file or a setting; "stop" or "wait" on its own, which asks the companion to stop talking or stop what it is doing, not to turn voice off.'),
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

// The page's commands, read at two moments. One command at a time: once it has run, the page is read again (a part's own
// controls are offered only while that part is on screen, stage-page.js) and Jev is asked for the next (trigger step),
// until none is needed.
// - As the voice companion talks (trigger cue): which command shows what it is talking about. Before Oct 31 only "let's
//   look at" and other turning words were judged: the voice said "getting you there", "switching over now" and "that
//   grid's up now" and the page never moved (video-editing, Oct 31: ten misses in ten minutes).
// - As the operator's turn ends (trigger turn): which command does what they ask for, and whether they
//   ask anything of the page at all (page_asked). Until Nov 17 their request reached the page only through the voice's
//   reply to it, read as "what the voice is talking about": the voice said "Sure." or "Got it." and passed the request
//   on, and Jev, told it had gone to the agent, chose none. In two sessions that night with an order page (one command
//   per drink, size, milk, sweetness; add; place), of 18 changes the operator asked for on one of them, the voice's
//   words ran 7, the agent made 9 itself, 5 to 11 s each, and two never happened though the voice said they had; on the
//   other the voice made none. Asked of the operator's own words at those moments (47 turns): the right first command
//   for all ten orders GPT Live had passed on (.71 to .99; .51 and .42 on two commands that choose the same drink), and
//   no command for 29 of the 30 turns that asked nothing of the page. Between steps Jev is asked only for what their
//   words ask for: asked "what should run next to finish it", it went on from "get me the mocha" to adding the drink
//   and placing the order. With copies of both pages in a headless browser, the operator's orders in turn and Jev
//   itself, all 15 turns on one page and all 8 on the other ended as asked, five settings from one request in a second.
const pageQuestions = (page: StageView, trigger: Trigger, asked: boolean) => ({
  page_command: { type: 'choice', instructions: asked
    ? trigger === 'step'
      ? 'The commands in `page_done` have run for the operator\'s latest words, and the page is where `page` says. Do those words ask for anything more that is not done yet and that a listed command does? If so, which command does the next part of it? Only what their words ask for: choose none when everything they asked for is done, or no listed command does the rest. What usually comes next (adding it, placing or sending it, the next step or part) is not asked for until they say so.'
      : 'Which page command, if any, does what the operator asks for in the latest words, or the first part of it? A command does it when running it now carries out their request or one step of it: choosing, setting, adding, removing, placing or showing something. Choose none when no listed command does any of it.'
    : trigger === 'step'
    ? 'Which page command should run next to finish showing what the voice companion is talking about in the latest words, now that the commands in `page_done` have run and the page is where `page` says? A part\'s own controls (its rows, columns, toggles or steps) are listed only while that part is on screen. Choose none when the page now shows it.'
    : 'Which page command, if any, should run now so that the page shows what the voice companion is talking about in the latest words, or what it says it is showing or will show? A part may be named by what it says, by how the page labels it, or by its number said as a word ("section four" is section 4, not the next one). Choose none when the page already shows it, when no command shows it, or when the companion is not talking about anything on the page.',
    criteria: { none: asked
      ? trigger === 'step'
        ? 'Everything the latest words ask for is done by the commands in `page_done`, or no listed command does what is left. Also none for anything they did not ask for in these words, however natural as a next step.'
        : 'No listed command does what they ask: it is for the coding agent (work on the project or on the page itself, something to be told or sent to it), a question or talk for the companion, or about how the companion behaves. Also none when the page is already as they ask, or the voice tool has just done it (the end of `history`).'
      : 'No page command: the page already shows it, no command shows it, or the companion is not talking about the page. Also none when the companion only mentions a part in passing or as something to come to later, without turning to it now; when the operator has just moved the page themselves and the companion is talking about what they moved to; and when the voice tool has just done on the page what the companion is confirming (the end of `history`).',
      ...Object.fromEntries(page.commands.map(c => [c.id, c.say])) } },
  // Asked of the operator's words (not between steps): a remark about the page, or a question, runs nothing on it.
  ...asked && trigger !== 'step' && { page_asked: noul('Do the latest words ask for something to be done or shown on the page right now?',
    'A request or go-ahead to do something on the page now: to choose, set, add, remove, place or send something, to open or show a part, to go to a place or on to the next one; or "yes", "do it", "go ahead" to what the companion just offered to do there.',
    'Nothing is asked of the page right now: they remark on what is on it, react, think aloud, give feedback or an opinion, ask a question about it (the companion answers, and shows what it talks about itself), ask to be walked or run through something (the companion leads, at its own pace), or ask for work on the page itself (the coding agent\'s).') },
  // Asked with the voice's own words only (not between steps): the cue for reading the operator's kept words again.
  ...trigger === 'cue' && { gave_up: noul('Is the voice companion saying, in the latest words, that it cannot answer or show what the operator asked: that it does not know, could not find it on the page or in what it was told, or that it is for the coding agent to do?',
    'It says it does not know or is not sure of the answer, that the page does not have it, that it could not find it, or that the coding agent would have to check, answer or do it.',
    'Anything else: it answers, explains, presents, asks the operator something, acknowledges them, or says it is passing something on or checking.') },
  page_more: asked
    ? noul('Do the latest words ask for more than this one command does?',
      'They ask for several things (two settings, a drink and its size, "add it and place the order", an item and then the next), or for something inside a part that takes a further command once this one has brought it on screen (a part\'s own controls are listed only then).',
      'They ask for one thing, and this command alone does it; or no command should run. What usually comes next (adding it, placing or sending it, the next step) is not asked for until they say so.')
    : noul('Will the page need another command right after this one to show what the voice companion is talking about?',
      'What it talks about is inside or beyond what this command shows: a row, column, toggle, step or highlight within the part this command brings on screen (a part\'s own controls are listed only once it is on screen), or several things it names in turn.',
      'This command alone shows it, or no command should run.'),
});
const pageLine = (page: StageView, now = Date.now()) => {
  const moved = page.viewerAt && now - page.viewerAt < 60000 ? ` The viewer moved the page themselves ${Math.max(1, Math.round((now - page.viewerAt) / 1000))} s ago.` : '';
  const focus = focusLine(page.focus);
  return `${page.title} (${page.url})${page.about ? `: ${page.about}` : ''}. The viewer is at: ${page.where.slice(0, 500)}${focus ? ` (${focus})` : ''}.${moved}`.slice(0, 1100);
};
// What a command shows, for counting commands that show the same as one choice: the part it goes to (by its name, the
// heading it goes to, without a number before it or a word such as "grid" after it, or the place its id names:
// goto_record and the page's show_record), the element it lands on, going back (fdc's own, the page's back or previous),
// the page's next, or what it says.
const GENERIC = /\s+(grid|section|chart|table|view|panel|tab|slide|diagram|figure|part)$/;
const partOf = (text: string) => text.toLowerCase().replace(/^(stage|slide|step|part|section)\s*\d+\s*[:.\-–,]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an|my|our|your)\s+/, '').replace(GENERIC, '').trim();
const keysOf = (command: StageCommand) => {
  const page = command.id.startsWith('page_'), said = `say ${command.say.replace(/\s*\([^()]*\)\s*$/, '').toLowerCase().trim()}`;
  if (command.id === 'back' || (page && /(^|_)(previous|prev|back)(_|$)/.test(command.id))) return ['back', said];
  if (page && /(^|_)(next|forward)(_|$)/.test(command.id)) return ['next', said];
  const headed = /\(headed "([^"]+)"\)/.exec(command.say)?.[1];
  const place = command.id.replace(/^page_/, '').replace(/^(goto|go_to|go|show|section|open|view)_/, '');
  return [command.name && partOf(command.name) && `part ${partOf(command.name)}`, headed && partOf(headed) && `part ${partOf(headed)}`, command.anchor && `at ${command.anchor}`, /[a-z]/.test(place) && `place ${place}`, said].filter(Boolean) as string[];
};
/**
 * The command Jev chose, if it is sure enough. Commands that show the same thing split its confidence between them, even
 * below "none": one part's (its heading, the page's own command, an annotation on it: "connecting to the server" .43, .38
 * and .11; the grid's annotation .35 and its section .31 for "Yeah, getting you there", Oct 31), going back (fdc's own and
 * the page's: "go back… I don't see it" .26 and .11, with none at .40), or two that say the same ("Go to the next
 * section", fdc's own and the page's: .42 and .33 on "Okay, next", Oct 29), or a heading listed twice, once with its
 * number before it (.36 and .33 on a page that was not made for fdc, Nov 6). They count as one choice, linked by any of
 * those, and its likeliest runs, the page's own first among those as likely and before fdc's own move to the part's heading.
 */
export function chosenCommand(answer: any, page: StageView, without: Iterable<string> = [], from = PAGE_STEP): string | undefined {
  if (!answer) return;
  let likely: Record<string, number> = answer.probabilities ?? { [answer.choice]: Number(answer.confidence ?? 1) };
  // Without commands that had nothing to do: the rest, as likely as they are among themselves ("back" .55 with nothing to go
  // back to left the main map .30 of the remaining .45, Oct 31).
  const dropped = new Set(without);
  if (dropped.size) {
    const kept = Object.entries(likely).filter(([id]) => !dropped.has(id)), mass = kept.reduce((total, [, p]) => total + Number(p), 0);
    if (!(mass > 0)) return;
    likely = Object.fromEntries(kept.map(([id, p]) => [id, Number(p) / mass]));
  }
  // Commands sharing any key are one choice (union-find over the page's commands, likely or not: a heading links its
  // section's annotation to the page's own command for it).
  const root = new Map<string, string>(), find = (id: string): string => { const up = root.get(id) ?? id; return up === id ? id : find(up); };
  const owner = new Map<string, string>(), link = (a: string, b: string) => { if (find(a) !== find(b)) root.set(find(a), find(b)); };
  for (const command of page.commands) for (const key of keysOf(command)) { const other = owner.get(key); if (other) link(command.id, other); else owner.set(key, command.id); }
  // A part named with its list number is the part of that name without it ("1 Set up" and "Set up"); two numbered ones
  // stay apart ("7 days", "30 days"), and so does a year.
  for (const [key, id] of owner) { const plain = owner.get(key.replace(/^part (\d{1,2} )+(?=[a-z])/, 'part ')); if (plain) link(id, plain); }
  const groups = new Map<string, StageCommand[]>();
  for (const command of page.commands) if (likely[command.id] !== undefined && !dropped.has(command.id)) groups.set(find(command.id), [...groups.get(find(command.id)) ?? [], command]);
  const sum = (group: StageCommand[]) => group.reduce((total, c) => total + Number(likely[c.id] ?? 0), 0);
  const best = [...groups.values()].sort((a, b) => sum(b) - sum(a))[0];
  if (!best || sum(best) < from || sum(best) < Number(likely.none ?? 0)) return;
  // fdc's own move to a part's heading stands in for the page's command for that part: what Jev put on it counts for the
  // page's own, where the page has one in this choice. Which of the two Jev leans to varies from sentence to sentence
  // (.61 and .27, then .28 and .50, one live run of Nov 13), and the page's own shows the part the way its author meant.
  const own = best.filter(c => c.id.startsWith('page_') && Number(likely[c.id] ?? 0) > 0).sort((a, b) => Number(likely[b.id]) - Number(likely[a.id]))[0];
  const share = (c: StageCommand) => Number(likely[c.id] ?? 0) + (c === own ? sum(best.filter(other => other.id.startsWith('goto_'))) : 0);
  const ranked = best.sort((a, b) => share(b) - share(a) || Number(b.id.startsWith('page_')) - Number(a.id.startsWith('page_')));
  // The page's own command among the likeliest (within a tenth of the top), else the likeliest.
  return (ranked.find(c => c.id.startsWith('page_') && share(c) >= share(ranked[0]) - .1) ?? ranked[0]).id;
}

// The operator's goal: what they want shown, taught or walked through, kept apart from the page (bridge.ts), so that the
// voice keeps to it through questions, pauses and edits, and the page follows it. The Codex study of Oct 31 found a
// controller's menu taking over as the agenda once the voice started moving the page.
const GOAL_QUESTION = {
  goal: { type: 'choice', instructions: 'Do the latest words set what the operator wants the voice companion to show, teach or walk them through (their goal), or end the goal in force (`goal`)?',
    criteria: {
      keep: 'Neither: a question, a reaction, an aside, a request for the coding agent, or a step within the goal in force (continue, next, go back, say more about that part).',
      new: 'They ask to be shown, taught or explained something as a whole: a page, a part of it, a diagram, a topic ("explain the graph to me", "run me through who\'s engaging", "teach me how the queue works").',
      walk: 'They ask to be walked or run through several parts in turn: a page section by section, a diagram block by block, steps one at a time, from start to end ("walk me through the report", "step through each block", "go through all of it, don\'t wait for me").',
      done: 'They end or drop the goal in force: it is enough, they are done with it, or they turn to something else for good.' } },
};

const LEARNER = {
  behave: { type: 'noul', instructions: 'In the latest words, is the operator telling the voice companion how to behave toward them from now on (not designing the tool, not asking the coding agent to do something, not a one-off cue)?',
    criteria: { true: "A standing request about the companion's own conduct toward the operator for the rest of the conversation or longer: when to speak or stay quiet, how much detail, pace, what to read out, what to relay or delegate.", false: 'Designing or discussing the voice tool or GPT Live; a task for the coding agent; a one-off cue or request (go on, next, repeat, stop this sentence); a question about the work.' } },
  design_talk: noul('The operator is often building this voice tool itself. Is the operator discussing how a voice tool or GPT Live should be designed or built, as a topic for the coding work, rather than telling this voice companion how to behave?',
    "Talks about the voice tool's design, settings or code, or describes GPT Live's behaviour as a problem to solve.", 'Speaks to the companion itself about how it should behave now or from now on.'),
  lasting: { type: 'choice', instructions: 'How long does the operator want the voice companion to follow what their latest words tell it?',
    criteria: { this_moment: 'Only right now, e.g. stop the current sentence or skip this one.', this_session: 'For the rest of this conversation, task or phase.', always: 'In every session: a standing preference.' } },
};

// Asked with the learner's questions while instructions Jev learned are in force: adding was all it could do, and the
// operator had to click Remove on the page.
const removeQuestion = (removable: { id: string; text: string }[]) => ({ remove: { type: 'choice',
  instructions: 'In the latest words, does the operator ask the voice companion to drop one of their standing instructions (`operator_instructions`): to forget it, stop following it, or go back to how it was before it?',
  criteria: { none: "No instruction is to be dropped: they give a new instruction, repeat or tighten one, complain, ask for something once, or say to ignore or forget something that isn't one of these instructions (a request, a remark, something the companion said).",
    ...Object.fromEntries(removable.map(item => [item.id, `They ask to drop ${item.id} ("${item.text.replace(/\s+/g, ' ').slice(0, 200)}"): to forget it, stop following it, undo it, or they say it no longer applies.`])) } } });

export class Jev {
  apiKey: string; fetch: Fetch;
  log: (event: Record<string, unknown>) => void;
  /** Takes every call as it ends, answered or not (jev-audit.ts). */
  record?: (call: JevCall) => void;
  /** What Jev is told of its place (setting): the agent it serves and the optional features on. */
  setting: string; features: Feature[];
  constructor({ apiKey, log, record, fetch = globalThis.fetch as unknown as Fetch, agent = { profile: { name: 'the coding agent' } }, features = new Set(DEFAULT_FEATURES) }: { apiKey: string; log: (event: Record<string, unknown>) => void; record?: (call: JevCall) => void; fetch?: Fetch; agent?: { profile: Pick<AgentProfile, 'name'> }; features?: Features }) {
    this.apiKey = apiKey; this.log = log; this.record = record; this.fetch = fetch; this.setting = setting(agent, features); this.features = [...features];
  }
  /** What one call sends Jev about a moment: the state it reads and the questions asked of it (a recorded moment can be put to it again). */
  ask(moment: Moment): { state: Record<string, string>; questions: Record<string, unknown> } {
    const { trigger, latest, history = '', instructions, sessions, page, learn, tune, reply, removable } = moment;
    // The operator's turn: one request, the same each time it is made; words that went to the agent without it are read for
    // whether they needed it.
    const turn = trigger === 'turn', sends = turn || trigger === 'unsent', whole = turn && Boolean(moment.saying);
    const JOB = sending(whole), FORK = forking(whole);
    // The page is read for what the operator asks of it in their turn, and on through the steps that follow.
    const asked = Boolean(page) && (turn || (trigger === 'step' && latest?.role === 'operator'));
    // The latest words in their own field: marked inside the conversation instead, Jev read plain page moves as likelier
    // work for the agent (page_work up by .1 on average, Oct 21).
    const state: Record<string, string> = { setting: this.setting + (sessions ? SESSIONS_SETTING : '') + (page ? PAGE_SETTING : '') + (tune ? ` ${TUNER_SETTING}` : ''), why: trigger === 'quiet' && moment.unanswered ? QUIET_UNANSWERED : trigger === 'step' && asked ? STEP_ASKED : WHY[trigger], history: history.trim() || '(none)', latest: latest ? spokenLine(latest) : '(none)' };
    // Words still waiting from an earlier turn, with the latest: what the operator is saying, whole.
    if (whole) state.saying = spokenLine({ role: 'operator', text: moment.saying! });
    if (instructions) state.operator_instructions = instructions.join('\n') || '(none)';
    if (turn) state.voice_reply = reply?.trim() || '(the companion has not replied)';
    if (sessions) state.sessions = sessionLines(sessions);
    if (page) state.page = pageLine(page);
    // The commands already run for the latest words: between steps, and in their turn's request once the voice tool has done what the operator asked on the page.
    if (trigger === 'step' || (turn && moment.done?.length)) state.page_done = (moment.done ?? []).map((c, i) => `${i + 1}. ${c.say}${c.shown ? ` → ${c.shown.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n') || '(none)';
    if (turn || trigger === 'cue' || trigger === 'step' || trigger === 'quiet') state.goal = moment.goal || '(none)';
    // The job delegation knows what the page's controller can do: what it can't goes to the agent, to add it. All of
    // them: cut at 3,000 characters, a page of 81 commands lost the last third of its list (Nov 17).
    if (page && sends) state.page_commands = page.commands.map(c => `- ${c.say}`).join('\n') || '(none)';
    if (tune) Object.assign(state, { earlier_sessions: tune.earlier.join('\n').slice(0, 4000) || '(none)', current_settings: JSON.stringify(tune.current) });
    const questions = {
      ...sends && { needs_agent: JOB.needs_agent }, ...turn && { ready: JOB.ready }, ...turn && moment.sent && { adds: JOB.adds }, ...turn && moment.working !== undefined && { now: JOB.now },
      ...trigger === 'quiet' && { standby: QUIET.standby },
      // Words about how the companion behaves are for the learner and the tuner: asked only while either is on.
      ...turn && { ...(learn || tune) && { companion_only: GATE.companion_only }, ...instructions?.length && INSTRUCTED, ...GOAL_QUESTION, ...sessions && sessionQuestions(sessions) },
      // Forks: whether the words belong in a fork, while one can open (the main session in focus) or one is in focus; and with one in focus, whether the operator has left its matter (turn.ts).
      ...turn && moment.fork && { tangent: FORK.tangent, ...moment.fork === 'fork' && { settled: FORK.settled } },
      ...page && (turn || trigger === 'cue' || trigger === 'step') && pageQuestions(page, trigger, asked),
      ...learn && LEARNER, ...learn && turn && removable?.length && removeQuestion(removable),
      ...tune && tunerQuestions(tune.current, tune.pinned, trigger !== 'settings'),
    };
    return { state, questions };
  }
  /** One call: everything the voice tool asks about this moment. */
  async read(moment: Moment, timeoutMs = 3000): Promise<Reading> {
    const { trigger, latest, history = '', sessions, page, learn, tune, requestId, handOff, made } = moment, started = Date.now();
    const said = latest?.text.replace(/\s+/g, ' ').trim() ?? '', turn = trigger === 'turn';
    const { state, questions } = this.ask(moment);
    // The operator's own request, and the steps after it: whether they ask anything of the page is read apart (turn.ts).
    const request = 'page_asked' in questions || (trigger === 'step' && latest?.role === 'operator');
    const call: JevCall = { id: randomUUID(), at: started, trigger, ...made && { made }, ...requestId && { requestId }, ...handOff && { handOff },
      config: { url: URL, model: MODEL, timeoutMs, features: this.features, thresholds: Object.fromEntries(Object.keys(questions).filter(name => name in THRESHOLDS).map(name => [name, moment.thresholds?.[name] ?? (name === 'page_command' && request ? PAGE_REQUEST : THRESHOLDS[name])])) },
      state, questions, ms: 0 };
    let answers: any;
    try {
      const response = await this.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, state, questions }), signal: AbortSignal.timeout(timeoutMs) });
      call.status = response.status;
      if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
      ({ answers } = await response.json());
    } catch (error) {
      this.record?.({ ...call, ms: Date.now() - started, error: (error as Error).message });
      throw error;
    }
    Object.assign(call, { ms: Date.now() - started, answers });
    // Its record waits for what fdc does with the answers (jev-audit.ts).
    this.record?.(call);
    const p = (name: string, missing = 0) => { const value = Number(answers?.[name]?.noul); return Number.isFinite(value) ? value : missing; };
    const reading: Reading = { trigger, id: call.id, said, transcript: `${history}${latest ? `► ${spokenLine(latest)}` : ''}`, needsAgent: 'needs_agent' in questions ? p('needs_agent') : null, ...'ready' in questions && { ready: p('ready', 1) }, ...'adds' in questions && { adds: p('adds', 1) }, ...'now' in questions && { now: p('now', 1) } };
    if ('tangent' in questions) reading.tangent = p('tangent');
    if ('standby' in questions) reading.standby = p('standby');
    if (turn) {
      if ('companion_only' in questions) reading.companionOnly = p('companion_only');
      if ('withheld' in questions) reading.withheld = p('withheld');
      if ('settled' in questions) reading.settled = p('settled');
      const goal = answers?.goal, choice = goal?.choice;
      if (choice === 'keep' || choice === 'new' || choice === 'walk' || choice === 'done') reading.goal = { choice, p: Number(goal.probabilities?.[choice] ?? goal.confidence ?? 1) };
    }
    if (turn && sessions) {
      const chosen = (choice: string) => sessions.filter((_, index) => answers?.[`session_${index + 1}`]?.choice === choice).map(s => s.id);
      reading.sessions = { asked: p('sessions_asked'), unlisted: p('unlisted_session'), turnOn: chosen('turn_on'), turnOff: chosen('turn_off') };
    }
    if (page && (turn || trigger === 'cue' || trigger === 'step')) {
      const answer = answers?.page_command;
      reading.page = { command: chosenCommand(answer, page, [], request ? PAGE_REQUEST : PAGE_STEP), more: p('page_more'), ...answer?.probabilities && { likely: answer.probabilities }, ...'gave_up' in questions && { gaveUp: p('gave_up') }, ...'page_asked' in questions && { asked: p('page_asked') } };
      // The likeliest commands, for tuning the page question.
      const top = Object.entries(answer?.probabilities ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3).map(([id, v]) => `${id} ${Number(v).toFixed(2)}`).join(', ');
      this.log({ type: 'page.judged', trigger, said: said.slice(-200), command: top, more: Number(reading.page!.more?.toFixed(2)), ...reading.page!.asked !== undefined && { asked: Number(reading.page!.asked.toFixed(2)) } });
    }
    if (learn) reading.instruction = { behave: p('behave', NaN), design: p('design_talk', NaN), lasting: answers?.lasting?.choice };
    const drop = answers?.remove;
    if (drop?.choice && drop.choice !== 'none' && moment.removable?.some(item => item.id === drop.choice)) reading.remove = { id: drop.choice, p: Number(drop.probabilities?.[drop.choice] ?? drop.confidence ?? 1) };
    if (tune) reading.tuning = answers;
    this.log({ type: 'jev.read', id: call.id, trigger, ...made && { made }, said: said.slice(-200), questions: Object.keys(questions).length, chars: JSON.stringify(state).length, ms: Date.now() - started, needsAgent: reading.needsAgent, ready: reading.ready, ...turn && { reply: state.voice_reply.slice(-200) }, companionOnly: reading.companionOnly, withheld: reading.withheld, standby: reading.standby, sessions: reading.sessions, instruction: reading.instruction });
    return reading;
  }
}
