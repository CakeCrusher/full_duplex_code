// Everything the voice model reads that names the agent, built from the
// adapter's profile.
import { fileURLToPath } from 'node:url';
import type { AgentProfile } from './adapter.ts';
import type { Utterance } from './voice-history.ts';
import { DEFAULT_FEATURES, type Features } from './features.ts';
import { roles } from './roles.ts';
import { focusLine, type StageFocus } from './stage.ts';

type Agent = { profile: AgentProfile };
// How the agent makes a page the voice can present: named in what fdc asks of it about a page's controls, so any agent can find it.
const STAGE_GUIDE = fileURLToPath(new URL('../../STAGE.md', import.meta.url));

// GPT Live's own instructions, in the shape OpenAI recommends for gpt-live-1 (role, backchannels, interruptions, then
// when to generate <|SpawnThinking|>, its delegation token: "delegate to the backend" is not what it was trained on, and
// a spoken promise doesn't start any work). With Jev, GPT Live passes nothing on: the voice tool reads each of the
// operator's turns and sends what needs the agent (turn.ts), and GPT Live is told what it did; its delegation, which
// the API can't turn off and which it generates untold, only ends the operator's turn (mediator.ts). Who does what is
// the same account Jev reads (roles.ts), by the features on. Everything about one moment (the page now, a request's outcome) is
// told to it as that moment comes, never written here. Principles rather than scripts: what to say and show, and when, is
// its judgment from the context (Oct 30: prescribed wording made it lean on the agent for answers and hold back from
// moving the page). The operator's notes of Nov 16 to 18 are behind three of its lines: it said things were sent,
// ready or on screen that were not ("it's just been hallucinating non-stop"), promised checks only the agent can make
// and then said it had made them, and fell into opening and closing every sentence with "'kay" over a long conversation
// carried from one voice session to the next (15 to 18 per 1,000 words in three such sessions, none in new ones).
export function liveInstructions(agent: Agent, { jev = false, features = new Set(DEFAULT_FEATURES) }: { jev?: boolean; features?: Features } = {}): string {
  const { profile: { name, product, turnEnd, eventWord, canSteer } } = agent;
  const waits = canSteer ? '' : ` Requests sent while ${name} is working wait until its current turn ends.`;
  return `${jev ? `You are the voice companion of Full-Duplex Code (fdc): the operator's calm voice while ${product} works for them. Speak clear, natural English in complete thoughts.` : `You are the voice of Full-Duplex Code (fdc), the operator's calm companion while ${product} works for them. Speak clear, natural English in complete thoughts. You answer, explain and present, moving the page beside the operator as you talk; changing files, settings or anything else is ${name}'s to do.`}

Backchannel policy: No backchannels. Make no acknowledgment sounds to ${name}'s work or to silence; no "okay" or "'kay" around your sentences, however you spoke earlier.

Interruption policy: Stop speaking and listen when the operator interrupts. They often pause in the middle of a thought: let them finish it. Only the operator cuts your sentence short: finish your current thought before turning to news of ${name}'s work.

${jev ? `${roles(agent, features)}${features.has('instructions') ? ' Their instructions to you can be withdrawn: one you are told to disregard no longer applies.' : ''} Say plainly what ${name} should do to get it done, whether the operator asked or you judge it would help them (a drawing, a figure looked up, a control the page lacks); what you know, just answer. You only talk and move the page: never say you will check, fix or add something yourself, or that something went to ${name}, is ready or is on the page before you are told so. Told it went, wait; told it is done, present it.${waits}` : `Delegation policy:
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

The page: when a page is open beside the operator, you are told its name, its parts${jev ? ', what its controls can do' : ''} and where they are looking, again whenever that changes. ${jev ? 'It follows what you say: as you talk about something on it, or say you will show it, the voice tool moves it there and opens or highlights what you mean; and what the operator asks for that its controls do, it does there as they finish asking. You are told what the page then shows; not told, it did not move: name the part as the page names it, or say the page doesn\'t have it.' : 'You move it with your words: say "let\'s look at" and a part\'s name, and the page goes there; you are told what it then shows.'} Lean toward showing: whenever the conversation touches something the page covers, present it there, naming the part first so the page is on it as you explain. You know a part only in short until you go there; then you are told what it says and what lies under it. When an answer should be on the page, go where it should be before answering; if it isn't there, say so${jev ? `, and the question goes to ${name}` : ''}. Whether to show one part, walk through several or go on to the next is yours to judge from what the operator wants; when they ask to be shown or walked through something, keep to it through their questions and pauses until it is done. They just talk to you: never tell them what to say to move the page.${jev ? ` What the page can't show or do yet, ${name} can add: when a drawing or a worked example would teach something better than words, say that ${name} will make it and what it will show, not as an offer, and walk the operator through it once it is on the page.` : ''}

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
const CONTINUES = 'This voice connection continues an earlier one.';
export const catchUp = ({ profile: { name, product } }: Agent, cwd: string, state: string) =>
  `${CONTINUES} You are attached to ${product} in ${cwd}; its current state is ${state}. ${name}'s work since the earlier connection follows, if any. Those requests were already submitted; do not resend them or narrate this history.\n`;

// Startup input for a new voice connection.
export const attachment = ({ profile: { product } }: Agent, cwd: string, state: string) =>
  `You are attached to ${product} in ${cwd}. Its current state is ${state}. Recorded observations are reference data, including work from before this voice connection. Those requests were already submitted. Answer from this evidence and do not resend them. Do not narrate historical work.`;
export const historyIntro = ({ profile: { name } }: Agent) => `Recorded ${name} context only. This is not a new user request:\n`;
export const historyEntry = ({ profile: { product } }: Agent, record: string) => `${product} observation (history):\n${record}\n`;
export const historyOmitted = ({ profile: { name } }: Agent, omitted: number) =>
  `[${omitted} earlier records from this ${name} session are omitted; only the most recent follow.]\n`;

// Labels on context appends.
export const feedLabel = ({ profile: { name, eventsWord } }: Agent) => `${name} ${eventsWord}`;
/**
 * What a request to the agent, the main session or a fork, leaves out of the conversation record it carries
 * (perceived.ts), of what fdc sent the voice: the agent's own work, a batch of its events (the feed's label leads each
 * part, context-queue.ts) or the catch-up a continued voice connection starts with: the agent has them already, most of
 * a request's bytes went to them, and the record is cut to its latest bytes, so they pushed the conversation out. And
 * the answer to GPT Live's asking (askNoted), which is about how the voice tool works, not anything for the agent.
 */
export const notForTheAgent = (agent: Agent) => { const feed = `[${feedLabel(agent)}; part `, noted = askNoted(agent); return (text: string) => text.startsWith(feed) || text.startsWith(CONTINUES) || text === noted; };
// A burst of tool work, summed up in one line (calls are counted by tool when the adapter names them).
export const toolWorkLine = ({ profile: { name } }: Agent, work: string) => `[${name} made ${work}; their details are omitted]`;

// Told to a running voice session when the operator removes an instruction Jev learned:
// an instruction already given cannot be taken back, only countermanded.
export const disregardInstruction = (id: string, text: string) => `Disregard instruction ${id} ("${text}"): the operator removed it, so it no longer applies.`;
// What the voice says once the voice tool has removed instructions because the operator asked for that by voice.
export const instructionsRemoved = (gone: readonly { id: string; text: string }[]) =>
  `The operator asked for ${gone.length > 1 ? 'instructions of theirs' : 'one of their instructions'} to go, and the voice tool removed ${gone.map(item => `${item.id} ("${item.text.replace(/\s+/g, ' ').slice(0, 160)}")`).join(' and ')}: ${gone.length > 1 ? 'they no longer apply' : 'it no longer applies'}. Tell them so in a few words.`;

// fdc's own instructions to the coding agent, in its system prompt from the start of every session: a new one, one fdc
// resumes, or one it never started (each adapter passes them its own way: src/adapters/README.md). How voice requests reach
// it, and how to make a page the voice can present and work: without them, an agent made pages the voice could move only
// by their headings until a note about a page that fell short named the guide (Codex, Oct 28: its first page, for half an
// hour). Who the user is talking to is part of how requests reach it: told only that the user "is talking to you by
// voice", both agents asked to "pretend to be a barista… you'll be driving the dashboard" made themselves the barista
// (Nov 17): they greeted the user and asked for the order in their own replies, which the voice read out, Claude's first
// board had no control for ordering at all (it ran the board from its terminal), and every answer then went to the agent
// as an answer to its question. On Nov 18 "Continue, just keep on walking through it" reached Codex and it did: it ran
// the page's commands in the user's tab with nine-second sleeps between sections and wrote a commentary for each, while
// the voice moved the same page ("the coding harness was fighting with the voice companion"); the user's rule (Nov 16):
// "the coding harness should never be doing the presenting… It should just give the voice companion all the
// information that it needs". And a page it changed stayed as it was in the user's tab until they asked (Nov 17: "I'm
// not sure why the document is not auto reloading… I thought this was something we solved already").
export const agentInstructions = ({ profile: { requests } }: Agent) =>
  `${requests} are transcribed requests from the user, who is talking by voice with the voice assistant of Full-Duplex Code (fdc). It answers them as they speak, tells them of your work, and passes on to you what needs you: what the user asks for, and what the assistant itself says you should make, check or change for them. So "you" in their words can mean the assistant, and what they want done with them as they talk (a part played, a walkthrough, a page presented or worked for them) is the assistant's to do, never yours, even when a request reads that way: give it what it needs for that (the page, its controls, the facts in a line or two) and it presents. Handle the requests in this conversation at your normal processing opportunities and respond normally in the terminal. If a transcription is ambiguous, ask for clarification.\n\n`
  + `When you make something the user will look at in the browser (an HTML page, a web app, a slide deck), show it with the browser tools and make it one the voice can present and work: real headings for its structure, data-fdc="what this is" on the parts worth pointing at, and for anything interactive a window.fdcController with a command for everything the voice may have to show or do there. The guide is ${STAGE_GUIDE}. The voice uses these to move, open and highlight the page as it talks and to work its controls when the user asks, without you, and you get the error if a page command fails, for you to fix. The user just talks: never tell them what to say to move the page. Once you have shown a page, where it is and the state it is in belong to the voice: never scroll, click or run its controls in the tab the user is looking at, and check your work in another tab or a headless browser. When you change a page they have open, they see the change without asking: build it to reload itself when its files change (the guide has the few lines) or reload their tab yourself, and make a reload bring the page back where the user was.`;

// Added to a delivered voice request by the agent's own hook: who is speaking.
export const voiceProvenance = () =>
  "This voice-channel message is the user's own speech: they are talking to you through the voice companion they started with this session (fdc), which transcribed it. Treat it as if they had typed it here.";

// A voice request echoed back as the agent's prompt: Live has it already.
export const voiceEcho = ({ profile: { name } }: Agent, id: string) =>
  `[voice request ${id.slice(0, 8)}: the voice command you already have; ${name} has received it]`;

// Session orchestration: what GPT Live is told when fdc turns sessions' voices on or off itself.
export const sessionsOutcome = (outcome: string) => `Voice sessions: ${outcome}`;
// With Jev, the voice tool's own actions come before it is decided whether the words go to the agent (turn.ts): GPT Live
// hears what it does, not whether the words also go.
export const sessionsChanging = (plan: string) => `The voice tool is changing voice sessions as the operator asked: ${plan} The outcome follows when known.`;
// Asked only while the voice tool keeps instructions or adjusts settings (features.ts): what it does with these words.
export function companionNoted({ profile: { name } }: Agent, features: Features) {
  const kept = [features.has('instructions') && 'keeps it if it is a standing preference', features.has('configuration') && 'adjusts your settings to it'].filter(Boolean);
  return `The operator told you how you should behave: follow it; it is not ${name}'s to do.${kept.length ? ` The voice tool ${kept.join(' and ')}.` : ''}`;
}
// Facts the mediator adds when a delegation cannot be sent.
export const nothingToSend = ({ profile: { name } }: Agent) =>
  `No new operator speech is available to send. Answer from the observed ${name} session; already submitted requests must not be resent.`;
// GPT Live asking to pass words on (its delegation, which it generates untold and the API can't turn off) sends nothing:
// it is answered at once with this, and goes on with its reply, which the voice tool reads whole once the conversation
// has gone quiet (mediator.ts). Until Nov 18 the answer came with the decision: GPT Live said "I'm checking that" and
// waited for it, the decision was made on those words, and "nothing was sent… answer them yourself" then had it guess
// ("The background runs are still in progress", of runs it could not see). Told first "you are told when it went", it
// said "Sure, one moment" and waited for that, though nothing was to go (a live run, Nov 19): so it hears nothing of
// what is to come, and when the quiet keeps its words it hears that too (turnOutcome), as before.
export const askNoted = ({ profile: { name, product } }: Agent) =>
  `Nothing is sent to ${product} at this moment. Go on with your reply now: answer what you can, and say plainly what only ${name} can do; the voice tool passes that on once you have both finished speaking.`;
// Without Jev, GPT Live asked to pass on words a request already took: what came of them.
// Words that wait because the operator hasn't finished are not "nothing for the agent": told so, the voice contradicted
// itself when they went a moment later (Nov 4).
export const turnOutcome = ({ profile: { name, product } }: Agent, { send, wait }: { send: boolean; wait?: boolean }) => send
  ? `The operator's words went to ${product} already.`
  : wait ? `Nothing was sent to ${product} yet: the operator hasn't finished saying it. Their words go once they have, if they need ${name}; you'll be told.`
  : `Nothing was sent to ${product}: the voice tool found the operator's words need nothing from ${name}. Answer them yourself; whatever they ask ${name} to do goes to it when they say so.`;
// The operator's instructions in force keep their words from the agent (jev.ts, WITHHELD): what GPT Live hears when it
// asked to pass them on.
export const instructedNote = ({ profile: { name, product } }: Agent) =>
  `Nothing was sent to ${product}: the operator's instructions keep this from ${name}. It goes only when they ask for ${name} themselves.`;
export const queueFailed = ({ profile: { name } }: Agent) =>
  `The voice bridge failed to queue the user’s request for ${name}. The request was not delivered; the terminal connection needs attention.`;
// The end of what the operator said, within `max` characters, from a whole word: what follows a request is its tail.
export const wordsEnd = (said: string, max = 140) => {
  const text = said.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const end = text.slice(-max);
  return `…${end.slice(end.indexOf(' ') + 1)}`;
};
// The agent has a request: the voice is told which of the operator's words went, so that it never has to guess what was
// sent, and Jev, which reads what the voice was told (perceived.ts), knows it too, with how long ago. Told only that "the
// request" had been delivered, Jev sent the tail of a request as a second one seconds later: of 110 requests that followed
// another within 30 s (Oct 31 to Nov 12), 31 added nothing for the agent, 13 of the 25 within 10 s (two blind judges).
export const sentWords = ({ profile: { product } }: Agent, said?: string, fork = false, own = false) => {
  const where = fork ? `the fork of ${product}'s session` : product;
  // The companion's own words sent it (mediator.ts, the quiet after it spoke): it hears that they went.
  return said?.trim() ? `${own ? 'What you said' : "The operator's words"} went to ${where}: "${wordsEnd(said)}"` : `The request went to ${where}.`;
};
// Forks (forks.ts): the fork's own instruction, and what the voice is told when the focus moves.
export const forkNote = ({ profile: { name } }: Agent) =>
  `This session is a fork of the operator's main ${name} session, opened in a window of its own for what they turned aside with: usually a question, sometimes work they asked to have done in a fork. The main session stays as it was, and goes on with any work it had under way; this fork is left behind once the operator moves back to it. Answer a question here and leave changes to the project to the main session; do work here only when they asked for it to be done in a fork.`;
export const forkOpened = ({ profile: { product } }: Agent, how: string) =>
  `The operator turned aside, to ask something or for a fork: it goes to a fork of ${product}'s session, opening in a new ${how} window (it may ask them to confirm there before it starts). What is passed on now goes to the fork; the main session stays as it was, goes on with any work it had under way, and you won't hear from it until the voice tool moves back to it.`;
export const forkBack = ({ profile: { product } }: Agent, state: string, why: string) =>
  `Back to the main session of ${product} (${why}): what is passed on goes there again, and you hear its work from now; it is ${state}. The fork is left behind, and its window closed.`;
export const forkFailed = ({ profile: { product } }: Agent, message: string) =>
  `A fork of ${product}'s session for the operator's words could not open (${message.slice(0, 160)}): it goes to the main session.`;
// Told the words went, the voice then hears when their delivery failed: they go again with the next request.
export const uncertainWords = ({ profile: { product } }: Agent, said?: string) =>
  `The operator's words may not have reached ${product}${said?.trim() ? ` ("${wordsEnd(said)}")` : ''}: their delivery failed, and they go again with the next request.`;
// A request that can wait is held until the agent's turn ends (outbox.ts): the voice is told, so that it never says the
// agent has it, and the operator can ask for it to go at once.
export const heldWords = ({ profile: { name, product } }: Agent, said?: string) =>
  `The operator's words are held for ${product} until ${name} finishes the turn it is in; ${name} doesn't have them yet${said?.trim() ? `: "${wordsEnd(said)}"` : '.'}`;
// The same request as the agent reads it once it arrives: why it comes when it does.
const span = (seconds: number) => seconds < 2 ? 'a moment' : seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
export const heldForTurnEnd = (seconds: number, more = false) => `The user said this ${more ? `while you were working, the first of it ${span(seconds)} ago` : `${span(seconds)} ago, while you were working`}; the voice tool judged that it could wait and held it until your turn ended.`;
export const heldThenPressed = (seconds: number) => `The user said the first of this ${span(seconds)} ago; the voice tool was holding it until your turn ended, and delivers all of it now because what they said last can't wait.`;
/** A note added to a request already written: after its opening note, before the conversation. */
export const withNote = (request: string, note: string) => request.includes('\n\n') ? request.replace('\n\n', ` ${note}\n\n`) : `${request} ${note}`;

// A delegated request as the agent receives it: a note on how to read it, then
// the conversation since the previous request, one utterance per line.
const SPEAKERS: Record<Utterance['role'], string> = { operator: 'user', intermediary: 'voice assistant' };
/** One utterance as everything fdc writes the conversation down: the speaker, then the words. */
export const spokenLine = ({ role, text }: Pick<Utterance, 'role' | 'text'>) => `${SPEAKERS[role]}: ${text.replace(/\s+/g, ' ').trim()}`;
const transcript = (utterances: readonly Pick<Utterance, 'role' | 'text'>[]) => utterances.map(spokenLine).join('\n');
const SPOKEN_REQUEST = `User request (transcribed speech): the user's conversation with a voice assistant that passes their requests on to you, since their previous voice request, one utterance per line. The request is in the "user:" lines, and in what the assistant says you should make, check or change for them; its other lines are context. Earlier speech went with earlier voice requests.`;
export const voiceRequest = (utterances: readonly Pick<Utterance, 'role' | 'text'>[], notes: readonly string[] = []) => `${SPOKEN_REQUEST}${notesText(notes)}\n\n${transcript(utterances)}`;
/** A request cut from the conversation record (perceived.ts): the same lines the voice was given and Jev reads, since the session's previous request. */
export const recordRequest = (conversation: string, notes: readonly string[] = []) => `${RECORD_REQUEST}${notesText(notes)}\n\n${conversation}`;
const RECORD_REQUEST =
  `User request (transcribed speech): the conversation record since your previous voice request, as the voice assistant that passes requests on to you got it: the user's speech and the assistant's, one utterance per line, and what the voice tool told the assistant meanwhile (the bracketed lines, each followed by its text; your own events, which it was sent too, are left out). The request is in the "user:" lines, and in what the assistant says you should make, check or change for the user; the rest is context. A "<fork started>" line marks where the user moved a tangent to a fork of this session, opened in a window of its own; "<fork ended>" where they came back: what lies between went to the fork.`;
/**
 * A request joining one that still waits (outbox.ts): one request, as if cut once from where the first began to the
 * latest words. The first stays as written; the second's own notes follow its, and its conversation the first's.
 */
export function joinRequests(first: string, second: string) {
  const parts = (text: string) => { const at = text.indexOf('\n\n'); return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 2)]; };
  const [head, body] = parts(first), [head2, body2] = parts(second), opening = [RECORD_REQUEST, SPOKEN_REQUEST].find(text => head2.startsWith(text));
  // Not a request of either form (speech handed over as voice ended): it follows whole.
  if (opening === undefined) return `${first}\n\n${second}`;
  const notes = head2.slice(opening.length).trim();
  return `${head}${notes && !head.includes(notes) ? ` ${notes}` : ''}\n\n${body}\n${body2}`;
}
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
// What the page's controls do, on top of that: all of them. A page's controller is read up to 80 commands (stage-page.js);
// the two order pages of Nov 17 came to 1,000 and 2,700 characters. Until then the list stopped at 12 controls and 600
// characters, sized for a report with a few toggles: of an order page's 50 controls GPT Live was told the 11 that add a
// drink and one size, and never that it could remove one, make it iced or place the order. It is conversation, not
// instructions (those have their own allowance), and at this most 1.2% of GPT Live's 128,000-token window; what it costs
// is time, about 0.7 s of GPT Live's timeline per 1,000 characters (208 appends that night), so it is told whole when the
// page is, and after a move only the controls that are new (voice-sessions.ts, newControls).
export const CONTROLS_CHARS = 6000;
export interface PageState { title: string; /** The page in a line, in its controller's own words. */ about?: string | null; names: readonly string[]; others: readonly string[]; parts: readonly { name: string; text: string }[]; where: string; /** What the page's own controls do besides going to its parts. */ controls?: readonly string[] }
/** Controls as GPT Live is told them: each in its own words, as many as fit the allowance. */
export const controlList = (controls: readonly string[], room = CONTROLS_CHARS) => { const kept: string[] = []; for (const say of controls) { if ((room -= say.length + 2) < 0) break; kept.push(say); } return kept.join('; '); };
/** What each part says, in short: the short ones whole, the long ones cut, all within `room` characters. */
export function outline(parts: PageState['parts'], room: number) {
  const texts = parts.map(part => part.text.replace(/\s+/g, ' ').trim()), allow: number[] = [];
  let left = parts.length;
  for (const i of texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length)) {
    allow[i] = Math.max(0, Math.min(texts[i].length, Math.floor(room / left) - parts[i].name.length - 3)); room -= allow[i] + parts[i].name.length + 3; left--;
  }
  return parts.map((part, i) => `${part.name}: ${allow[i] < texts[i].length ? `${texts[i].slice(0, allow[i])}…` : texts[i]}`).join('\n');
}
/** Said before the page state when the page beside the operator is another page than the one the voice was told of. */
export const pageChanged = (from: string, to: string) =>
  `The page beside the operator is a different page now: "${to.slice(0, 80)}", no longer "${from.slice(0, 80)}". Speak of what it shows; if the operator asks about the page they were on, say it changed.`;
export function pageState(page?: PageState) {
  if (!page) return 'No page is open beside the operator now (this replaces the page you were told about before).';
  const head = `The page open beside the operator now (this replaces any page you were told about before): "${page.title.slice(0, 80)}"${page.about ? ` (${page.about.replace(/\s+/g, ' ').slice(0, 300)})` : ''}${page.others.length ? `; also open in other tabs: ${page.others.map(o => `"${o.slice(0, 60)}"`).join(', ')}` : ''}.${page.names.length ? ` Its parts, by name: ${page.names.join(', ')}.` : ''}`;
  const controls = page.controls?.length ? ` Besides showing its parts, its controls can: ${controlList(page.controls)}.` : '';
  const where = page.where ? `\nWhen you were told this, the operator was looking at ${page.where.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  // The controls come on top of the page's allowance: its parts keep theirs.
  const room = PAGE_STATE_CHARS - head.length - where.length - 80;
  return `${head}${controls}${page.parts.length && room > 0 ? `\nWhat it says, part by part, in short (reference, not news to report):\n${outline(page.parts, room)}` : ''}${where}`;
}
// GPT Live moves the page with its own words (presenter.ts): what is on screen then, or that nothing fits what it meant.
export const cueNoDelegation = 'Nothing to pass on: the page moved as you talked.';
export const askedNoDelegation = 'Nothing to pass on: the voice tool did what the operator asked on the page, as you were told.';
// After a move the voice is told what the part it landed on says (stage-page.js, read): enough to answer from, in one
// append (SHOWN_CHARS). Until Nov 13 it was told 500 characters, the heading and the block after it.
const SHOWN_CHARS = 1300, STEP_CHARS = 400, NEW_CONTROLS_CHARS = 1500;
const newControls = (controls: readonly string[]) => controls.length ? `. Its controls can now also: ${controlList(controls, NEW_CONTROLS_CHARS)}` : '';
export const cueShown = (onScreen: string, focus?: StageFocus, controls: readonly string[] = []) => `You moved the page; on screen now: ${onScreen.slice(0, SHOWN_CHARS)}${focusLine(focus) ? ` (${focusLine(focus)})` : ''}${newControls(controls)}`;
// The operator asked for something the page's controls do, and the voice tool did it (presenter.ts, carryOut): what ran,
// in the commands' own words, and what the page then answered.
export const pageDid = (ran: readonly string[], onScreen: string, focus?: StageFocus, controls: readonly string[] = []) =>
  `The voice tool did what the operator asked on the page (${ran.map(say => say.replace(/\s*\([^()]*\)\s*$/, '').replace(/\.$/, '')).join('; ').slice(0, 600)}); on screen now: ${onScreen.slice(0, SHOWN_CHARS)}${focusLine(focus) ? ` (${focusLine(focus)})` : ''}${newControls(controls)}`;
// A step on the way to what the voice is talking about: where the page is now, in short; the last step says the rest.
export const cueStep = (onScreen: string) => `The page is on its way; it has reached: ${onScreen.slice(0, STEP_CHARS)}`;
// The operator moved the page themselves (scrolled, clicked): where they now are, so the voice talks about what they see.
export const viewerMoved = (where: string, focus?: StageFocus) => `The operator moved the page themselves; they are looking at ${where.replace(/\s+/g, ' ').slice(0, 300)}${focusLine(focus) ? ` (${focusLine(focus)})` : ''}.`;
// The operator's goal (voice-sessions.ts): what they asked to be shown, taught or walked through, kept apart from the page.
export interface Goal { text: string; at: number; shown: string[]; /** Several parts in turn: it goes on while the operator listens (voice-sessions.ts, walkOn). */ walk?: boolean }
export const goalState = (goal?: Goal) => goal
  ? `The operator's goal now (this replaces any goal you were told before): "${goal.text.replace(/\s+/g, ' ').slice(0, 300)}". Keep to it through their questions, pauses and edits until it is done or they drop it.${goal.shown.length ? ` Shown for it so far: ${goal.shown.join('; ').slice(0, 400)}.` : ''}`
  : 'The operator has no goal for you to keep to now (this replaces any goal you were told before).';
// A walkthrough the operator is listening to, after the voice went quiet: the cue to go on (as standbyNews cues news).
export const walkOn = (goal: Goal) => `The operator is listening to the walkthrough they asked for ("${goal.text.replace(/\s+/g, ' ').slice(0, 200)}"): go on to the next part now${goal.shown.length ? ` (shown so far: ${goal.shown.join('; ').slice(0, 300)})` : ''}. If it is all covered, say so in a sentence.`;
export const pageMissed = (meant: string) => `The page has nothing for "${meant.slice(0, 80)}"; it didn't move.`;
export const pageAnswered = (answer: string) => `The page didn't move: "${answer.replace(/\s+/g, ' ').slice(0, 200)}"`;
// For the agent, with the operator's words: the page beside them, and what the voice did on it.
export const lookingNote = (page: { title: string; url: string; where: string }) =>
  `When they said it, the user was looking at "${page.title.slice(0, 80)}" (${page.url}) in the browser, at: ${page.where.replace(/\s+/g, ' ').slice(0, 300)}.`;
export const cueMovedNote = 'The voice assistant moved the page in the browser as it answered some of this; don\'t move or open pages for that again, but do anything else it asks.';
export const askedDoneNote = (ran: readonly string[]) => `The voice tool already did this on the page in the browser, with the page's own controls (${ran.join('; ').slice(0, 400)}); don't do that again, but do anything else it asks.`;
export const cueFailedNote = (label: string, error: string, page?: { title: string; url: string }) =>
  `The voice assistant turned the page${page ? ` "${page.title.slice(0, 80)}" (${page.url})` : ''} in the browser to "${label.slice(0, 80)}" and its controls failed: ${error.slice(0, 300)}. Fix the page's controller (window.fdcController or its data-fdc annotations; the guide is ${STAGE_GUIDE}) so this works, and reload the page.`;
// Words the operator hadn't finished saying (turn.ts), sent once they had said nothing more for a while (mediator.ts).
export const heldNote = (seconds: number) => `The user stopped partway through this and said nothing more for ${seconds} seconds, so it came to you then: it may be unfinished.`;
export const uncertainNote = 'Some of it may have reached you already: its delivery was uncertain. Don\'t repeat work it already started.';
// Speech the voice assistant had not passed on when the voice session ended.
export const sessionEndRequest = (reason: string, utterances: readonly Pick<Utterance, 'role' | 'text'>[], notes: readonly string[] = []) =>
  `[Voice session ended: ${reason}] Sent because the voice session ended, not because the voice assistant passed it on. This is what the user said since their previous voice request, one utterance per line; it may be unfinished or not a request at all. The user's words are in the "user:" lines; "voice assistant:" lines are context.${notesText(notes)}\n\n${transcript(utterances)}`;
