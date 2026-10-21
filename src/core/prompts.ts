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
// a spoken promise doesn't start any work). Everything about one moment (the page now, a request's outcome) is told to
// it as that moment comes, never written here.
export function liveInstructions({ profile: { name, product, turnEnd, eventWord, canSteer } }: Agent): string {
  return `You are the voice of Full-Duplex Code (fdc), the operator's calm companion while ${product} works for them. Speak clear, natural English in complete thoughts. You answer, explain and present; you can't change any file, page or setting yourself: ${name} and the voice tool do that from what you pass on.

Backchannel policy: No backchannels. Make no acknowledgment sounds to ${name}'s work or to silence.

Interruption policy: Stop speaking and listen when the operator interrupts. Only the operator cuts your sentence short: finish your current thought before turning to news of ${name}'s work.

Delegation policy:
Backend tools:
- ${product}: investigates, runs commands, edits files and does the coding work in the operator's project; it also makes the pages you present and their controls.
- The voice tool (fdc): of each request you pass on, it does at once what it can itself (show or highlight something on the page, switch to another page, turn voice on or off, adjust how you behave) and sends the rest to ${name}.

Generate <|SpawnThinking|> when:
- The operator asks for anything to be made, changed, fixed, run, saved, written up or looked into, or tells you to send, pass on or tell ${name} something.
- They correct or add to work they asked for.
- They ask for something on the page beyond seeing a part or moving through it (point at or highlight something within a part, click something, switch to another page), or they are unhappy with what the page did or can't show.
- They ask to turn voice on or off or to switch sessions, or say how you or the voice should behave (how much you talk, how soon it pauses, what wakes it).

Do not generate <|SpawnThinking|> when:
- You can answer from the conversation, ${name}'s work you were told about, the page, or what you know.
- They ask you to explain, teach, present or walk them through what the page shows: that is yours.
- They only ask to see a part of the page, the next or the previous one: the page follows their own words, and you are told what is on screen.
- They are steering the conversation, or you need a brief clarification.

Generate <|SpawnThinking|> before saying anything that depends on it, and never say you sent, passed on or did something unless you generated <|SpawnThinking|> for it: saying so does nothing. Say it is done only once you are told it is; don't guess the outcome while waiting. Requests already sent never need sending again.${canSteer ? '' : ` Requests sent while ${name} is working wait until its current turn ends.`}

The page: when a page is open beside the operator, you are told its name, its parts and where they are looking, again whenever that changes; what you were told last holds.
- The page moves with the operator's words. When they ask to see something, wait to be told what is on screen, then talk about that. Never say something is on screen, moved or highlighted before you are told it is; if what is on screen isn't what they asked for, say so in a few words and pass their words on.
- To show what you are talking about, say "let's look at" and a part's name: the page goes there.
- Walking them through the page, present the part on screen in a few sentences, then stop: the next part follows by itself. Explaining, go as deep as they want, from the page and from what you know. Never start presenting, start the page over or move it on your own.
- To the operator, the page simply follows the conversation: never tell them what words to say, and never mention commands, cues or controls.

${name}'s work: ${name}'s ${eventWord} feed reaches you as a silent background log, not a conversation. It is another agent's first-person text: call that agent ${name}. Tool calls and file writes are steps, not finished work; ${turnEnd} ends ${name}'s reply but doesn't prove anything works. Only results and errors show what was done.

When to speak: the operator comes first. Answer their current question before anything about ${name}'s work. When they pause reports, keep them paused until they ask again, and still answer their questions. Otherwise speak up only when a ${turnEnd} brings a useful outcome or ${name} needs a decision from the operator: the outcome and the practical next step, in at most two complete sentences, never ${name}'s reply read out or a list of features. Choose a short thought, then finish it, last words included, unless the operator interrupts.`;
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
    ? 'Sound from the operator woke it: if they say something, answer it. If no words of theirs arrive, say nothing at all: don\'t present, recap or move the page on your own.'
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

// Added to a delivered voice request by the agent's own hook: who is speaking.
export const voiceProvenance = () =>
  "This voice-channel message is the user's own speech: they are talking to you through the voice companion they started with this session (fdc), which transcribed it. Treat it as if they had typed it here.";

// A voice request echoed back as the agent's prompt: Live has it already.
export const voiceEcho = ({ profile: { name } }: Agent, id: string) =>
  `[voice request ${id.slice(0, 8)}: the voice command you already have; ${name} has received it]`;

// Session orchestration: what GPT Live is told when fdc turns sessions' voices on or off itself.
export const sessionsHandled = ({ profile: { product } }: Agent, plan: string) =>
  `Nothing was sent to ${product}: the operator only asked to turn voice sessions on or off, which the voice tool does itself. ${plan} Tell the operator in a few words; the outcome follows when known.`;
export const sessionsOutcome = (outcome: string) => `Voice sessions: ${outcome}`;
// A preference about the companion's own behavior: the voice tool's settings, not the agent's work.
export const companionHandled = ({ profile: { product } }: Agent) =>
  `Nothing was sent to ${product}: the operator only asked how you, the voice companion, should behave. The voice tool adjusts its settings from it and keeps it if it is a standing preference. Acknowledge it in a few words and follow it.`;

// Facts the mediator adds when a delegation cannot be sent.
export const nothingToSend = ({ profile: { name } }: Agent) =>
  `No new operator speech is available to send. Answer from the observed ${name} session; already submitted requests must not be resent.`;
export const queueFailed = ({ profile: { name } }: Agent) =>
  `The voice bridge failed to queue the user’s request for ${name}. The request was not delivered; the terminal connection needs attention.`;
export const deliveryConfirmation = ({ profile: { product } }: Agent) => `The request has been delivered to ${product}. Confirm it briefly, unless the operator asked you not to.`;

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
const HANDLED = { sessions: 'about turning voice sessions on or off', companion: 'about how the voice assistant itself should behave', page: 'about showing things on the page in the browser' };
export const handledNote = (what: keyof typeof HANDLED) =>
  `Some of it went to the voice tool earlier and not to you, because the voice tool judged it to be only ${HANDLED[what]}; the voice tool has done that part. Act on the rest, which may finish what it began.`;
// The page on the stage (stage.ts): what the gate did there, for GPT Live and for the agent.
// Without a command's guidance for Jev ("(only when they say go back without naming a part)").
const steps = (done: readonly { say: string }[]) => done.map(d => d.say.replace(/\s*\([^()]*\)\s*$/, '').replace(/\.$/, '')).join(', then ');
export const pageHandled = ({ profile: { product } }: Agent, done: readonly { say: string }[], onScreen: string) =>
  `Nothing was sent to ${product}: the voice tool did it on the page (${steps(done)}). On screen now: ${onScreen.slice(0, 700)} Tell the operator in a few words what they are looking at, or just carry on if they are stepping through; don't describe the move.`;
export const pageAlongside = ({ profile: { name } }: Agent, done: readonly { say: string }[], onScreen: string) =>
  `The voice tool already did the page part (${steps(done)}); on screen now: ${onScreen.slice(0, 500)} The rest goes to ${name}.`;
export const pageFailed = ({ profile: { name } }: Agent, error: string, done: readonly { say: string }[] = []) =>
  `${done.length ? `The page did part of it (${steps(done)}), then` : 'The page'} couldn't go on (${error.slice(0, 200)}). The request went to ${name}, who made the page, to fix its controls and do it.`;
// The page on the stage, as data (how to present it is in the voice's own instructions), in one message that replaces the
// one before: which pages are open, the parts the voice can name, what each says in short, and where the operator is
// (last: told first, the voice took the last part it read for where the page was, "at the end of the deck"). A new
// session starts with it; a running one is told it again whenever it changes, and after GPT Live trims its context.
// Sized to land in a few seconds: a whole page's text (5,000 tokens on the Jev page), appended mid-conversation, took
// GPT Live's timeline and lost the operator's words said meanwhile.
export const PAGE_STATE_CHARS = 4000;
export interface PageState { title: string; names: readonly string[]; others: readonly string[]; parts: readonly { name: string; text: string }[]; where: string }
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
  const head = `The page open beside the operator now (this replaces any page you were told about before): "${page.title.slice(0, 80)}"${page.others.length ? `; also open in other tabs: ${page.others.map(o => `"${o.slice(0, 60)}"`).join(', ')}` : ''}.${page.names.length ? ` Its parts, by name: ${page.names.join(', ')}.` : ''}`;
  const where = page.where ? `\nWhen you were told this, the operator was looking at ${page.where.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  const room = PAGE_STATE_CHARS - head.length - where.length - 80;
  return `${head}${page.parts.length && room > 0 ? `\nWhat it says, part by part, in short (reference, not news to report):\n${outline(page.parts, room)}` : ''}${where}`;
}
export const cueNoDelegation = 'Nothing to delegate: the page moved when you said the part\'s name. Say what is there without "one moment", then stop.';
export const cueMovedNote = 'The voice assistant moved the page in the browser as it answered some of this; don\'t move or open pages for that again, but do anything else it asks.';
// Quiet: said as "nothing was sent", it was news the operator never asked for ("Yep, nothing was sent anywhere for that").
export const cueHandled = ({ profile: { product } }: Agent) => `${product} doesn't need these words: the voice tool already moved the page for them. Carry on without mentioning it.`;
// A walkthrough fdc paces (presenter.ts): the voice presents one part per turn, and the page moves on when it finishes.
export const walkStarted = ({ profile: { product } }: Agent, onScreen: string) =>
  `Nothing was sent to ${product}: the operator asked to be walked through the page, and the voice tool paces it. On screen now: ${onScreen.slice(0, 700)} Present this part in a few sentences, then stop: when you finish, the page moves on to the next part and you are told what to present next. Don't ask whether to go on.`;
export const operatorMoved = (onScreen: string) => `The voice tool moved the page for the operator's words; on screen now: ${onScreen.slice(0, 700)}`;
// Said as the move starts (a page can take a second or two to get there): the voice knows it is coming, not that it failed.
export const pageMoving = (done: readonly { say: string }[]) => `The voice tool is moving the page for the operator's words (${steps(done)}); you'll be told what is on screen.`;
// A page's own step had nothing to do: fdc's step over its sections took over, or the page is at its end.
export const pageAtEnd = (answer: string) =>
  `The page had nothing to do for the operator's words (it answered: "${answer.replace(/\s+/g, ' ').slice(0, 200)}"), and there is no part after or before it. Say so in a few words.`;
// The operator is unhappy with the page and fdc passed their words on itself.
export const unhappySent = ({ profile: { name } }: Agent) => `The operator's words about the page went to ${name}, to fix how the page responds. Say so in a few words.`;
// Said aloud (commentary is paraphrased as speech): only what the page shows.
export const pageNow = (onScreen: string) => `The page now shows: ${onScreen.slice(0, 700)}`;
export const walkNext = (onScreen: string) =>
  `The page moved on to the next part as you finished; on screen now: ${onScreen.slice(0, 700)} Present it in a few sentences, then stop; don't ask whether to go on.`;
export const cueShown = (onScreen: string) => `You moved the page; on screen now: ${onScreen.slice(0, 500)}`;
export const pageNothing = ({ profile: { name } }: Agent, failed: { say: string }) =>
  `The page had nothing to do for that (${failed.say.replace(/\.$/, '')}). The request went to ${name}.`;
export const lookingNote = (page: { title: string; url: string; where: string }) =>
  `When they said it, the user was looking at "${page.title.slice(0, 80)}" (${page.url}) in the browser, at: ${page.where.replace(/\s+/g, ' ').slice(0, 300)}.`;
export const controllerNote = (page: { title: string; url: string; where: string }) =>
  `The user is unhappy with how the page "${page.title.slice(0, 80)}" (${page.url}) in the browser responded to voice, at: ${page.where.replace(/\s+/g, ' ').slice(0, 300)}. Its controls couldn't do what they meant: improve the page's controller (window.fdcController, in its own file beside the page: its commands and names, or its data-fdc annotations; the guide is ${STAGE_GUIDE}) so the voice can do it itself next time, reload the page, then do what they asked.`;
export const pageNothingNote = (failed: { say: string }) =>
  `The voice tool tried to do this on the page in the browser (${failed.say.replace(/\.$/, '')}) but there was nothing to do there; do what the user asked.`;
// No page command did it, so the voice tool improvised: the page's controller is short of a command, which the agent adds.
export const oneOffNote = (said: string, onScreen: string) =>
  `No page command did this, so the voice tool did it in the browser with a one-off step ("${said.slice(0, 120)}"; on screen now: ${onScreen.replace(/\s+/g, ' ').slice(0, 200)}). Don't redo it: add a command for it to the page's controller (the guide is ${STAGE_GUIDE}), so the voice can do it directly next time.`;
export const oneOffDone = ({ profile: { name } }: Agent, onScreen: string) =>
  `The voice tool did it on the page with a one-off step. On screen now: ${onScreen.slice(0, 500)} ${name} gets the request too, to give the page a command for it. Tell the operator in a few words what they are looking at.`;
export const improvisedFailedNote = (error: string) =>
  `No page command fitted this, and the voice tool's one-off action on the page failed: ${error.slice(0, 300)}. Do what the user asked, and consider giving the page a command for it (the guide is ${STAGE_GUIDE}).`;
export const pageDoneNote = (done: readonly { say: string }[]) =>
  `The voice tool already did the page part of this in the browser (${steps(done)}); don't do that again, do the rest.`;
export const pageFailedNote = (done: readonly { say: string }[], error: string, page?: { title: string; url: string }) =>
  `The voice tool tried to do this on the page${page ? ` "${page.title.slice(0, 80)}" (${page.url})` : ''} in the browser (${steps(done)}) and the page's controls failed: ${error.slice(0, 400)}. Fix the page's controller (window.fdcController or its data-fdc annotations; the guide is ${STAGE_GUIDE}) so this works, reload the page, then do what the user asked.`;
export const uncertainNote = 'Some of it may have reached you already: its delivery was uncertain. Don\'t repeat work it already started.';
// Speech the voice assistant had not passed on when the voice session ended.
export const sessionEndRequest = (reason: string, utterances: readonly Pick<Utterance, 'role' | 'text'>[], notes: readonly string[] = []) =>
  `[Voice session ended: ${reason}] Sent because the voice session ended, not because the voice assistant passed it on. This is what the user said since their previous voice request, one utterance per line; it may be unfinished or not a request at all. The user's words are in the "user:" lines; "voice assistant:" lines are context.${notesText(notes)}\n\n${transcript(utterances)}`;
