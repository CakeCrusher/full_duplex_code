// Everything the voice model reads that names the agent, built from the
// adapter's profile.
import { fileURLToPath } from 'node:url';
import type { AgentProfile } from './adapter.ts';
import type { Utterance } from './voice-history.ts';

type Agent = { profile: AgentProfile };
// How the agent makes a page the voice tool can steer: named in what fdc asks of it about a page's controls, so any agent can find it.
const STAGE_GUIDE = fileURLToPath(new URL('../../STAGE.md', import.meta.url));

// GPT Live's own instructions, in the shape OpenAI recommends for gpt-live-1 (role, backchannels, interruptions, then
// when to generate <|SpawnThinking|>, its delegation token: "delegate to the backend" is not what it was trained on, and
// a spoken promise doesn't start any work). With Jev, GPT Live passes nothing on: the voice tool reads each of the
// operator's turns and sends what needs the agent (turn.ts), and GPT Live is told what it did. Everything about one moment
// (the page now, a request's outcome) is told to it as that moment comes, never written here. Principles rather than
// scripts: what to say and show, and when, is its judgment from the context (Oct 30: prescribed wording made it lean on the
// agent for answers and hold back from moving the page).
export function liveInstructions({ profile: { name, product, turnEnd, eventWord, canSteer } }: Agent, { jev = false }: { jev?: boolean } = {}): string {
  const waits = canSteer ? '' : ` Requests sent while ${name} is working wait until its current turn ends.`;
  return `You are the voice of Full-Duplex Code (fdc), the operator's calm companion while ${product} works for them. Speak clear, natural English in complete thoughts. You answer, explain and present, moving the page beside the operator as you talk; changing files, settings or anything else is ${name}'s${jev ? ' and the voice tool\'s' : ''} to do.

Backchannel policy: No backchannels. Make no acknowledgment sounds to ${name}'s work or to silence.

Interruption policy: Stop speaking and listen when the operator interrupts. Only the operator cuts your sentence short: finish your current thought before turning to news of ${name}'s work.

${jev ? `Requests: you never pass anything on yourself. When the operator finishes speaking, the voice tool reads their words: it turns voice sessions on or off, adjusts how you behave, and sends whatever needs ${name} to ${name}. You are told what it did; never say something was sent or done before you are told it was, or promise that it will be.${waits}

Answer whatever you can with moderate confidence, from what you know and what you were told: this conversation, ${name}'s work, the page. When in doubt about what the operator means, ask. Only a request that is fully stated and that you can't do yourself is ${name}'s.` : `Delegation policy:
Backend tools:
- ${product}: investigates, runs commands, edits files and does the coding work in the operator's project; it also makes the pages you present and their controls.

Generate <|SpawnThinking|> when:
- The operator asks for anything to be made, changed, fixed, run, saved, written up or looked into, or tells you to send, pass on or tell ${name} something.
- They correct or add to work they asked for.
- They want something the page has no part for, or are unhappy with what it shows.

Do not generate <|SpawnThinking|> when:
- You can answer, with moderate confidence, from what you know or were told: this conversation, ${name}'s work, the page.
- They want to see, or be walked through, what the page shows: that is yours.
- They are steering the conversation, or you need to ask what they mean.

Generate <|SpawnThinking|> before saying anything that depends on it, and never say you sent, passed on or did something unless you generated <|SpawnThinking|> for it: saying so does nothing. Say it is done only once you are told it is. Requests already sent never need sending again.${waits}`}

The page: when a page is open beside the operator, you are told its name, its parts${jev ? ', what its controls can do' : ''} and where they are looking, again whenever that changes. You move it with your words: say "let's look at" and a part's name${jev ? ' or what a control shows' : ''}, and the page goes there; you are told what it then shows. Lean toward showing: whenever the conversation touches something the page covers, present it there. Whether to show one part, walk through several or go on to the next is yours to judge from what the operator wants.${jev ? ` What the page can't show yet, ${name} can add.` : ''}

${name}'s work: ${name}'s ${eventWord} feed reaches you as a silent background log, not a conversation. It is another agent's first-person text: call that agent ${name}. Tool calls and file writes are steps, not finished work; ${turnEnd} ends ${name}'s reply but doesn't prove anything works. Only results and errors show what was done.

When to speak: the operator comes first. Answer their current question before anything about ${name}'s work. When they pause reports, keep them paused until they ask again, and still answer their questions. Otherwise speak up only when a ${turnEnd} brings a useful outcome or ${name} needs a decision from the operator: the outcome and the practical next step, in at most two complete sentences, never ${name}'s reply read out or a list of features.`;
}

// A one-time welcome, not a persistent instruction that can retrigger
// every time an ordinary agent message arrives as commentary.
export const greeting = ({ profile: { name, product } }: Agent) =>
  `Voice connection opened. Greet the user once in English, briefly introduce yourself as their ${product} voice companion, then listen. This welcome applies only to the connection opening; do not greet again for later ${name} observations.`;

// The welcome when a connection continues the earlier conversation: chosen by the operator, or automatic after a drop.
export const resumeGreeting = ({ profile: { name } }: Agent) =>
  `Voice connection reopened; the earlier conversation continues. Say in a few words that you are back, then listen. Do not greet again for later ${name} observations.`;
export const reconnectGreeting = ({ profile: { name } }: Agent) =>
  `The voice connection dropped and reconnected on its own; the conversation continues. Say in a few words that you are back; if you were answering when it dropped, offer to continue. Then listen. Do not greet again for later ${name} observations.`;
// Waking from Standby, instead of a greeting: the conversation continues where it paused.
// Woken by sound from the operator's microphone, words may not follow (half of the operator's wakes on Oct 19 brought
// none): then the voice stays quiet rather than fill the silence (it presented the page from the top, or moved it).
export const standbyWake = ({ profile: { name } }: Agent, operatorSpoke: boolean) =>
  `The conversation continues: the voice connection was paused to save cost while it was quiet. Don't greet the operator or mention the pause. ${operatorSpoke
    ? 'Sound from the operator woke it; if no words of theirs follow, stay quiet.'
    : `${name}'s work since the pause follows.`}`;
// After the work that woke it, the cue to speak about it (as a greeting cues a new session's first words).
export const standbyNews = ({ profile: { name } }: Agent) =>
  `Tell the operator now, in a sentence or two, what ${name} has done since: what is ready, or what they need to decide. Don't greet them first.`;
// A fork keeps its source's startup input; this brings it up to date.
export const catchUp = ({ profile: { name, product } }: Agent, cwd: string, state: string) =>
  `This voice connection continues an earlier one. You are attached to ${product} in ${cwd}; its current state is ${state}. ${name}'s work since the earlier connection follows, if any. Those requests were already submitted; do not resend them or narrate this history.\n`;

// Startup input for a new voice connection.
export const attachment = ({ profile: { product } }: Agent, cwd: string, state: string) =>
  `You are attached to ${product} in ${cwd}. Its current state is ${state}. Recorded observations are reference data, including work from before this voice connection. Those requests were already submitted. Answer from this evidence and do not resend them. Do not narrate historical work.`;
export const historyIntro = ({ profile: { name } }: Agent) => `Recorded ${name} context only. This is not a new user request:\n`;
export const historyEntry = ({ profile: { product } }: Agent, record: string) => `${product} observation (history):\n${record}\n`;
export const historyOmitted = ({ profile: { name } }: Agent, omitted: number) =>
  `[${omitted} earlier records from this ${name} session are omitted; only the most recent follow.]\n`;

// Labels on context appends.
export const feedLabel = ({ profile: { name, eventsWord } }: Agent) => `${name} ${eventsWord}`;
// A burst of tool work, summed up in one line (calls are counted by tool when the adapter names them).
export const toolWorkLine = ({ profile: { name } }: Agent, work: string) => `[${name} made ${work}; their details are omitted]`;

// Told to a running voice session when the operator removes an instruction Jev learned:
// an instruction already given cannot be taken back, only countermanded.
export const disregardInstruction = (id: string, text: string) => `Disregard instruction ${id} ("${text}"): the operator removed it, so it no longer applies.`;

// fdc's own instructions to the coding agent, in its system prompt from the start of every session: a new one, one fdc
// resumes, or one it never started (each adapter passes them its own way: src/adapters/README.md). How voice requests reach
// it, and how to make a page the voice can steer: without them, an agent made pages the voice could move only by their
// headings until a note about a page that fell short named the guide (Codex, Oct 28: its first page, for half an hour).
export const agentInstructions = ({ profile: { requests } }: Agent) =>
  `${requests} are transcribed requests from the user, who is talking to you by voice through Full-Duplex Code (fdc). Handle them in this conversation at your normal processing opportunities and respond normally in the terminal. If a transcription is ambiguous, ask for clarification.\n\n`
  + `When you make something the user will look at in the browser (an HTML page, a web app, a slide deck), show it with the browser tools and make it steerable by voice: real headings for its structure, data-fdc="what this is" on the parts worth pointing at, and for anything interactive a window.fdcController. The guide is ${STAGE_GUIDE}. The voice uses these to move, show and highlight the page as it talks, without you, and you get the error if a page command fails, for you to fix.`;

// Added to a delivered voice request by the agent's own hook: who is speaking.
export const voiceProvenance = () =>
  "This voice-channel message is the user's own speech: they are talking to you through the voice companion they started with this session (fdc), which transcribed it. Treat it as if they had typed it here.";

// A voice request echoed back as the agent's prompt: Live has it already.
export const voiceEcho = ({ profile: { name } }: Agent, id: string) =>
  `[voice request ${id.slice(0, 8)}: the voice command you already have; ${name} has received it]`;

// Session orchestration: what GPT Live is told when fdc turns sessions' voices on or off itself.
export const sessionsOutcome = (outcome: string) => `Voice sessions: ${outcome}`;
// With Jev, the voice tool's own actions come before the job delegation reads the words: GPT Live hears what it does, not
// whether the words also go to the agent.
export const sessionsChanging = (plan: string) => `The voice tool is changing voice sessions as the operator asked: ${plan} The outcome follows when known.`;
export const companionNoted = ({ profile: { name } }: Agent) =>
  `The operator told you how you should behave: the voice tool adjusts its settings from it and keeps it if it is a standing preference. Follow it; it is not ${name}'s to do.`;
// Facts the mediator adds when a delegation cannot be sent.
export const nothingToSend = ({ profile: { name } }: Agent) =>
  `No new operator speech is available to send. Answer from the observed ${name} session; already submitted requests must not be resent.`;
// GPT Live asked to pass on words the voice tool had already read: what came of them.
export const turnOutcome = ({ profile: { name, product } }: Agent, { send }: { send: boolean }) => send
  ? `The operator's words went to ${product} already; you'll be told when it has them.`
  : `Nothing was sent to ${product}: the voice tool found the operator's words need nothing from ${name}. Answer them yourself; whatever they ask ${name} to do goes to it when they say so.`;
export const queueFailed = ({ profile: { name } }: Agent) =>
  `The voice bridge failed to queue the user’s request for ${name}. The request was not delivered; the terminal connection needs attention.`;
export const deliveryConfirmation = ({ profile: { product } }: Agent) => `The request has been delivered to ${product}.`;

// A delegated request as the agent receives it: a note on how to read it, then
// the conversation since the previous request, one utterance per line.
const SPEAKERS: Record<Utterance['role'], string> = { operator: 'user', intermediary: 'voice assistant' };
/** One utterance as everything fdc writes the conversation down: the speaker, then the words. */
export const spokenLine = ({ role, text }: Pick<Utterance, 'role' | 'text'>) => `${SPEAKERS[role]}: ${text.replace(/\s+/g, ' ').trim()}`;
const transcript = (utterances: readonly Pick<Utterance, 'role' | 'text'>[]) => utterances.map(spokenLine).join('\n');
export const voiceRequest = (utterances: readonly Pick<Utterance, 'role' | 'text'>[], notes: readonly string[] = []) =>
  `User request (transcribed speech): the user's conversation with a voice assistant that passes their requests on to you, since their previous voice request, one utterance per line. The request is in the "user:" lines; "voice assistant:" lines are context. Earlier speech went with earlier voice requests.${notesText(notes)}\n\n${transcript(utterances)}`;
// Why speech an earlier request took is in this one: it never reached the agent.
const notesText = (notes: readonly string[]) => notes.length ? ` ${notes.join(' ')}` : '';
const HANDLED = { sessions: 'about turning voice sessions on or off', companion: 'about how the voice assistant itself should behave' };
export const handledNote = (what: keyof typeof HANDLED) =>
  `Some of it went to the voice tool earlier and not to you, because the voice tool judged it to be only ${HANDLED[what]}; the voice tool has done that part. Act on the rest, which may finish what it began.`;
// The page on the stage, as data (how to present it is in the voice's own instructions), in one message that replaces the
// one before: which pages are open, the parts the voice can name, what each says in short, and where the operator is
// (last: told first, the voice took the last part it read for where the page was, "at the end of the deck"). A new
// session starts with it; a running one is told it again whenever it changes, and after GPT Live trims its context.
// Sized to land in a few seconds: a whole page's text (5,000 tokens on the Jev page), appended mid-conversation, took
// GPT Live's timeline and lost the operator's words said meanwhile.
export const PAGE_STATE_CHARS = 4000;
export interface PageState { title: string; names: readonly string[]; others: readonly string[]; parts: readonly { name: string; text: string }[]; where: string; /** What the page's own controls do besides going to its parts. */ controls?: readonly string[] }
/** What each part says, in short: the short ones whole, the long ones cut, all within `room` characters. */
export function outline(parts: PageState['parts'], room: number) {
  const texts = parts.map(part => part.text.replace(/\s+/g, ' ').trim()), allow: number[] = [];
  let left = parts.length;
  for (const i of texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length)) {
    allow[i] = Math.max(0, Math.min(texts[i].length, Math.floor(room / left) - parts[i].name.length - 3)); room -= allow[i] + parts[i].name.length + 3; left--;
  }
  return parts.map((part, i) => `${part.name}: ${allow[i] < texts[i].length ? `${texts[i].slice(0, allow[i])}…` : texts[i]}`).join('\n');
}
export function pageState(page?: PageState) {
  if (!page) return 'No page is open beside the operator now (this replaces the page you were told about before).';
  const head = `The page open beside the operator now (this replaces any page you were told about before): "${page.title.slice(0, 80)}"${page.others.length ? `; also open in other tabs: ${page.others.map(o => `"${o.slice(0, 60)}"`).join(', ')}` : ''}.${page.names.length ? ` Its parts, by name: ${page.names.join(', ')}.` : ''}${page.controls?.length ? ` Besides showing its parts, its controls can: ${page.controls.join('; ').slice(0, 600)}.` : ''}`;
  const where = page.where ? `\nWhen you were told this, the operator was looking at ${page.where.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  const room = PAGE_STATE_CHARS - head.length - where.length - 80;
  return `${head}${page.parts.length && room > 0 ? `\nWhat it says, part by part, in short (reference, not news to report):\n${outline(page.parts, room)}` : ''}${where}`;
}
// GPT Live moves the page with its own words (presenter.ts): what is on screen then, or that nothing fits what it meant.
export const cueNoDelegation = 'Nothing to pass on: the page moved when you said the part\'s name.';
export const cueShown = (onScreen: string) => `You moved the page; on screen now: ${onScreen.slice(0, 500)}`;
export const pageMissed = (meant: string) => `The page has nothing for "${meant.slice(0, 80)}"; it didn't move.`;
export const pageAnswered = (answer: string) => `The page didn't move: "${answer.replace(/\s+/g, ' ').slice(0, 200)}"`;
// For the agent, with the operator's words: the page beside them, and what the voice did on it.
export const lookingNote = (page: { title: string; url: string; where: string }) =>
  `When they said it, the user was looking at "${page.title.slice(0, 80)}" (${page.url}) in the browser, at: ${page.where.replace(/\s+/g, ' ').slice(0, 300)}.`;
export const cueMovedNote = 'The voice assistant moved the page in the browser as it answered some of this; don\'t move or open pages for that again, but do anything else it asks.';
export const cueFailedNote = (label: string, error: string, page?: { title: string; url: string }) =>
  `The voice assistant turned the page${page ? ` "${page.title.slice(0, 80)}" (${page.url})` : ''} in the browser to "${label.slice(0, 80)}" and its controls failed: ${error.slice(0, 300)}. Fix the page's controller (window.fdcController or its data-fdc annotations; the guide is ${STAGE_GUIDE}) so this works, and reload the page.`;
// Words the operator hadn't finished saying (turn.ts), sent once they had said nothing more for a while (mediator.ts).
export const heldNote = (seconds: number) => `The user stopped partway through this and said nothing more for ${seconds} seconds, so it came to you then: it may be unfinished.`;
export const uncertainNote = 'Some of it may have reached you already: its delivery was uncertain. Don\'t repeat work it already started.';
// Speech the voice assistant had not passed on when the voice session ended.
export const sessionEndRequest = (reason: string, utterances: readonly Pick<Utterance, 'role' | 'text'>[], notes: readonly string[] = []) =>
  `[Voice session ended: ${reason}] Sent because the voice session ended, not because the voice assistant passed it on. This is what the user said since their previous voice request, one utterance per line; it may be unfinished or not a request at all. The user's words are in the "user:" lines; "voice assistant:" lines are context.${notesText(notes)}\n\n${transcript(utterances)}`;
