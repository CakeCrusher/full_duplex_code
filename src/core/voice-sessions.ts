import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import { requestIds, type OutboxEntry } from './outbox.ts';
import type { Page } from './pages.ts';
import { LiveSession, type CloseResult } from './live-session.ts';
import { Mediator } from './mediator.ts';
import { pageTurn, quietTurn, voiceTurn } from './turn.ts';
import { AudioAudit } from './audio-audit.ts';
import { recentHistory } from './recent-history.ts';
import { forkable, planFor, ResumeStore, seedInput, wakePlanFor, WAKE_FORK_BACKOFF_MS, type ResumePlan, type ResumeRecord, type SavedInstruction } from './voice-resume.ts';
import { notForTheAgent, pageChanged, attachment, catchUp, disregardInstruction, goalState, greeting, heldWords, historyIntro, liveInstructions, pageState, reconnectGreeting, resumeGreeting, sentWords, standbyNews, standbyWake, uncertainWords, viewerMoved, walkOn } from './prompts.ts';
import { focusLine, placeOf, Stage, type StageCommand, type StageHere, type StageView } from './stage.ts';
import type { LearnedInstruction } from './instruction-learner.ts';
import { Activity, LIVE_SPEECH_RMS, priceFor } from './activity.ts';
import { operatorVoice, type MicrophoneLevel } from './floor.ts';
import { beginPerceived, perceive, perceivedText, type PerceivedEntry, type SentKind } from './perceived.ts';
import { HISTORY_BYTES } from './jev.ts';

export interface Instruction { id: string; text: string; state: string; sessionId?: string; acknowledgedAt?: number; error?: string; appended?: boolean; /** Set for an instruction Jev learned: its short ID, such as I3, and the agent session it was learned in. */ learned?: string; learnedIn?: string }
/** The latest voice session's span and GPT Live's usage reports, for the page's meters. */
export interface LiveUsage { voiceSessionId: string; startedAt: number; endedAt?: number; seconds: number; ratio: number | null; points: [at: number, ratio: number][] }
/** Why the watchdog ends voice when GPT Live stops hearing audio the page still sends. */
export const MEDIA_STALLED = "GPT Live's audio stream stopped";
// Automatic reconnects allowed per window, so a failing connection can't loop or run up cost;
// and how long a dropped session's unsent speech waits for the reconnect before going to the agent.
const RECONNECTS = 2, RECONNECT_WINDOW_MS = 5 * 60 * 1000, CARRY_MS = 30000;
// After GPT Live starts, its media gets this long to deliver the first audio; after that, audio may pause 5 s.
const FIRST_AUDIO_MS = 15000, AUDIO_GAP_MS = 5000;
/** Why a voice session ends when the conversation goes quiet: voice stays on, on Standby. */
export const STANDBY = 'Standby: the conversation was quiet';
// A page asked to wake voice is asked again, then Standby ends: voice can't be left neither on nor off.
const WAKE_AGAIN_MS = 10000, WAKE_GIVE_UP_MS = 30000;
// A stretch of the operator's voice on Standby: the page reports a level about every tenth of a second, and a pause up to
// this long belongs to the stretch (a voice is heard in about 70% of the windows of someone talking, so shorter gaps are
// everywhere inside speech; at 0.3 s, 2 s of talking rarely counted as one stretch on their recordings, at 0.8 s twice as
// many wakes for nothing came back).
const LEVEL_MS = 100, WAKE_PAUSE_MS = 500;
// When the voice companion has had its say (readQuiet): this long after GPT Live stopped speaking, or after the operator did if it gave no answer.
const QUIET_ANSWERED_MS = 2000, QUIET_UNANSWERED_MS = 6000;
// GPT Live bills each session it connects at least this long (USAGE.md): Standby sooner saves nothing, and its wake would be billed again.
const BILLED_AT_LEAST_MS = 15000;
/** A page's address without its query or fragment: a reload that busts the cache is the same page. */
const address = (url: string) => url.replace(/[?#].*$/, '');
/** What GPT Live was told when no page is on the stage. */
const NO_PAGE = '[]';
/** The page's own commands, each as GPT Live is told it: by its name when it has one (told with the page's parts), else by what it does; no plain next or back. */
const ownOf = (view: StageView) => view.commands.filter(c => (c.id.startsWith('page_') || c.part) && !/(^|_)(next|previous|prev|back|forward)(_|$)/.test(c.id))
  .map(c => ({ named: Boolean(c.name), told: c.name ?? c.say.replace(/\s*\([^()]*\)\s*$/, '').replace(/\.$/, '') }));
/** What the page's own controls do besides going to its named parts. */
const controlsOf = (view: StageView) => ownOf(view).filter(c => !c.named).map(c => c.told);
// A page's text changes a little as it is used (a deck's "12 / 30" counter): up to this many characters, it's the same page.
const PAGE_CHANGED_CHARS = 8;
/** How many characters differ between two texts, from their first difference to their last. */
export function changedChars(a: string, b: string) {
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length, b.length) - start - end;
}
/** The page a signature (pageFor's) was told of: its address and title. */
export function toldPage(signature: string | undefined) {
  try { const [where, , , state] = JSON.parse(signature ?? ''); return typeof where === 'string' ? { address: where, title: /"([^"]*)"/.exec(String(state))?.[1] ?? where } : undefined; }
  catch { return undefined; }
}
/** Whether GPT Live was told this page state already (pageFor's signatures): the same pages and parts, and nearly the same text. */
export function sameStage(told: string | undefined, now: string) {
  if (told === now) return true;
  try { const [a, b] = [JSON.parse(told ?? ''), JSON.parse(now)]; return a.length === 4 && b.length === 4 && JSON.stringify(a.slice(0, 3)) === JSON.stringify(b.slice(0, 3)) && changedChars(a[3], b[3]) <= PAGE_CHANGED_CHARS; }
  catch { return false; }
}
// GPT Live's context falls this much between two reports only when it trims it, past 90%, to its first instructions and
// the latest conversation: in every run up to Oct 21, all 88 such falls were from .89-.94 to .07-.15, and no other fall
// between two reports was more than .07.
const TRIMMED = .5;
const emptyRecord = (): ResumeRecord => ({ stored: false, finalized: false, turns: [] });
const saved = ({ id, text, learned, learnedIn }: Instruction | SavedInstruction): SavedInstruction => ({ id, text, ...learned ? { learned, learnedIn } : {} });

/** One voice session from its start: how it began, and the record of the agent session it belongs to. */
interface Run {
  live: LiveSession; plan: ResumePlan; page?: Page; automatic: boolean; mediator: Mediator;
  record: ResumeRecord; recordId?: string;
  /** The page state GPT Live was last told (pageFor's signature), and the controls of the page it has been told of (newControls). */
  briefed?: string; controls?: Set<string>;
  /** How full GPT Live's context is (its last report). */
  context?: number;
  /** The instructions it started with, those a fork inherited from its source, and those in force in it now (given and not countermanded). */
  startup: Instruction[]; inherited: SavedInstruction[]; inForce: Map<string, SavedInstruction>;
  /** When voice was asked to start and how (and why a wake didn't fork), for its startup times; and whether it has spoken yet. */
  requested: { at: number; plan: ResumePlan; seeded?: string }; spoke?: boolean;
  /** Set when it woke from Standby: when Standby began, and whether the operator was speaking. */
  wake?: Wake;
  /** What GPT Live perceives at its start (its startup input; nothing new for a fork), recorded once it starts (perceived.ts). */
  perceivedInput: PerceivedEntry[]; perceiving?: boolean;
  /** Where on the page GPT Live was last told the operator is; when the viewer last moved it themselves, as last seen; the watch on it (watchViewer). */
  toldWhere?: string; viewerSeen?: number; viewerTimer?: NodeJS.Timeout; watching?: boolean;
  /** When GPT Live was last told to go on with a walkthrough (walkOn). */
  walkedOnAt?: number;
}
/** How often, while voice is on, fdc reads where the operator is on the page (watchViewer). */
export const VIEWER_MS = 2500;
/** How long both sides are quiet in a walkthrough before GPT Live is told to go on (walkOn). */
export const WALK_QUIET_MS = 6000;
interface Wake { since: number; operator: boolean; reason: string }
/**
 * Voice on Standby: GPT Live is disconnected while the conversation is quiet, and the page that ran
 * voice keeps its microphone open on the operator's computer, so speech or agent news can wake it.
 */
interface Standby { since: number; page: Page; waking?: Wake & { at: number; asked: number } }

// Voice connections one after another beside the same agent session: startup
// instructions and history, added instructions, the spoken confirmation of
// delivered requests, and resuming the conversation, by choice or after a drop.
export class VoiceSessions {
  bridge: Harness;
  live?: LiveSession;
  mediator?: Mediator;
  /** The current voice session, from its start. */
  run?: Run;
  /**
   * The running voice session's audio audit, and the one before it. A session's audit stays open through the Standby
   * that follows it: the page goes on recording the microphone there (audio-worklet.ts), up to the moment the next
   * session's own audit takes over on the page.
   */
  audit: AudioAudit | null = null; pastAudit: AudioAudit | null = null;
  additionalInstructions: Instruction[] = [];
  /** Every instruction appended to each session, in order, countermands included: nothing appended can be taken out. */
  appendedTo = new WeakMap<LiveSession, string[]>();
  appended(live: LiveSession, text: string) { this.appendedTo.set(live, [...this.appendedTo.get(live) ?? [], text]); }
  usage?: LiveUsage;
  /** When GPT Live last echoed microphone audio (or the page sent it, over WebSocket), and when the page last reported microphone levels. */
  lastAudioAt = 0; pageAudioAt = 0;
  audioWatchdog?: NodeJS.Timeout;
  /** The page the current voice session belongs to: its events go there, and its microphone is the one heard. */
  page?: Page;
  /** Sessions that ended because another page started voice, and one being ended now. */
  moved = new WeakSet<LiveSession>(); moving = false;
  /** Sessions GPT Live started; one that never did is retried or reported by start(), with how it ended. */
  started = new WeakSet<LiveSession>(); failed?: CloseResult;
  /** Opens each voice connection; tests replace it. */
  createLive = (options: ConstructorParameters<typeof LiveSession>[0]) => new LiveSession(options);
  /** How many instructions Jev has learned for this agent session, for their IDs. */
  learnedCount = 0;
  /** The instructions Jev learned that this run knows of, oldest first, with when each was added (unknown for one restored after a restart of fdc) and removed: the page lists them (status.ts). */
  learnedHistory: { id: string; text: string; at?: number; removed?: number }[] = [];
  /** Whether voice sessions ask OpenAI to store them for forking: off with --no-store, or once OpenAI refuses. */
  store: boolean;
  resumeStore: ResumeStore;
  /** The agent session's conversation and last voice session, for Resume voice; and the agent session it belongs to. */
  record = emptyRecord(); recordFor?: string;
  /** Automatic reconnects in the last window, and the last voice session that ended without being asked to. */
  reconnects: number[] = []; lastDrop?: { reason: string; at: number; reconnecting: boolean };
  /** Speech a dropped, moved or paused session had not passed on, kept for the session that replaces it. */
  carried?: { mediator: Mediator; reason: string; timer?: NodeJS.Timeout };
  /** Which connection sent each request still awaiting delivery, to tell it the outcome. */
  senders = new Map<string, Mediator>();
  /** Voice on Standby, and what is happening in the conversation, priced (activity.ts); and when a wake's fork last failed. */
  standby?: Standby; activity = new Activity(); standbyTimer: NodeJS.Timeout; wakeForkFailedAt = -Infinity;
  /** The quiet Jev has read (when either side last spoke before it): one reading for each (readQuiet). */
  quietRead = -Infinity;
  constructor(bridge: Harness, { store = true, resumeDir = path.join(bridge.root, '.runs', 'voice-resume') }: { store?: boolean; resumeDir?: string } = {}) {
    this.bridge = bridge; this.store = store; this.resumeStore = new ResumeStore(resumeDir);
    this.standbyTimer = setInterval(() => this.checkStandby(), 1000); this.standbyTimer.unref();
  }
  /** Whether this page's microphone is the one voice listens to: the page running voice, or the one on Standby. */
  listensTo(page: Page) { return page === this.page || page === this.standby?.page; }
  /** When the microphone last heard the operator's voice, and when GPT Live's audio last played. */
  voiceAt = -Infinity; liveSpeechAt = 0;
  /** When either side last spoke, and how long the quiet before that lasted (Standby comes sooner after a long one); whether the last to speak was GPT Live. */
  spokeAt = -Infinity; lastQuietMs = 0; liveSpokeLast = false;
  /**
   * The listening page's microphone and speaker levels (about 0.1 s each), priced: the operator's voice and GPT Live's.
   * A voice holds for more than a moment: a knock rings through one window, a word through several. On the operator's
   * recordings of Oct 19, a voice was heard in 70% of loud windows; on chewing, typing and knocks, nothing woke Standby.
   */
  heard(level: MicrophoneLevel & { outputRms?: number }) {
    const voice = operatorVoice(level), held = voice && level.at - this.voiceAt < 250;
    if (voice) this.voiceAt = level.at;
    // Live, their voice keeps voice Live through the currency, and so do their held words still going in after a wake
    // (the microphone is silent then, and they are being heard). On Standby it wakes voice by lasting (lasting()).
    if (this.standby && !this.standby.waking) this.lasting(level.at, voice);
    else if (held || level.backlogMs! > 0) this.activity.add('operator');
    // On Standby GPT Live is disconnected: its audio still playing is the closed session's last words, which once woke it
    // again within a second (Oct 21, twice), for a new session billed at least 15 s.
    const live = (level.outputRms ?? 0) >= LIVE_SPEECH_RMS && !this.standby;
    if (live) { this.activity.add('live'); this.liveSpeechAt = level.at; }
    if (held || live) { const now = Date.now(); if (now - this.spokeAt > 1500 && Number.isFinite(this.spokeAt)) this.lastQuietMs = now - this.spokeAt; this.spokeAt = now; this.liveSpokeLast = live && !held; }
  }
  /**
   * On Standby, the operator's voice wakes voice once it has lasted wakeVoiceMs (tuning.ts), pauses of up to WAKE_PAUSE_MS
   * inside it: on their recorded sessions, a third of a second of voice anywhere in the window (the rule until Nov 17)
   * woke it for a video playing, other people and noise in one wake out of five. How far the stretch under way has got
   * (0 to 1) goes to the listening page with every level, which lets them hear it rise (web/cues.ts); a stretch that
   * breaks falls back to nothing. Only what they say after Standby began counts: their goodbye doesn't.
   */
  stretch?: { from: number; at: number }; rose = 0;
  lasting(at: number, voice: boolean) {
    const standby = this.standby!, bridge = this.bridge;
    if (at < standby.since) return;
    if (this.stretch && at - this.stretch.at > WAKE_PAUSE_MS) this.stretch = undefined;
    if (voice) this.stretch = { from: this.stretch?.from ?? at - LEVEL_MS, at };
    const rose = this.stretch ? Math.min(1, (this.stretch.at - this.stretch.from) / bridge.tuning.wakeVoiceMs) : 0;
    if (rose !== this.rose) bridge.publish({ type: 'wake_rising', value: this.rose = rose }, standby.page);
    // The paused session has to finish closing first; and with Standby turned off, checkStandby wakes it anyway.
    if (rose < 1 || (this.live && this.live.state !== 'closed') || !bridge.tuning.standbyAfterMs) return;
    // What woke it counts from here on as it would have Live: the voice that wakes it keeps it Live.
    for (let spoken = this.stretch!.from + LEVEL_MS; spoken <= at; spoken += LEVEL_MS) this.activity.add('operator', spoken);
    this.stretch = undefined; this.rose = 0;
    this.wake('operator', true);
  }
  /**
   * Every second: voice that has been quiet for the Standby window goes on Standby, and voice on
   * Standby wakes once what happened in the window is worth the threshold (tuning.ts, activity.ts).
   */
  checkStandby(now = Date.now()) {
    const bridge = this.bridge, { standbyAfterMs, wakeThreshold, standbyQuickMs, standbyQuickAfterMs } = bridge.tuning, standby = this.standby, price = priceFor(bridge.tuning);
    if (standby) {
      // A fork that kept the focus into Standby (its answer was on the way) gives it back once it has answered or gone silent (forks.ts).
      bridge.forks.quiet();
      const waking = standby.waking;
      if (waking) {
        if (now - waking.at > WAKE_GIVE_UP_MS) this.endStandby('the page did not reconnect voice');
        else if (now - waking.asked > WAKE_AGAIN_MS) this.askWake(standby);
        return;
      }
      // The paused session has to finish closing first.
      if (this.live && this.live.state !== 'closed') return;
      // Standby turned off meanwhile: voice wakes, as the setting now says.
      if (!standbyAfterMs) return this.wake('Standby was turned off', false);
      // Only what happened since Standby began wakes it: the operator's goodbye doesn't.
      if (this.activity.value(standbyAfterMs, price, now, standby.since) >= wakeThreshold) {
        const source = this.activity.latest(standbyAfterMs, price, now, standby.since)?.source ?? 'activity';
        this.wake(source, source === 'operator');
      }
      return;
    }
    const live = this.live, run = this.run, page = this.page;
    if (!standbyAfterMs || bridge.stopping || this.moving || !live || live.state !== 'active' || run?.live !== live || !page || page.ws.readyState !== WebSocket.OPEN) return;
    // A request on its way to the agent keeps voice Live until the agent has it.
    if ([...bridge.outbox.values()].some(entry => entry.state === 'queued' || entry.state === 'dispatching')) return;
    // Quiet once the voice companion has had its say: Jev reads whether a meaningful exchange is about to begin, and if
    // it is sure enough that none is, voice goes on Standby now. Otherwise, as without Jev, the quiet window decides.
    this.readQuiet(now, live, page);
    // After a long quiet the next is usually long too: Standby comes sooner (tuning.ts, standbyQuickMs).
    const quick = standbyQuickMs > 0 && standbyQuickMs < standbyAfterMs && this.lastQuietMs >= standbyQuickAfterMs, windowMs = quick ? standbyQuickMs : standbyAfterMs;
    // A voice session gets the whole window before it can go quiet.
    if (now - (live.startedAt ?? now) < windowMs || this.activity.value(windowMs, price, now) >= wakeThreshold) return;
    this.toStandby(live, page, { afterMs: windowMs, threshold: wakeThreshold, value: this.activity.value(windowMs, price, now), ...quick && { quick: true, previousQuietMs: this.lastQuietMs } });
  }
  /** Voice goes on Standby: GPT Live disconnects, the page keeps listening. */
  toStandby(live: LiveSession, page: Page, how: Record<string, unknown>) {
    const bridge = this.bridge;
    // A fork that has answered doesn't keep the focus through the quiet: the main session's news is what wakes the voice (forks.ts).
    bridge.forks.quiet();
    this.standby = { since: Date.now(), page }; this.stretch = undefined; this.rose = 0;
    bridge.log({ type: 'voice.standby', liveRun: live.reservation, ...how });
    bridge.publish({ type: 'standby', state: 'on' });
    void live.close(STANDBY);
  }
  /**
   * Standby on Jev's word (jev.ts, QUIET), the operator's rule of Nov 14: the decision waits until the voice companion
   * has had its say, 2 s after GPT Live stopped speaking, or 6 s after the operator did if it gave no answer. Jev then
   * reads the conversation once for this quiet. Sure enough that no meaningful exchange is about to begin (the setting
   * standbyFrom, tuning.ts; 1 never asks), and nobody having spoken meanwhile, voice goes on Standby at once: a request
   * to go quiet or sleep, work handed off for a while, an operator who has drifted off. Otherwise the window decides.
   * Not in a session's first 15 s, which are billed whatever happens: a quiet that outlasts them is read then.
   */
  readQuiet(now: number, live: LiveSession, page: Page) {
    const bridge = this.bridge, mediator = this.mediator, at = this.spokeAt;
    if (!bridge.jev || bridge.tuning.standbyFrom >= 1 || !mediator || at === this.quietRead || at < (live.startedAt ?? Infinity) || now - live.startedAt! < BILLED_AT_LEAST_MS) return;
    // A turn still being decided may send a request yet: the reading waits for it.
    if (now - at < (this.liveSpokeLast ? QUIET_ANSWERED_MS : QUIET_UNANSWERED_MS) || mediator.pending) return;
    this.quietRead = at;
    bridge.read({ trigger: 'quiet', spoken: mediator.history.spoken(Infinity, undefined, true), unanswered: !this.liveSpokeLast }).then(reading => {
      const sure = (reading.standby ?? 0) >= bridge.tuning.standbyFrom;
      // Still the same quiet, and nothing on its way to the agent: someone speaking while Jev read keeps voice on.
      const still = this.spokeAt === at && this.live === live && live.state === 'active' && !this.standby && !bridge.stopping && !this.moving && page.ws.readyState === WebSocket.OPEN
        && !mediator.pending && ![...bridge.outbox.values()].some(entry => entry.state === 'queued' || entry.state === 'dispatching');
      bridge.jevAudit?.decided(reading.id, { standby: sure && still, ...sure && !still && { overtaken: true } }, true);
      if (sure && still) this.toStandby(live, page, { jev: reading.standby, from: bridge.tuning.standbyFrom, quietMs: Date.now() - at });
    }, error => bridge.log({ type: 'jev.error', message: (error as Error).message }));
  }
  /** Asks the page on Standby to reconnect voice. */
  wake(reason: string, operator: boolean) {
    const standby = this.standby;
    if (!standby || standby.waking) return;
    standby.waking = { since: standby.since, operator, reason, at: Date.now(), asked: 0 };
    this.bridge.log({ type: 'voice.waking', reason, standbyMs: Date.now() - standby.since });
    this.askWake(standby);
    this.bridge.publish(this.bridge.status());
  }
  askWake(standby: Standby) { standby.waking!.asked = Date.now(); this.bridge.publish({ type: 'voice_wake', reason: standby.waking!.reason }, standby.page); }
  /** Voice goes off from Standby: the speech it had not passed on goes to the agent, as when voice ends. */
  endStandby(reason: string, { moved = false } = {}) {
    const standby = this.standby;
    if (!standby) return;
    this.standby = undefined;
    const { log, publish } = this.bridge;
    log({ type: 'voice.standby_ended', reason, standbyMs: Date.now() - standby.since });
    // The speech goes to the agent with why voice ended, not why it paused.
    if (this.carried) this.carried.reason = reason;
    if (!moved) this.handOffCarried();
    publish({ type: 'standby', state: 'off', reason });
    publish({ type: 'voice_closed', reason, standbyEnded: true, moved: moved || undefined, reserved: false, finalized: true, usageSeconds: 0 }, standby.page);
    publish(this.bridge.status());
  }
  /** fdc's own instructions for the voice (or others), as a short hash: which ones a session started with. */
  prompt(text = liveInstructions(this.bridge.agent, { jev: Boolean(this.bridge.jev), features: this.bridge.features })) { return createHash('sha1').update(text).digest('hex').slice(0, 12); }
  instructions() {
    const additional = this.additionalInstructions.map(item => item.text).join('\n\n');
    return liveInstructions(this.bridge.agent, { jev: Boolean(this.bridge.jev), features: this.bridge.features }) + (additional ? `\n\nAdditional operator instructions:\n${additional}` : '');
  }
  /** An instruction Jev learned from the operator: it joins this companion's instructions at once, under an ID the operator can remove it by. */
  /** The instructions Jev learned that are the companion's now: each by its ID, without the ID its text begins with. */
  learnedInForce() { return this.additionalInstructions.filter(item => item.learned).map(item => ({ id: item.learned!, text: item.text.replace(`${item.learned}: `, '') })); }
  async learn({ text, ...judged }: LearnedInstruction) {
    const id = `I${++this.learnedCount}`;
    this.bridge.log({ type: 'instruction.learned', id, text, ...judged });
    // Its ID, once it is the companion's (in force, or waiting for the next connection); nothing when it could not be added (too long, or the companion's instructions are full).
    return this.appendInstruction(`${id}: ${text}`, { id, text, scope: judged.scope }).then(() => id, error => { this.bridge.log({ type: 'instruction.error', id, message: (error as Error).message }); return this.additionalInstructions.some(item => item.learned === id) ? id : undefined; });
  }
  /**
   * Removes a learned instruction: later sessions leave it out, and the session it is in
   * force in (the running one, or the stored one a fork continues) is told to disregard it,
   * since an instruction already given cannot be taken back.
   */
  async removeLearned(id: unknown) {
    const index = this.additionalInstructions.findIndex(item => item.learned !== undefined && item.learned === id);
    if (index < 0) return;
    const [item] = this.additionalInstructions.splice(index, 1), run = this.run;
    this.bridge.log({ type: 'instruction.removed', id: item.learned, text: item.text });
    const listed = this.learnedHistory.findLast(entry => entry.id === item.learned && !entry.removed);
    if (listed) listed.removed = Date.now();
    this.bridge.learned.remove({ session: item.learnedIn ?? this.bridge.sessionId, id: item.learned! }); this.bridge.tuneFromInstructions();
    this.rememberInstructions();
    this.bridge.publish(this.bridge.status());
    // A session still starting, or ending, countermands it when it starts (or its fork does).
    if (run?.live.state === 'active' && run.inForce.has(item.id)) await this.disregard(run, item);
  }
  /** Tells a running session to disregard a learned instruction in force in it. */
  async disregard(run: Run, item: SavedInstruction) {
    const { live } = run;
    try {
      const text = disregardInstruction(item.learned!, item.text.replace(`${item.learned}: `, ''));
      await live.append('instructions', text);
      this.appended(live, text); run.inForce.delete(item.id); this.noteInForce(run);
      this.bridge.publish(this.bridge.status());
    } catch (error) { if (live.state === 'active') this.bridge.fault(error as Error, run.page); }
  }
  /** The saved record of the current agent session, read once its ID is known. */
  current(): ResumeRecord {
    const id = this.bridge.sessionId;
    if (id && id !== this.recordFor) {
      // Voice used before the ID was known belongs to this session.
      const unsaved = !this.recordFor && this.record.liveSessionId;
      this.recordFor = id;
      if (unsaved) this.save(); else { this.record = this.resumeStore.load(id) ?? emptyRecord(); this.restoreInstructions(); }
      // Instructions added before the ID was known belong to this session's record too.
      if (this.additionalInstructions.length) this.rememberInstructions();
    }
    return this.record;
  }
  // After fdc restarts on the same agent session, its instructions are listed (and removable)
  // again, as a fork carries them anyway, and the IDs of new learned ones continue.
  restoreInstructions() {
    this.learnedCount = Math.max(this.learnedCount, this.record.learnedCount ?? 0);
    if (this.additionalInstructions.length || !this.record.instructions?.length) return;
    this.additionalInstructions = this.record.instructions.map(item => ({ ...item, state: 'next_session' }));
    this.learnedHistory.push(...this.learnedInForce());
    this.learnedCount = Math.max(this.learnedCount, ...this.additionalInstructions.map(item => Number(item.learned?.slice(1)) || 0));
    // With Jev's tuning on, the settings fit these instructions again.
    this.bridge.tuneFromInstructions();
  }
  save(id = this.recordFor, record = this.record) {
    if (!id) return;
    try { this.resumeStore.save(id, record); }
    catch (error) { this.bridge.log({ type: 'voice.resume_save_failed', message: (error as Error).message }); }
  }
  // A voice session's record is saved under its own agent session, even if the agent moved on to another meanwhile.
  saveRun(run: Run) { this.save(run.recordId ?? (run.record === this.record ? this.recordFor : undefined), run.record); }
  rememberInstructions() { const record = this.current(); record.instructions = this.additionalInstructions.map(saved); record.learnedCount = Math.max(record.learnedCount ?? 0, this.learnedCount); this.save(); }
  /** The instructions in force in a running session, for a fork of it to inherit. */
  noteInForce(run: Run) { run.record.inForce = [...run.inForce.values()]; this.saveRun(run); }
  /** What Resume voice would do now, for the page. */
  resumeStatus() {
    const record = this.current();
    return { plan: planFor(record, 'resume', this.prompt()), fork: forkable(record), turns: record.turns.length, store: this.store };
  }
  async appendInstruction(text: unknown, learned?: { id: string; text: string; scope: string }) {
    const { clean, log, publish } = this.bridge;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Enter an instruction first.');
    text = clean(text.trim());
    if (Buffer.byteLength(text as string) > 440) throw new Error('Please shorten this instruction before appending it.');
    if (this.additionalInstructions.reduce((size, item) => size + Buffer.byteLength(item.text), 0) + Buffer.byteLength(text as string) > 16000) throw new Error('This companion already has many additional instructions. Start a new companion to add more.');
    const live = this.live;
    // The operator retries their own; one Jev learned waits for the session that is starting (connect() adds it).
    if (!learned && ['new', 'connecting', 'closing'].includes(live?.state as string)) throw new Error('Wait for the voice connection to settle, then append your instruction.');
    const active = live?.state === 'active';
    const item: Instruction = { id: randomUUID(), text: text as string, state: active ? 'pending' : 'next_session', sessionId: active ? live!.id : undefined, ...learned ? { learned: learned.id, learnedIn: this.bridge.sessionId } : {} };
    this.additionalInstructions.push(item);
    log({ type: 'voice.instruction', ...item });
    // Jev's: recorded, shown with Remove and announced the moment it is accepted.
    if (learned) { this.bridge.learned.add({ session: item.learnedIn, id: learned.id, text: learned.text, scope: learned.scope }); this.learnedHistory.push({ id: learned.id, text: learned.text, at: Date.now() }); publish({ type: 'instruction_learned', id: learned.id }); }
    publish(this.bridge.status()); this.bridge.tuneFromInstructions();
    this.rememberInstructions();
    if (!active) return item;
    await this.applyInstruction(live!, item);
    return item;
  }
  async applyInstruction(live: LiveSession, item: Instruction) {
    const { log, publish, fault, clean } = this.bridge;
    Object.assign(item, { state: 'pending', sessionId: live.id });
    try {
      await live.append('instructions', item.text);
      this.appended(live, item.text);
      if (this.live !== live || live.state !== 'active') return;
      Object.assign(item, { state: 'acknowledged', acknowledgedAt: Date.now(), appended: true });
      log({ type: 'voice.instruction_acknowledged', ...item });
      const run = this.run?.live === live ? this.run : undefined;
      if (run) { run.inForce.set(item.id, saved(item)); this.noteInForce(run); }
      // Removed while it was being added: countermanded at once.
      if (run && item.learned && !this.additionalInstructions.includes(item)) await this.disregard(run, saved(item));
    } catch (error) {
      if (this.live !== live || live.state !== 'active') return;
      Object.assign(item, { state: 'failed', error: clean((error as Error).message) });
      fault(error as Error);
    }
    publish(this.bridge.status());
  }
  /** Starts voice: Resume continues the conversation (a fork of the stored last session, else a new session seeded with its text); fresh starts without it. */
  async start(sdp?: unknown, page?: Page, mode: 'resume' | 'fresh' = 'fresh', automatic = false) {
    const bridge = this.bridge, { agent, observer, log, publish } = bridge, { name } = agent.profile;
    if (sdp !== undefined && (typeof sdp !== 'string' || !sdp.trim() || Buffer.byteLength(sdp) > 65536)) throw new Error('Invalid voice connection offer.');
    // On Standby, the page that listens wakes voice (asked, or clicked); another page takes voice over.
    let wake: Wake | undefined;
    const standby = this.standby;
    if (standby && page === standby.page) {
      standby.waking ??= { since: standby.since, operator: true, reason: 'the operator asked', at: Date.now(), asked: Date.now() };
      wake = standby.waking;
    } else if (standby) { this.endStandby('voice moved to another tab or device', { moved: true }); mode = 'resume'; }
    // A wake clicked while the paused session is still closing waits for it.
    if (wake && this.live?.state === 'closing') await this.live.closed;
    const running = this.live && this.live.state !== 'closed' ? this.live : undefined;
    if (running) {
      // Start on another page moves voice there. A repeated start, or one while
      // voice is still connecting, closing or already moving, changes nothing.
      if (!page || page === this.page || running.state !== 'active' || this.moving) return;
      log({ type: 'voice.moved', from: this.page?.id, to: page.id });
      this.moved.add(running); this.moving = true;
      try { await running.close('voice moved to another page'); } finally { this.moving = false; }
      if (this.live !== running) return;
      // The conversation moves with voice, its unsent speech included.
      mode = 'resume';
    }
    if (!bridge.agentReady) throw new Error(`Wait for the voice ${agent.profile.transport} to connect in the ${name} terminal.`);
    if (observer.state === 'exited') throw new Error(`The ${name} session has exited.`);
    const record = this.current();
    // The operator starting voice: Jev looks at the settings again (a wake or reconnect is not the operator starting it).
    if (!wake && !automatic) bridge.tuneFromInstructions();
    // A wake resumes the session it paused while fdc's own instructions are the ones it started with and its context has
    // room; otherwise it starts a new one, seeded with the conversation (wakePlanFor). A fork takes 1 to 8.5 s to start:
    // the page holds the operator's words meanwhile and plays a waking sound.
    let [plan, seeded] = wake ? wakePlanFor(record, this.prompt(), Date.now() - this.wakeForkFailedAt < WAKE_FORK_BACKOFF_MS) : [planFor(record, mode, this.prompt())];
    // Starting fresh after a drop: the speech it had not passed on goes to the agent now.
    if (plan === 'fresh' && !wake) this.handOffCarried();
    const requested = { at: Date.now(), plan, seeded };
    for (;;) {
      const attempt: { live?: LiveSession; requested: Run['requested']; wake?: Wake } = { requested, wake };
      try { return await this.connect(sdp as string | undefined, page, plan, automatic, attempt); }
      catch (error) {
        const live = attempt.live, message = (error as Error).message;
        if (!live) throw error;
        // Another start took voice over meanwhile (moved to another page): this one is done.
        if (this.live !== live) { log({ type: 'voice.start_superseded', message }); return; }
        // Ended after it started (dropped, or ended during the greeting): its close already told the page.
        if (this.started.has(live)) { log({ type: 'voice.start_interrupted', message }); return; }
        // A fork or storage OpenAI refuses falls back quietly: only a session that never started, that nobody canceled, and whose media answer the page has not applied.
        const retry = !live.answered && !live.requested && !bridge.stopping;
        if (wake && plan === 'fork' && !live.requested) this.wakeForkFailedAt = Date.now();
        if (retry && plan === 'fork') { log({ type: 'voice.fork_failed', from: record.liveSessionId, message }); plan = record.turns.length ? 'seed' : 'fresh'; continue; }
        // The page says so beside the connection facts (resume.store).
        if (retry && live.store && /\bstor(e|ed|age)\b|retention|persist/i.test(message)) { this.store = false; log({ type: 'voice.store_refused', message }); continue; }
        // A fork OpenAI answered but never started (twice in a row on Oct 13, "session startup timed out"): it isn't
        // tried again; the page starts over at once (a wake keeps the words it holds), and Resume rebuilds the conversation
        // from its text.
        if (plan === 'fork' && live.answered && !live.requested && !bridge.stopping && (record.turns.length || wake)) {
          record.forkFailed = record.liveSessionId; this.save();
          log({ type: 'voice.fork_never_started', from: record.liveSessionId, message });
          if (page?.ws.readyState === WebSocket.OPEN && (wake || this.allowReconnect())) {
            // If the page doesn't start over, the speech this connection took over goes to the agent.
            this.carryAgain();
            publish({ type: 'voice_closed', ...(this.failed ?? { reserved: false, finalized: false, usageSeconds: 0 }), reason: 'continuing the last voice session failed; rebuilding the conversation', reconnect: true, waking: wake ? true : undefined }, page);
            publish(bridge.status());
            return;
          }
        }
        // The page learns that voice did not start; speech a dropped or paused session left goes to the agent.
        if (wake && this.standby) { this.standby = undefined; log({ type: 'voice.standby_ended', reason: `waking failed: ${message}` }); publish({ type: 'standby', state: 'off', reason: message }); }
        this.handOffCarried();
        publish({ type: 'voice_closed', ...(this.failed ?? { reserved: false, finalized: false, usageSeconds: 0, reason: message }) }, page);
        publish(bridge.status());
        throw error;
      }
    }
  }
  async connect(sdp: string | undefined, page: Page | undefined, plan: ResumePlan, automatic: boolean, attempt: { live?: LiveSession; requested?: Run['requested']; wake?: Wake } = {}) {
    const bridge = this.bridge, { agent, observer, log, publish, fault, clean } = bridge, { name } = agent.profile;
    const record = this.current(), recordId = this.recordFor, sourceId = plan === 'fork' ? record.liveSessionId : undefined;
    // Waking, GPT Live is told at the start that the conversation continues, rather than by an append after it starts.
    const startup = attachment(agent, bridge.cwd, observer.state) + (attempt.wake ? `\n\n${standbyWake(agent, attempt.wake.operator)}` : '');
    // A fork already has its source's startup input and conversation; it catches up on the work GPT Live had not received.
    const since = record.deliveredThrough ?? record.endedAt ?? 0;
    // Waking from Standby, the work from before it is history; the work during it arrives as it would have live (below).
    const wake = attempt.wake;
    const observations = plan === 'fork' ? bridge.adapter.history().filter(o => o.at > since) : wake ? bridge.adapter.history().filter(o => o.at <= wake.since) : bridge.adapter.history();
    const history = recentHistory(agent, observations, Math.max(0, 7600 - Buffer.byteLength(startup)));
    // A new session starts knowing the page on the stage, last in its startup input: appended once it had started, the page
    // took GPT Live's timeline from the operator (after a wake, their first words reached it 6-25 s late, their beginning
    // lost). A fork has what its source was told, and is told what changed since by an append (brief).
    const view = plan === 'fork' ? undefined : await this.stageNow(), seen = view && this.pageFor(view);
    const message = (role: 'developer' | 'user', text: string) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
    let input = [message('developer', startup), ...history.text ? [message('user', historyIntro(agent) + history.text)] : []];
    const now = seen ? [message('developer', seen.state)] : [], opening = input.length;
    if (seen) bridge.pageAudit.told(seen.state);
    input = plan === 'seed' ? seedInput(input, record.turns, now) : [...input, ...now];
    // What GPT Live perceives at its start, for Jev: fdc's messages, and the earlier turns a seed puts between them.
    const perceivedInput: PerceivedEntry[] = plan === 'fork' ? [] : input.map((item, i) => i < opening || i >= input.length - now.length
      ? { at: 0, kind: 'start', text: item.content[0].text } : { at: 0, role: item.role === 'user' ? 'operator' : 'intermediary', text: item.content[0].text });
    const live: LiveSession = this.createLive({ apiKey: bridge.apiKey, budget: bridge.ledger, voice: bridge.voice, instructions: this.instructions(), label: `${name} ${bridge.sessionId ?? 'session'}`,
      input: plan === 'fork' ? [] : input, store: this.store, fork: sourceId, log: event => log({ liveRun: live.reservation, ...event }) });
    attempt.live = live;
    this.failed = undefined;
    this.live = live; this.page = page;
    this.mediator?.stop();
    // A fork's context already holds its source's records: numbering continues after them.
    const mediator: Mediator = this.mediator = new Mediator({ live, observer: bridge.forks.observer(), agent, deliver: task => { this.senders.set(task.id, mediator); bridge.deliver(task); }, log, publish: event => publish(event), clean,
      audit: bridge.handOffAudit, route: bridge.jev ? { page: (request, spoken, waiting) => pageTurn(bridge, request, spoken, waiting), quiet: (request, spoken, reply, since, early, waiting) => quietTurn(bridge, request, spoken, reply, bridge.presenter.ranSince(since), early, waiting),
        voice: (spoken, waiting) => voiceTurn(bridge, spoken, waiting) } : undefined,
      read: bridge.jev ? (trigger, spoken, record) => bridge.read({ trigger, spoken, ...record }) : undefined, consider: (reading, id) => bridge.consider(reading, id),
      tuning: bridge.tuning, firstRecordId: plan === 'fork' ? record.lastRecordId ?? 0 : 0, replays: Boolean(wake?.operator),
      // Requests are cut from the record Jev reads and the voice was given, from the session's own place in it.
      conversation: { text: (from, until) => perceivedText(record, mediator.history.spoken(), until, HISTORY_BYTES, from, notForTheAgent(agent)), cursor: () => bridge.forks.cursors[bridge.forks.focus],
        move: (at, back) => { const { cursors, focus } = bridge.forks; cursors[focus] = back ? Math.min(cursors[focus], at) : at; } } });
    const run: Run = this.run = { live, plan, page, automatic, mediator, record, recordId, startup: [...this.additionalInstructions], inherited: plan === 'fork' ? record.inForce ?? [] : [], inForce: new Map(), requested: attempt.requested ?? { at: Date.now(), plan }, wake, perceivedInput };
    // A fork knows the page state its source was told, and how full its context is; a new session, the page it starts with.
    Object.assign(run, plan === 'fork' ? { briefed: record.briefed, context: record.context } : { briefed: seen?.signature ?? NO_PAGE, controls: new Set(view ? ownOf(view).map(c => c.told) : []) });
    if (seen) this.bridge.presenter.speechCues.set(seen.cues);
    // A dropped or moved session's unsent speech: this session takes it if it starts; meanwhile it isn't handed off.
    // The copies are now the ones to carry or hand off: if this connection fails to start, they go on from here.
    if (this.carried) { clearTimeout(this.carried.timer); mediator.history.carry(this.carried.mediator.history); this.carried.mediator = mediator; }
    // The way back from a fork made as voice went on Standby (forks.ts): told now, and so in the record.
    if (bridge.forks.untold) mediator.context.add('thinking', bridge.forks.untold);
    // Instead of a greeting, a waking session gets the agent's work it missed as it would have live: a fork, all since its
    // source last had it; a new session (told at its start that the conversation continues), what came during Standby.
    if (wake) {
      const missed = plan === 'fork' ? since : wake.since;
      for (const observation of bridge.adapter.history().filter(o => o.at > missed)) mediator.feed.add(observation);
      // Woken by the agent's news: after it, the cue to report it if it calls for that. Woken by the operator, their words are the cue.
      if (!wake.operator) { mediator.feed.flush(); mediator.context.add('commentary', standbyNews(agent)); }
    } else if (plan === 'fork') mediator.context.add('thinking', catchUp(agent, bridge.cwd, observer.state) + (history.text ? historyIntro(agent) + history.text : ''), null, '', since);
    log({ type: 'voice.starting', plan, automatic, from: sourceId, seededTurns: plan === 'seed' ? input.length - (history.text ? 2 : 1) : undefined, store: this.store, wake: wake?.reason,
      context: plan === 'fork' ? record.context : undefined, seeded: wake && plan !== 'fork' ? attempt.requested?.seeded ?? 'its fork failed' : undefined });
    publish(bridge.status());
    // A fork that fails falls back to a new session; its errors are logged, not shown.
    live.on('fault', error => plan === 'fork' && !this.started.has(live) ? log({ type: 'voice.fork_fault', message: error.message }) : fault(error, page));
    live.on('answer', sdp => publish({ type: 'voice_answer', sdp }, page));
    live.on('sent', event => {
      const kind = /^session\.(thinking|commentary|instructions)\.append$/.exec(event.type)?.[1] as SentKind | undefined;
      if (!kind) return;
      this.perceiving(run); perceive(run.record, { at: Date.now(), kind, text: event.content });
      publish({ type: 'context_sent', id: event.event_id, kind, text: event.content, notification: event });
    });
    live.on('event', event => this.liveEvent(run, event));
    live.on('closed', result => this.closed(run, result));
    this.lastAudioAt = 0; this.pageAudioAt = 0;
    await live.start(sdp);
    this.watch(live);
    if (live.state !== 'active') return;
    // Learned instructions in force here but no longer the companion's (removed while it started, or since a fork's
    // source ended) are countermanded; the companion's instructions not yet in force are added.
    const kept = new Set(this.additionalInstructions.map(item => item.id));
    for (const item of [...run.inForce.values()]) if (item.learned && !kept.has(item.id) && live.state === 'active') await this.disregard(run, item);
    for (const item of [...this.additionalInstructions]) if (live.state === 'active' && !run.inForce.has(item.id) && !(item.state === 'pending' && item.sessionId === live.id)) await this.applyInstruction(live, item);
    if (live.state === 'active' && !wake) await live.greet(plan === 'fresh' ? greeting(agent) : automatic ? reconnectGreeting(agent) : resumeGreeting(agent));
    void this.briefStage(run);
    // The operator's goal, if they set one, carries over: a fork's source was told it already.
    if (plan !== 'fork' && this.goal && live.state === 'active') mediator.context.add('thinking', goalState(this.goal));
    this.watchViewer(run);
  }
  /**
   * The operator's goal: what they asked to be shown, taught or walked through (turn.ts, from Jev's reading of their
   * words), kept apart from the page and in the agent session's record, so it holds across Standby, resumes and restarts of
   * fdc. GPT Live is told it when it is set or ended and at each new session; Jev reads it with what was shown since.
   */
  get goal() { return this.current().goal; }
  setGoal(text: string | undefined, { walk = false }: { walk?: boolean } = {}, run = this.run) {
    const record = this.current();
    if (text) record.goal = { text: this.bridge.clean(text.replace(/\s+/g, ' ').trim()).slice(0, 300), at: Date.now(), shown: [], ...walk && { walk } };
    else if (!record.goal) return;
    else delete record.goal;
    this.save();
    this.bridge.log({ type: 'goal.set', text: record.goal?.text ?? null, ...record.goal?.walk && { walk: true } });
    if (run && run.live.state === 'active' && this.run === run) run.mediator.context.add('thinking', goalState(record.goal));
  }
  /** The goal as Jev reads it: the operator's words, how long ago, and what the page has shown since. */
  goalLine(now = Date.now()) {
    const goal = this.goal;
    if (!goal) return undefined;
    return `"${goal.text}" (asked ${Math.max(1, Math.round((now - goal.at) / 1000))} s ago); shown for it since: ${goal.shown.join('; ') || 'nothing yet'}`;
  }
  /** The page moved: where the operator now is, as GPT Live was told it, and what was shown for their goal. */
  shown(here: StageHere | undefined, done: StageCommand[]) {
    if (this.run && here?.where) this.run.toldWhere = here.where;
    const goal = this.goal, part = focusLine(here?.focus) || done.at(-1)?.name || done.at(-1)?.say.replace(/^(Go to|Show and highlight:|Highlight)\s*/i, '');
    if (!goal || !part) return;
    goal.shown = [...goal.shown.filter(p => p !== part), part].slice(-12);
    this.save();
  }
  /**
   * While voice is on, where the operator is on the page is read every few seconds (a light read: no commands or parts).
   * When they moved it themselves (scrolled, clicked) and have stopped, GPT Live hears where they now are: on Oct 31 the
   * operator scrolled to a grid themselves, and the voice went on about what they could no longer see.
   */
  watchViewer(run: Run) {
    clearInterval(run.viewerTimer);
    run.viewerTimer = setInterval(() => { void this.viewer(run); this.walkOn(run); }, VIEWER_MS);
    run.viewerTimer.unref?.();
  }
  /**
   * A walkthrough the operator asked for goes on while they listen: once both sides have been quiet for WALK_QUIET_MS,
   * GPT Live is told to go on, but only while it is carrying the walk itself, its words having moved the page since the
   * operator last spoke and since it was last told. A question, a pause or a cue that brought no move leaves it waiting
   * for the operator. On duplex.party (Oct 31) the voice presented one part and stopped: six requests for one six-step
   * walkthrough.
   */
  walkOn(run: Run, now = Date.now()) {
    const goal = this.goal, mediator = run.mediator, presented = this.bridge.presenter.presentedAt;
    if (!goal?.walk || this.run !== run || run.live.state !== 'active' || mediator.pending) return;
    // Only this connection's own presenting counts, and its quiet: a connection just woken from Standby had neither heard nor
    // said anything, which read as a long quiet, and was told to go on 2.5 s in (all nine wakes with a walkthrough, Nov 4).
    const begun = run.live.startedAt ?? now;
    if (presented <= Math.max(mediator.history.lastInputAt, run.walkedOnAt ?? 0, goal.at, begun)) return;
    if (now - mediator.history.lastInputAt < WALK_QUIET_MS || now - mediator.answerAt < WALK_QUIET_MS || now - presented < WALK_QUIET_MS) return;
    // Not while the agent is still working on what the operator asked from here: its answer comes first.
    if (this.bridge.agentWorking() !== undefined && mediator.lastSent && mediator.lastSent.at > Math.max(run.walkedOnAt ?? 0, goal.at)) return;
    run.walkedOnAt = now;
    this.bridge.log({ type: 'goal.walk_on', shown: goal.shown.length });
    mediator.context.add('commentary', walkOn(goal));
  }
  async viewer(run: Run) {
    if (this.run !== run || run.live.state !== 'active' || !this.bridge.stage.tabId || run.watching) return;
    run.watching = true;
    try {
      const here = await Promise.resolve().then(() => this.bridge.stage.here()).catch(() => undefined);
      // Moved by the viewer since last seen, and still for a moment: where they stopped.
      if (!here?.viewerAt || here.viewerAt <= (run.viewerSeen ?? 0) || Date.now() - here.viewerAt < 1200) return;
      run.viewerSeen = here.viewerAt;
      if (!here.where || here.where === run.toldWhere || run.live.state !== 'active') return;
      run.toldWhere = here.where;
      this.bridge.log({ type: 'stage.viewer_moved', where: here.where.slice(0, 160), focus: focusLine(here.focus) || undefined });
      const told = viewerMoved(here.where, here.focus), audit = this.bridge.pageAudit;
      run.mediator.context.add('thinking', told);
      audit.told(told, audit.action({ by: 'operator', tabId: this.bridge.stage.tabId, after: placeOf(here) }));
    } finally { run.watching = false; }
  }
  /**
   * GPT Live learns the page on the stage: the words that move it as it talks, and what it says, in one message that
   * replaces the last (pageState). Whenever the page, its parts or the set of open pages changes (a page rebuilt at the
   * same address included), and with `again` when GPT Live may have lost it (its context was trimmed).
   */
  async briefStage(run = this.run, attempt = 0, again = false) {
    // Whatever goes wrong here (a page's odd data, a closed session) is logged, never thrown: callers don't wait.
    try {
      // A page that can't be read yet (a new tab's blank page while the agent's code navigates it) is read again shortly.
      if (await this.brief(run, again) === false && attempt < 5) setTimeout(() => void this.briefStage(run, attempt + 1, again), 1500).unref();
    } catch (error) { this.bridge.log({ type: 'stage.error', message: (error as Error).message }); }
  }
  /** Resolves to false when the page couldn't be read. */
  async brief(run = this.run, again = false): Promise<boolean | void> {
    const live = run?.live, stage = this.bridge.stage;
    if (!run || !live || live.state !== 'active' || this.live !== live) return;
    const view = await stage.describe(0).catch(error => { this.bridge.log({ type: 'stage.error', message: (error as Error).message }); return null; });
    // Still on stage but unreadable: read again. Gone (closed, or never shown): GPT Live hears there is no page.
    if (view === null && stage.tabId) return false;
    if (live.state !== 'active') return;
    const seen = view && this.pageFor(view);
    if (seen) this.bridge.presenter.speechCues.set(seen.cues);
    // A fork was told the page by its source: the controls it knows are the page's as it stands.
    if (!again && sameStage(run.briefed, seen?.signature ?? NO_PAGE)) { run.controls ??= new Set(view ? ownOf(view).map(c => c.told) : []); return; }
    // Another page now (the agent showed one, or a link in the page led to another): said as news before what it is. Told
    // only "the page open beside the operator now", in the long text of the page, the voice said three times that it was
    // still on the same page as the operator asked "what even happened to our page", and then "prove it" (Nov 18).
    const before = toldPage(run.briefed), after = seen ? toldPage(seen.signature) : undefined;
    const changed = before && after && before.address !== after.address ? `${pageChanged(before.title, after.title)}\n` : '';
    run.briefed = seen?.signature ?? NO_PAGE;
    run.controls = new Set(view ? ownOf(view).map(c => c.told) : []);
    this.bridge.log({ type: 'stage.briefed', url: view?.url ?? null, names: seen?.cues.filter(c => c.listed).map(c => c.label) ?? [], parts: view?.parts.length ?? 0, again: again || undefined });
    run.toldWhere = view?.where;
    // Through the same queue as the agent's work: it waits while the operator talks.
    run.mediator.context.add('thinking', changed + (seen?.state ?? pageState()));
    this.bridge.pageAudit.told(changed + (seen?.state ?? pageState()));
  }
  /**
   * The page's controls GPT Live hasn't been told of yet, as the page is now: after a move it hears those the move brought
   * (a part's own, on screen now; a drink's settings, once one is chosen), not the whole list again. Told whole with the page.
   */
  newControls(view: StageView, run = this.run) {
    if (!run || !this.bridge.jev) return [];
    const told = run.controls ??= new Set<string>(), fresh = ownOf(view).map(c => c.told).filter(text => !told.has(text));
    for (const text of fresh) told.add(text);
    return fresh;
  }
  /** What GPT Live is told of the page on the stage (pageState), the words that move it (speech cues), and what it was told, to compare. */
  pageFor(view: StageView) {
    // Every part the voice can name, up to the stage script's own cap on a page's commands (80).
    const cues = Stage.cues(view), names = cues.filter(c => c.listed).map(c => c.label).slice(0, 80);
    const others = [...this.bridge.stage.pages].filter(([tabId]) => tabId !== view.tabId).map(([, page]) => page.title);
    // The page's own controls that go to no part ("show the error bars", "add a latte to the order"): with Jev, GPT Live
    // knows what the page can do for the operator, and says what it can't.
    const controls = this.bridge.jev ? controlsOf(view) : [];
    const state = pageState({ title: view.title, about: view.about, names, others, parts: view.parts, where: view.where, controls });
    // Where the operator is changes with every move, and they hear of each move: it's no change to the page.
    return { cues, state, signature: JSON.stringify([address(view.url), names, others, state.replace(/\nWhen you were told this, [^]*$/, '')]) };
  }
  /**
   * GPT Live trimmed its context: past 90% it keeps its first instructions and the latest 8,192 tokens of the conversation,
   * so what it was told in the conversation since may be gone. It is told the page again, and the operator's instructions in
   * force that its first instructions don't hold (a fork's first are its source chain's, so all of them).
   */
  retell(run: Run) {
    void this.briefStage(run, 0, true);
    if (this.goal) run.mediator.context.add('thinking', goalState(this.goal));
    const first = new Set(run.plan === 'fork' ? [] : run.startup.map(item => item.id));
    for (const item of run.inForce.values()) if (!first.has(item.id)) run.mediator.context.add('instructions', item.text);
  }
  /** The page on the stage, if it can be read quickly: a voice starting doesn't wait long for it. */
  async stageNow(): Promise<StageView | undefined> {
    if (!this.bridge.stage.tabId) return;
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000).unref());
    return Promise.race([this.bridge.stage.describe().catch(() => undefined), timeout]);
  }
  /** The audit of this voice session, if it is the one running: a session still connecting writes nothing into the one before it. */
  auditOf(live: LiveSession) { return this.audit?.sessionId === live.id ? this.audit : null; }
  /** The page's audit packets name their voice session: the running one's, or the one before it while the page still records its Standby. */
  auditFor(sessionId: unknown) { return [this.audit, this.pastAudit].find(audit => audit && audit.sessionId === sessionId) ?? null; }
  liveEvent(run: Run, event: any) {
    const { live, page } = run;
    if (event.type === 'session.output_audio.delta') {
      const pcm = Buffer.from(event.delta, 'base64');
      this.auditOf(live)?.write('output', pcm, { startMs: event.start_ms, endMs: event.end_ms });
      if (live.transport === 'webrtc') return; // The browser plays the negotiated media track.
      const browser = page?.ws;
      if (browser?.readyState !== WebSocket.OPEN) return;
      if (browser.bufferedAmount > 1024 * 1024) return live.close('Audio playback connection too slow');
      browser.send(pcm);
    }
    if (event.type === 'session.input_audio.append' && live.transport === 'webrtc') {
      this.lastAudioAt = Date.now();
      this.auditOf(live)?.write('input', Buffer.from(event.audio, 'base64'), { startMs: event.start_ms, endMs: event.end_ms });
    }
    if (/^session\.(thinking|commentary|instructions)\.appended$/.test(event.type)) this.bridge.publish({ type: 'context_ack', id: event.client_event_id, startMs: event.start_ms, endMs: event.end_ms });
    if (event.type === 'session.started') this.begun(run);
    // GPT Live's words can move the page as it says them (the operator's, once their turn ends: the mediator's).
    if (event.type === 'session.output_transcript.delta' && this.live === live) this.bridge.presenter.heard(String(event.delta ?? ''));
    if (event.type === 'session.delegation.created') this.activity.add('request');
    // ...and to the first words it says.
    if (event.type === 'session.output_transcript.delta' && !run.spoke) { run.spoke = true; this.bridge.log({ type: 'voice.first_words', plan: run.plan, automatic: run.automatic, firstWordsMs: Date.now() - run.requested.at }); }
    // Live reports usage about every 15 seconds; the last few minutes of it are enough for the meters. How full the context
    // is, for a fork of this session (wakePlanFor); a sharp fall is GPT Live trimming it (retell).
    const usage = this.usage, ratio = event.context_window?.usage_ratio;
    if (event.type === 'session.usage.updated' && Number.isFinite(ratio)) {
      if ((run.context ?? 0) - ratio >= TRIMMED) { this.bridge.log({ type: 'voice.trimmed', from: run.context, to: ratio }); this.retell(run); }
      run.context = ratio;
    }
    if (event.type === 'session.usage.updated' && usage && usage.voiceSessionId === live.id) {
      if (Number.isFinite(ratio)) { usage.ratio = ratio; usage.points = [...usage.points.slice(-39), [Date.now(), ratio]]; }
      usage.seconds = event.usage?.seconds ?? usage.seconds;
      this.bridge.publish({ type: 'live_usage', ...usage });
    }
  }
  /** What GPT Live perceives starts again with a new session (a fork continues it): at its start, before anything is appended. */
  perceiving(run: Run) { if (!run.perceiving) { run.perceiving = true; beginPerceived(run.record, run.plan, run.perceivedInput); } }
  begun(run: Run) {
    const { live, plan, page, automatic, record } = run, bridge = this.bridge, { log, publish, fault } = bridge;
    this.started.add(live); this.perceiving(run);
    // The replacement took over a dropped session's unsent speech.
    if (this.carried) { clearTimeout(this.carried.timer); this.carried = undefined; }
    // In force from the start: everything in a new session's startup prompt (one removed while it started is
    // countermanded right after), or what a fork inherited.
    run.inForce = new Map((plan === 'fork' ? run.inherited : run.startup.map(saved)).map(item => [item.id, item]));
    for (const item of this.additionalInstructions) if (run.inForce.has(item.id)) Object.assign(item, { state: 'acknowledged', sessionId: live.id, acknowledgedAt: Date.now(), error: undefined, appended: false });
    if (plan === 'fresh') record.turns = [];
    Object.assign(record, { liveSessionId: live.id, stored: live.stored, finalized: false, endedAt: undefined, deliveredThrough: undefined });
    // A fork started with its source's instructions; anything else with today's.
    if (plan !== 'fork') record.prompt = this.prompt();
    this.noteInForce(run);
    this.pastAudit?.close(); this.pastAudit = this.audit;
    this.audit = new AudioAudit({ dir: path.join(bridge.runDir, 'audio', live.reservation!), sessionId: live.id, log: event => log({ liveRun: live.reservation, ...event }), onError: error => fault(error) });
    this.usage = { voiceSessionId: live.id!, startedAt: live.startedAt ?? Date.now(), seconds: 0, ratio: null, points: [] };
    publish({ type: 'live_usage', ...this.usage });
    bridge.forks.untold = undefined;
    // Startup times: from the click (or reconnect, or wake) to GPT Live's session starting, fallbacks included.
    log({ type: 'voice.started', plan, requestedPlan: run.requested.plan, automatic, startMs: Date.now() - run.requested.at, wake: run.wake?.reason });
    if (run.wake && this.standby) { log({ type: 'voice.woke', reason: run.wake.reason, standbyMs: Date.now() - this.standby.since }); this.standby = undefined; publish({ type: 'standby', state: 'off', reason: run.wake.reason }); }
    publish({ type: 'voice_started', sessionId: live.id, plan, automatic }, page);
    publish(bridge.status());
  }
  closed(run: Run, result: CloseResult) {
    const { live, page, mediator, record } = run, bridge = this.bridge, { log, publish } = bridge;
    clearInterval(run.viewerTimer);
    if (this.live === live) clearInterval(this.audioWatchdog);
    const own = this.mediator === mediator ? mediator : undefined;
    // One that never started is reported, or replaced, by start().
    if (!this.started.has(live)) { own?.stop(); this.failed = result; return; }
    // A fork catches up from the oldest agent work GPT Live had not acknowledged: still held, queued, in flight, or lost.
    const undelivered = Math.min(...mediator.feed.pending.map(record => record.at), mediator.context.undeliveredSince() ?? Infinity);
    record.turns.push(...mediator.history.turns());
    record.inForce = [...run.inForce.values()];
    // What a fork of it would know of the page, and how full its context is.
    Object.assign(record, { briefed: run.briefed, context: run.context, finalized: result.finalized, endedAt: Date.now(), deliveredThrough: Number.isFinite(undelivered) ? undelivered - 1 : Date.now(), lastRecordId: mediator.feed.projector.sequence });
    this.saveRun(run);
    // Ended without anyone asking (dropped, closed by GPT Live, or its media stalled): resume on the same page, a limited number of times.
    // Ended for Standby: voice stays on, and the page keeps listening.
    const standby = live.closeReason === STANDBY && this.standby?.page === page;
    const moved = this.moved.has(live), unexpected = !moved && !standby && (!live.requested || live.closeReason === MEDIA_STALLED);
    const reconnect = unexpected && this.live === live && !bridge.stopping && page?.ws.readyState === WebSocket.OPEN && this.allowReconnect();
    if (unexpected) this.lastDrop = { reason: result.reason, at: Date.now(), reconnecting: Boolean(reconnect) };
    // Speech not yet passed on goes to the session that replaces this one (whenever Standby wakes); otherwise to the agent now.
    // Words waiting for the operator to finish don't wait for a wake: the quiet that brought Standby is the end of them.
    if (standby) own?.sendHeld();
    if (reconnect || moved || standby) this.carry(mediator, result.reason, !standby); else own?.handOff(result.reason);
    if (reconnect) log({ type: 'voice.reconnecting', reason: result.reason, recent: this.reconnects.length });
    own?.stop();
    publish({ type: 'voice_closed', ...result, moved: moved || undefined, reconnect: reconnect || undefined, dropped: (unexpected && !reconnect) || undefined, standby: standby || undefined }, page);
    if (this.usage && this.usage.voiceSessionId === live.id) { this.usage.endedAt = Date.now(); publish({ type: 'live_usage', ...this.usage }); }
    if (this.live === live) this.page = undefined;
    publish(bridge.status()); bridge.saveTimeline();
  }
  // Startup (session creation and WebRTC setup) is not counted; the first audio
  // gets its own allowance. The reason names what stopped.
  watch(live: LiveSession) {
    const startedAt = Date.now();
    clearInterval(this.audioWatchdog);
    this.audioWatchdog = setInterval(() => {
      if (this.live !== live || live.state !== 'active') return;
      const now = Date.now();
      if (this.lastAudioAt ? now - this.lastAudioAt <= AUDIO_GAP_MS : now - startedAt <= FIRST_AUDIO_MS) return;
      live.close(now - this.pageAudioAt <= AUDIO_GAP_MS ? MEDIA_STALLED : 'Microphone audio stream stopped');
    }, 1000);
  }
  recentReconnects(now = Date.now()) { return this.reconnects.filter(at => now - at < RECONNECT_WINDOW_MS).length; }
  allowReconnect() {
    const now = Date.now();
    this.reconnects = this.reconnects.filter(at => now - at < RECONNECT_WINDOW_MS);
    if (this.reconnects.length >= RECONNECTS) return false;
    this.reconnects.push(now); return true;
  }
  /** How long a dropped session's unsent speech waits for a replacement to take it over. */
  carryMs = CARRY_MS;
  carry(mediator: Mediator, reason: string, timed = true) {
    this.handOffCarried();
    this.carried = { mediator, reason, timer: timed ? setTimeout(() => this.handOffCarried(), this.carryMs) : undefined };
    this.carried.timer?.unref();
  }
  /** A replacement that never started: the speech it took over waits as long again for the next one, then goes to the agent. */
  carryAgain() {
    const carried = this.carried;
    if (!carried?.timer) return;
    clearTimeout(carried.timer);
    carried.timer = setTimeout(() => this.handOffCarried(), this.carryMs); carried.timer.unref();
  }
  /** Sends a dropped session's unsent speech to the agent when no replacement took it over. */
  handOffCarried() {
    if (!this.carried) return;
    const { mediator, reason, timer } = this.carried;
    clearTimeout(timer); this.carried = undefined;
    mediator.handOff(reason);
  }
  /** A request is held until the agent's turn ends: the voice session that made it is told, so it never says the agent has it. */
  heldDelivery(task: OutboxEntry) {
    const live = this.live;
    if (!task.voiceSessionId || live?.state !== 'active' || task.voiceSessionId !== live.id) return;
    live.append('thinking', heldWords(this.bridge.agent, task.said), task.delegationId ?? null).catch(() => {});
  }
  /** A request may not have reached the agent: its speech goes with that session's next request, and the voice, told it went, hears so. */
  uncertainDelivery(task: OutboxEntry) {
    for (const id of requestIds(task)) this.senders.get(id)?.undelivered(id);
    const live = this.live;
    if (task.confirmationSent && live?.state === 'active') live.append('thinking', uncertainWords(this.bridge.agent, task.said), null).catch(() => {});
  }
  /** A request reached the agent: its speech counts as delegated. */
  confirmDelivery(task: OutboxEntry) { for (const id of requestIds(task)) { this.senders.get(id)?.delivered(id); this.senders.delete(id); } }
  /**
   * A request is handed to the agent now: the voice is told which words went, at once and before anything else is read,
   * so Jev, which reads what the voice was sent, knows it too and doesn't send them again. Told when delivery was
   * confirmed instead, the line could reach the voice after Jev's next reading. One that was held is news to whichever
   * voice session is on when it goes: the one that made it was told only that it was held.
   */
  dispatchedDelivery(task: OutboxEntry) {
    const live = this.live;
    if (task.confirmationSent || !task.voiceSessionId || live?.state !== 'active' || (task.voiceSessionId !== live.id && !task.heldAt)) return;
    task.confirmationSent = true;
    // Never replayed in a new voice session. GPT Live hears it quietly: sent as speech (commentary), it was said aloud even
    // with the operator's own instruction not to (Oct 18, again every request on Oct 19).
    live.append('thinking', sentWords(this.bridge.agent, task.said, task.target === 'fork', task.own), task.delegationId ?? null).catch(error => {
      if (this.live === live && live.state === 'active') this.bridge.fault(new Error(`The request was sent, but telling the voice failed: ${error.message}`));
    });
  }
}
