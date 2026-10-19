import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import type { OutboxEntry } from './outbox.ts';
import type { Page } from './pages.ts';
import { LiveSession, type CloseResult } from './live-session.ts';
import { Mediator } from './mediator.ts';
import { AudioAudit } from './audio-audit.ts';
import { startupHistory } from './startup-history.ts';
import { forkable, planFor, ResumeStore, seedInput, type ResumePlan, type ResumeRecord, type SavedInstruction } from './voice-resume.ts';
import { attachment, catchUp, deliveryConfirmation, disregardInstruction, greeting, historyIntro, liveInstructions, reconnectGreeting, resumeGreeting, stageBrief, stageOutline, standbyNews, standbyWake } from './prompts.ts';
import { Stage } from './stage.ts';
import type { LearnedInstruction } from './instruction-learner.ts';
import { Activity, LIVE_SPEECH_RMS, priceFor } from './activity.ts';
import { operatorSpeaking, type MicrophoneLevel } from './floor.ts';

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
const emptyRecord = (): ResumeRecord => ({ stored: false, finalized: false, turns: [] });
const saved = ({ id, text, learned, learnedIn }: Instruction | SavedInstruction): SavedInstruction => ({ id, text, ...learned ? { learned, learnedIn } : {} });

/** One voice session from its start: how it began, and the record of the agent session it belongs to. */
interface Run {
  live: LiveSession; plan: ResumePlan; page?: Page; automatic: boolean; mediator: Mediator;
  record: ResumeRecord; recordId?: string;
  /** The page on the stage GPT Live was last told about (its address and cue words). */
  briefed?: string;
  /** The instructions it started with, those a fork inherited from its source, and those in force in it now (given and not countermanded). */
  startup: Instruction[]; inherited: SavedInstruction[]; inForce: Map<string, SavedInstruction>;
  /** When voice was asked to start and how, for its startup times; and whether it has spoken yet. */
  requested: { at: number; plan: ResumePlan }; spoke?: boolean;
  /** Set when it woke from Standby: when Standby began, and whether the operator was speaking. */
  wake?: Wake;
}
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
  audit: AudioAudit | null = null;
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
  /** Voice on Standby, and what is happening in the conversation, priced (activity.ts). */
  standby?: Standby; activity = new Activity(); standbyTimer: NodeJS.Timeout;
  constructor(bridge: Harness, { store = true, resumeDir = path.join(bridge.root, '.runs', 'voice-resume') }: { store?: boolean; resumeDir?: string } = {}) {
    this.bridge = bridge; this.store = store; this.resumeStore = new ResumeStore(resumeDir);
    this.standbyTimer = setInterval(() => this.checkStandby(), 1000); this.standbyTimer.unref();
  }
  /** Whether this page's microphone is the one voice listens to: the page running voice, or the one on Standby. */
  listensTo(page: Page) { return page === this.page || page === this.standby?.page; }
  /** The listening page's microphone and speaker levels (about 0.1 s each), priced: the operator's sound and GPT Live's. */
  heard(level: MicrophoneLevel & { outputRms?: number }) {
    if (operatorSpeaking(level)) this.activity.add('operator');
    if ((level.outputRms ?? 0) >= LIVE_SPEECH_RMS) this.activity.add('live');
  }
  /**
   * Every second: voice that has been quiet for the Standby window goes on Standby, and voice on
   * Standby wakes once what happened in the window is worth the threshold (tuning.ts, activity.ts).
   */
  checkStandby(now = Date.now()) {
    const bridge = this.bridge, { standbyAfterMs, wakeThreshold } = bridge.tuning, standby = this.standby, price = priceFor(bridge.tuning);
    if (standby) {
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
      if (this.activity.value(standbyAfterMs, price, now) >= wakeThreshold) {
        const source = this.activity.latest(standbyAfterMs, price, now)?.source ?? 'activity';
        this.wake(source, source === 'operator');
      }
      return;
    }
    const live = this.live, run = this.run, page = this.page;
    if (!standbyAfterMs || bridge.stopping || this.moving || !live || live.state !== 'active' || run?.live !== live || !page || page.ws.readyState !== WebSocket.OPEN) return;
    // A voice session gets the whole window before it can go quiet.
    if (now - (live.startedAt ?? now) < standbyAfterMs || this.activity.value(standbyAfterMs, price, now) >= wakeThreshold) return;
    // A request on its way to the agent keeps voice Live until the agent has it.
    if ([...bridge.outbox.values()].some(entry => entry.state === 'queued' || entry.state === 'dispatching')) return;
    this.standby = { since: Date.now(), page };
    bridge.log({ type: 'voice.standby', liveRun: live.reservation, afterMs: standbyAfterMs, threshold: wakeThreshold, value: this.activity.value(standbyAfterMs, price, now) });
    bridge.publish({ type: 'standby', state: 'on' });
    void live.close(STANDBY);
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
  instructions() {
    const additional = this.additionalInstructions.map(item => item.text).join('\n\n');
    return liveInstructions(this.bridge.agent) + (additional ? `\n\nAdditional operator instructions:\n${additional}` : '');
  }
  /** An instruction Jev learned from the operator: it joins this companion's instructions at once, under an ID the operator can remove it by. */
  async learn({ text, ...judged }: LearnedInstruction) {
    const id = `I${++this.learnedCount}`;
    this.bridge.log({ type: 'instruction.learned', id, text, ...judged });
    await this.appendInstruction(`${id}: ${text}`, { id, text, scope: judged.scope }).catch(error => this.bridge.log({ type: 'instruction.error', id, message: (error as Error).message }));
    return id;
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
    this.bridge.learned.remove({ session: item.learnedIn ?? this.bridge.sessionId, id: item.learned! }); this.bridge.tuneFromInstructions();
    this.rememberInstructions();
    this.bridge.publish({ type: 'instruction_removed', id: item.learned }); this.bridge.publish(this.bridge.status());
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
    return { plan: planFor(record, 'resume'), fork: forkable(record), turns: record.turns.length, store: this.store };
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
    if (learned) { this.bridge.learned.add({ session: item.learnedIn, id: learned.id, text: learned.text, scope: learned.scope }); publish({ type: 'instruction_learned', id: learned.id, text: learned.text, state: item.state }); }
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
    // A wake must be quick: a new session seeded with the conversation, never a slow fork.
    let plan = wake ? record.turns.length ? 'seed' : 'fresh' : planFor(record, mode);
    // Starting fresh after a drop: the speech it had not passed on goes to the agent now.
    if (plan === 'fresh' && !wake) this.handOffCarried();
    const requested = { at: Date.now(), plan };
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
        if (retry && plan === 'fork') { log({ type: 'voice.fork_failed', from: record.liveSessionId, message }); plan = record.turns.length ? 'seed' : 'fresh'; continue; }
        // The page says so beside the connection facts (resume.store).
        if (retry && live.store && /\bstor(e|ed|age)\b|retention|persist/i.test(message)) { this.store = false; log({ type: 'voice.store_refused', message }); continue; }
        // A fork OpenAI answered but never started (twice in a row on Oct 13, "session startup timed out"): it isn't
        // tried again; the page starts over at once, and Resume rebuilds the conversation from its text.
        if (plan === 'fork' && live.answered && !live.requested && !bridge.stopping && record.turns.length) {
          record.forkFailed = record.liveSessionId; this.save();
          log({ type: 'voice.fork_never_started', from: record.liveSessionId, message });
          if (page?.ws.readyState === WebSocket.OPEN && this.allowReconnect()) {
            publish({ type: 'voice_closed', ...(this.failed ?? { reserved: false, finalized: false, usageSeconds: 0 }), reason: 'continuing the last voice session failed; rebuilding the conversation', reconnect: true }, page);
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
    const startup = attachment(agent, bridge.cwd, observer.state);
    // A fork already has its source's startup input and conversation; it catches up on the work GPT Live had not received.
    const since = record.deliveredThrough ?? record.endedAt ?? 0;
    // Waking from Standby, the work from before it is history; the work during it arrives as it would have live (below).
    const wake = attempt.wake;
    const observations = plan === 'fork' ? bridge.adapter.history().filter(o => o.at > since) : wake ? bridge.adapter.history().filter(o => o.at <= wake.since) : bridge.adapter.history();
    const history = startupHistory(agent, observations, Math.max(0, 7600 - Buffer.byteLength(startup)));
    let input = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: startup }] }];
    if (history.text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: historyIntro(agent) + history.text }] });
    if (plan === 'seed') input = seedInput(input, record.turns);
    const live: LiveSession = this.createLive({ apiKey: bridge.apiKey, budget: bridge.ledger, voice: bridge.voice, instructions: this.instructions(), label: `${name} ${bridge.sessionId ?? 'session'}`,
      input: plan === 'fork' ? [] : input, store: this.store, fork: sourceId, log: event => log({ liveRun: live.reservation, ...event }) });
    attempt.live = live;
    this.audit?.close(); this.audit = null; this.failed = undefined;
    this.live = live; this.page = page;
    this.mediator?.stop();
    // A fork's context already holds its source's records: numbering continues after them.
    const mediator: Mediator = this.mediator = new Mediator({ live, observer, agent, deliver: task => { this.senders.set(task.id, mediator); bridge.deliver(task); }, log, publish: event => publish(event), clean,
      learner: bridge.learner, audit: bridge.handOffAudit, gate: bridge.handOffAudit ? (said, id, earlier, companion, cued) => bridge.sessionSwitch.gate(said, id, earlier, companion, cued) : undefined,
      ahead: bridge.handOffAudit && process.env.FDC_AHEAD !== '0' ? (said, earlier, companion) => bridge.sessionSwitch.ahead(said, earlier, companion) : undefined, onSaid: said => bridge.tuneFromInstructions(said),
      tuning: bridge.tuning, firstRecordId: plan === 'fork' ? record.lastRecordId ?? 0 : 0 });
    const run: Run = this.run = { live, plan, page, automatic, mediator, record, recordId, startup: [...this.additionalInstructions], inherited: plan === 'fork' ? record.inForce ?? [] : [], inForce: new Map(), requested: attempt.requested ?? { at: Date.now(), plan }, wake };
    // A dropped or moved session's unsent speech: this session takes it if it starts; meanwhile it isn't handed off.
    // The copies are now the ones to carry or hand off: if this connection fails to start, they go on from here.
    if (this.carried) { clearTimeout(this.carried.timer); mediator.history.carry(this.carried.mediator.history); this.carried.mediator = mediator; }
    if (plan === 'fork') mediator.context.add('thinking', catchUp(agent, bridge.cwd, observer.state) + (history.text ? historyIntro(agent) + history.text : ''), null, '', since);
    // Instead of a greeting, a waking session is told the conversation continues, then gets the agent's work it missed.
    if (wake) {
      mediator.context.add('thinking', standbyWake(agent, wake.operator));
      for (const observation of bridge.adapter.history().filter(o => o.at > wake.since)) mediator.feed.add(observation);
      // Woken by the agent's news: after it, the cue to report it if it calls for that. Woken by the operator, their words are the cue.
      if (!wake.operator) { mediator.feed.flush(); mediator.context.add('commentary', standbyNews(agent)); }
    }
    log({ type: 'voice.starting', plan, automatic, from: sourceId, seededTurns: plan === 'seed' ? input.length - (history.text ? 2 : 1) : undefined, store: this.store, wake: wake?.reason });
    publish(bridge.status());
    // A fork that fails falls back to a new session; its errors are logged, not shown.
    live.on('fault', error => plan === 'fork' && !this.started.has(live) ? log({ type: 'voice.fork_fault', message: error.message }) : fault(error, page));
    live.on('answer', sdp => publish({ type: 'voice_answer', sdp }, page));
    live.on('sent', event => {
      if (/^session\.(thinking|commentary|instructions)\.append$/.test(event.type)) publish({ type: 'context_sent', id: event.event_id, kind: event.type.split('.')[1], text: event.content, notification: event });
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
  }
  /**
   * GPT Live learns the page on the stage: the words that move it as it talks, and what it says.
   * Once per page per session, again when the page or its parts change.
   */
  async briefStage(run = this.run) {
    // Whatever goes wrong here (a page's odd data, a closed session) is logged, never thrown: callers don't wait.
    try { await this.brief(run); } catch (error) { this.bridge.log({ type: 'stage.error', message: (error as Error).message }); }
  }
  async brief(run = this.run) {
    const live = run?.live;
    if (!run || !live || live.state !== 'active' || this.live !== live) return;
    const view = await this.bridge.stage.describe(0).catch(error => { this.bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; });
    if (!view || live.state !== 'active') return;
    const cues = Stage.cues(view), names = cues.filter(c => c.name).map(c => c.label).slice(0, 24), phrases = cues.filter(c => !c.name).map(c => c.label).slice(0, 12);
    this.bridge.speechCues.set(cues);
    // A reload (often with a new query to bust the cache) is the same page unless its parts changed.
    const signature = JSON.stringify([view.url.replace(/[?#].*$/, ''), names, phrases]);
    if (run.briefed === signature) return;
    run.briefed = signature;
    this.bridge.log({ type: 'stage.briefed', url: view.url, names, phrases });
    await live.append('instructions', stageBrief(view.title, names, phrases)).catch(error => this.bridge.log({ type: 'stage.error', message: (error as Error).message }));
    if (view.outline) run.mediator.context.add('thinking', stageOutline(view.title, view.outline), null);
  }
  liveEvent(run: Run, event: any) {
    const { live, page } = run;
    if (event.type === 'session.output_audio.delta') {
      const pcm = Buffer.from(event.delta, 'base64');
      this.audit?.write('output', pcm, { startMs: event.start_ms, endMs: event.end_ms });
      if (live.transport === 'webrtc') return; // The browser plays the negotiated media track.
      const browser = page?.ws;
      if (browser?.readyState !== WebSocket.OPEN) return;
      if (browser.bufferedAmount > 1024 * 1024) return live.close('Audio playback connection too slow');
      browser.send(pcm);
    }
    if (event.type === 'session.input_audio.append' && live.transport === 'webrtc') {
      this.lastAudioAt = Date.now();
      this.audit?.write('input', Buffer.from(event.audio, 'base64'), { startMs: event.start_ms, endMs: event.end_ms });
    }
    if (/^session\.(thinking|commentary|instructions)\.appended$/.test(event.type)) this.bridge.publish({ type: 'context_ack', id: event.client_event_id, startMs: event.start_ms, endMs: event.end_ms });
    if (event.type === 'session.started') this.begun(run);
    // GPT Live's words can move the page as it says them.
    if (event.type === 'session.output_transcript.delta' && this.live === live) this.bridge.heardSpeech(String(event.delta ?? ''));
    if (event.type === 'session.delegation.created') this.activity.add('request');
    // ...and to the first words it says.
    if (event.type === 'session.output_transcript.delta' && !run.spoke) { run.spoke = true; this.bridge.log({ type: 'voice.first_words', plan: run.plan, automatic: run.automatic, firstWordsMs: Date.now() - run.requested.at }); }
    // Live reports usage about every 15 seconds; the last few minutes of it are enough for the meters.
    const usage = this.usage;
    if (event.type === 'session.usage.updated' && usage && usage.voiceSessionId === live.id) {
      const ratio = event.context_window?.usage_ratio;
      if (Number.isFinite(ratio)) { usage.ratio = ratio; usage.points = [...usage.points.slice(-39), [Date.now(), ratio]]; }
      usage.seconds = event.usage?.seconds ?? usage.seconds;
      this.bridge.publish({ type: 'live_usage', ...usage });
    }
  }
  begun(run: Run) {
    const { live, plan, page, automatic, record } = run, bridge = this.bridge, { log, publish, fault } = bridge;
    this.started.add(live);
    // The replacement took over a dropped session's unsent speech.
    if (this.carried) { clearTimeout(this.carried.timer); this.carried = undefined; }
    // In force from the start: everything in a new session's startup prompt (one removed while it started is
    // countermanded right after), or what a fork inherited.
    run.inForce = new Map((plan === 'fork' ? run.inherited : run.startup.map(saved)).map(item => [item.id, item]));
    for (const item of this.additionalInstructions) if (run.inForce.has(item.id)) Object.assign(item, { state: 'acknowledged', sessionId: live.id, acknowledgedAt: Date.now(), error: undefined, appended: false });
    if (plan === 'fresh') record.turns = [];
    Object.assign(record, { liveSessionId: live.id, stored: live.stored, finalized: false, endedAt: undefined, deliveredThrough: undefined });
    this.noteInForce(run);
    this.audit = new AudioAudit({ dir: path.join(bridge.runDir, 'audio', live.reservation!), log: event => log({ liveRun: live.reservation, ...event }), onError: error => fault(error) });
    this.usage = { voiceSessionId: live.id!, startedAt: live.startedAt ?? Date.now(), seconds: 0, ratio: null, points: [] };
    publish({ type: 'live_usage', ...this.usage });
    // Startup times: from the click (or reconnect, or wake) to GPT Live's session starting, fallbacks included.
    log({ type: 'voice.started', plan, requestedPlan: run.requested.plan, automatic, startMs: Date.now() - run.requested.at, wake: run.wake?.reason });
    if (run.wake && this.standby) { log({ type: 'voice.woke', reason: run.wake.reason, standbyMs: Date.now() - this.standby.since }); this.standby = undefined; publish({ type: 'standby', state: 'off', reason: run.wake.reason }); }
    publish({ type: 'voice_started', sessionId: live.id, plan, automatic }, page);
    publish(bridge.status());
  }
  closed(run: Run, result: CloseResult) {
    const { live, page, mediator, record } = run, bridge = this.bridge, { log, publish } = bridge;
    if (this.live === live) clearInterval(this.audioWatchdog);
    const own = this.mediator === mediator ? mediator : undefined;
    // One that never started is reported, or replaced, by start().
    if (!this.started.has(live)) { own?.stop(); this.failed = result; return; }
    // A fork catches up from the oldest agent work GPT Live had not acknowledged: still held, queued, in flight, or lost.
    const undelivered = Math.min(...mediator.feed.pending.map(record => record.at), mediator.context.undeliveredSince() ?? Infinity);
    record.turns.push(...mediator.history.turns());
    record.inForce = [...run.inForce.values()];
    Object.assign(record, { finalized: result.finalized, endedAt: Date.now(), deliveredThrough: Number.isFinite(undelivered) ? undelivered - 1 : Date.now(), lastRecordId: mediator.feed.projector.sequence });
    this.saveRun(run);
    // Ended without anyone asking (dropped, closed by GPT Live, or its media stalled): resume on the same page, a limited number of times.
    // Ended for Standby: voice stays on, and the page keeps listening.
    const standby = live.closeReason === STANDBY && this.standby?.page === page;
    const moved = this.moved.has(live), unexpected = !moved && !standby && (!live.requested || live.closeReason === MEDIA_STALLED);
    const reconnect = unexpected && this.live === live && !bridge.stopping && page?.ws.readyState === WebSocket.OPEN && this.allowReconnect();
    if (unexpected) this.lastDrop = { reason: result.reason, at: Date.now(), reconnecting: Boolean(reconnect) };
    // Speech not yet passed on goes to the session that replaces this one (whenever Standby wakes); otherwise to the agent now.
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
  carry(mediator: Mediator, reason: string, timed = true) {
    this.handOffCarried();
    this.carried = { mediator, reason, timer: timed ? setTimeout(() => this.handOffCarried(), CARRY_MS) : undefined };
    this.carried.timer?.unref();
  }
  /** Sends a dropped session's unsent speech to the agent when no replacement took it over. */
  handOffCarried() {
    if (!this.carried) return;
    const { mediator, reason, timer } = this.carried;
    clearTimeout(timer); this.carried = undefined;
    mediator.handOff(reason);
  }
  /** A request reached the agent: its speech counts as delegated. */
  /** A request may not have reached the agent: its speech goes with that session's next request. */
  uncertainDelivery(task: OutboxEntry) { this.senders.get(task.id)?.undelivered(task.id); }
  confirmDelivery(task: OutboxEntry) {
    this.senders.get(task.id)?.delivered(task.id); this.senders.delete(task.id);
    const live = this.live;
    if (task.confirmationSent || !task.voiceSessionId || live?.state !== 'active' || task.voiceSessionId !== live.id) return;
    task.confirmationSent = true;
    // Delivery is an operator-facing fact, independent of the observation
    // backlog. The adapter confirms its own write; this does not claim that the
    // agent has started or completed the work. Never replay it in a new voice session.
    live.append('commentary', deliveryConfirmation(this.bridge.agent), task.delegationId ?? null).catch(error => {
      if (this.live === live && live.state === 'active') this.bridge.fault(new Error(`The request was sent, but its voice confirmation failed: ${error.message}`));
    });
  }
}
