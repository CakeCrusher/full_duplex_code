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
import { forkable, planFor, ResumeStore, seedInput, type ResumePlan, type ResumeRecord } from './voice-resume.ts';
import { attachment, catchUp, deliveryConfirmation, disregardInstruction, greeting, historyIntro, liveInstructions, reconnectGreeting, resumeGreeting } from './prompts.ts';
import type { LearnedInstruction } from './instruction-learner.ts';

export interface Instruction { id: string; text: string; state: string; sessionId?: string; acknowledgedAt?: number; error?: string; appended?: boolean; /** Set for an instruction Jev learned: its short ID, such as I3. */ learned?: string }
/** The latest voice session's span and GPT Live's usage reports, for the page's meters. */
export interface LiveUsage { voiceSessionId: string; startedAt: number; endedAt?: number; seconds: number; ratio: number | null; points: [at: number, ratio: number][] }
/** Why the watchdog ends voice when GPT Live stops hearing audio the page still sends. */
export const MEDIA_STALLED = "GPT Live's audio stream stopped";
// Automatic reconnects allowed per window, so a failing connection can't loop or run up cost;
// and how long a dropped session's unsent speech waits for the reconnect before going to the agent.
const RECONNECTS = 2, RECONNECT_WINDOW_MS = 5 * 60 * 1000, CARRY_MS = 30000;
// After GPT Live starts, its media gets this long to deliver the first audio; after that, audio may pause 5 s.
const FIRST_AUDIO_MS = 15000, AUDIO_GAP_MS = 5000;
const emptyRecord = (): ResumeRecord => ({ stored: false, finalized: false, turns: [] });

// Voice connections one after another beside the same agent session: startup
// instructions and history, added instructions, the spoken confirmation of
// delivered requests, and resuming the conversation, by choice or after a drop.
export class VoiceSessions {
  bridge: Harness;
  live?: LiveSession;
  mediator?: Mediator;
  audit: AudioAudit | null = null;
  additionalInstructions: Instruction[] = [];
  usage?: LiveUsage;
  /** When GPT Live last echoed microphone audio (or the page sent it, over WebSocket), and when the page last reported microphone levels. */
  lastAudioAt = 0; pageAudioAt = 0;
  audioWatchdog?: NodeJS.Timeout;
  /** The page the current voice session belongs to: its events go there, and its microphone is the one heard. */
  page?: Page;
  /** Sessions that ended because another page started voice, and one being ended now. */
  moved = new WeakSet<LiveSession>(); moving = false;
  /** Sessions GPT Live started; one that never did is retried or reported by start(). */
  started = new WeakSet<LiveSession>();
  /** Opens each voice connection; tests replace it. */
  createLive = (options: ConstructorParameters<typeof LiveSession>[0]) => new LiveSession(options);
  /** How many instructions Jev has learned in this companion, for their IDs. */
  learnedCount = 0;
  /** Whether voice sessions ask OpenAI to store them for forking: off with --no-store, or once OpenAI refuses. */
  store: boolean;
  resumeStore: ResumeStore;
  /** The agent session's conversation and last voice session, for Resume voice; and the agent session it belongs to. */
  record = emptyRecord(); recordFor?: string;
  /** Automatic reconnects in the last window, and the last voice session that ended without being asked to. */
  reconnects: number[] = []; lastDrop?: { reason: string; at: number; reconnecting: boolean };
  /** Speech a dropped session had not passed on, kept for the session that replaces it. */
  carried?: { mediator: Mediator; reason: string; timer: NodeJS.Timeout };
  constructor(bridge: Harness, { store = true, resumeDir = path.join(bridge.root, '.runs', 'voice-resume') }: { store?: boolean; resumeDir?: string } = {}) {
    this.bridge = bridge; this.store = store; this.resumeStore = new ResumeStore(resumeDir);
  }
  instructions() {
    const additional = this.additionalInstructions.map(item => item.text).join('\n\n');
    return liveInstructions(this.bridge.agent) + (additional ? `\n\nAdditional operator instructions:\n${additional}` : '');
  }
  /** An instruction Jev learned from the operator: it joins this companion's instructions at once, under an ID the operator can remove it by. */
  async learn({ text, ...judged }: LearnedInstruction) {
    const id = `I${++this.learnedCount}`;
    this.bridge.log({ type: 'instruction.learned', id, text, ...judged });
    this.bridge.learned.add({ session: this.bridge.sessionId, id, text, scope: judged.scope });
    const item = await this.appendInstruction(`${id}: ${text}`, id).catch(error => { this.bridge.log({ type: 'instruction.error', id, message: (error as Error).message }); return undefined; });
    if (item) this.bridge.publish({ type: 'instruction_learned', id, text, state: item.state });
  }
  /** Removes a learned instruction: later voice sessions leave it out, and a running one is told to disregard it, since an instruction already given cannot be taken back. */
  async removeLearned(id: unknown) {
    const index = this.additionalInstructions.findIndex(item => item.learned !== undefined && item.learned === id);
    if (index < 0) return;
    const [item] = this.additionalInstructions.splice(index, 1), live = this.live;
    this.bridge.log({ type: 'instruction.removed', id: item.learned, text: item.text });
    this.bridge.learned.remove({ session: this.bridge.sessionId, id: item.learned! }); this.bridge.retune();
    this.bridge.publish({ type: 'instruction_removed', id: item.learned }); this.bridge.publish(this.bridge.status());
    if (live?.state === 'active' && item.appended) await live.append('instructions', disregardInstruction(item.learned!, item.text.replace(`${item.learned}: `, ''))).catch(error => this.bridge.fault(error as Error));
  }
  /** The saved record of the current agent session, read once its ID is known. */
  current(): ResumeRecord {
    const id = this.bridge.sessionId;
    if (id && id !== this.recordFor) {
      // Voice used before the ID was known belongs to this session.
      const unsaved = !this.recordFor && this.record.liveSessionId;
      this.recordFor = id;
      if (unsaved) this.save(); else this.record = this.resumeStore.load(id) ?? emptyRecord();
    }
    return this.record;
  }
  save() {
    if (!this.bridge.sessionId) return;
    try { this.resumeStore.save(this.bridge.sessionId, this.record); }
    catch (error) { this.bridge.log({ type: 'voice.resume_save_failed', message: (error as Error).message }); }
  }
  /** What Resume voice would do now, for the page. */
  resumeStatus() {
    const record = this.current();
    return { plan: planFor(record, 'resume'), fork: forkable(record), turns: record.turns.length, store: this.store };
  }
  async appendInstruction(text: unknown, learned?: string) {
    const { clean, log, publish } = this.bridge;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Enter an instruction first.');
    text = clean(text.trim());
    if (Buffer.byteLength(text as string) > 440) throw new Error('Please shorten this instruction before appending it.');
    if (this.additionalInstructions.reduce((size, item) => size + Buffer.byteLength(item.text), 0) + Buffer.byteLength(text as string) > 16000) throw new Error('This companion already has many additional instructions. Start a new companion to add more.');
    const live = this.live;
    if (['new', 'connecting', 'closing'].includes(live?.state as string)) throw new Error('Wait for the voice connection to settle, then append your instruction.');
    const item: Instruction = { id: randomUUID(), text: text as string, state: live?.state === 'active' ? 'pending' : 'next_session', sessionId: live?.state === 'active' ? live.id : undefined, learned };
    this.additionalInstructions.push(item);
    log({ type: 'voice.instruction', ...item }); publish(this.bridge.status()); this.bridge.retune();
    if (live?.state !== 'active') return item;
    await this.applyInstruction(live, item);
    return item;
  }
  async applyInstruction(live: LiveSession, item: Instruction) {
    const { log, publish, fault, clean } = this.bridge;
    Object.assign(item, { state: 'pending', sessionId: live.id });
    try {
      await live.append('instructions', item.text);
      if (this.live !== live || live.state !== 'active') return;
      Object.assign(item, { state: 'acknowledged', acknowledgedAt: Date.now(), appended: true });
      log({ type: 'voice.instruction_acknowledged', ...item });
    } catch (error) {
      if (this.live !== live || live.state !== 'active') return item;
      Object.assign(item, { state: 'failed', error: clean((error as Error).message) });
      fault(error as Error);
    }
    publish(this.bridge.status());
    return item;
  }
  /** Starts voice: Resume continues the conversation (a fork of the stored last session, else a new session seeded with its text); fresh starts without it. */
  async start(sdp?: unknown, page?: Page, mode: 'resume' | 'fresh' = 'fresh', automatic = false) {
    const bridge = this.bridge, { agent, observer, log, publish } = bridge, { name } = agent.profile;
    if (sdp !== undefined && (typeof sdp !== 'string' || !sdp.trim() || Buffer.byteLength(sdp) > 65536)) throw new Error('Invalid voice connection offer.');
    const running = this.live && this.live.state !== 'closed' ? this.live : undefined;
    if (running) {
      // Start on another page moves voice there. A repeated start, or one while
      // voice is still connecting, closing or already moving, changes nothing.
      if (!page || page === this.page || running.state !== 'active' || this.moving) return;
      log({ type: 'voice.moved', from: this.page?.id, to: page.id });
      this.moved.add(running); this.moving = true;
      try { await running.close('voice moved to another page'); } finally { this.moving = false; }
      if (this.live !== running) return;
    }
    if (!bridge.agentReady) throw new Error(`Wait for the voice ${agent.profile.transport} to connect in the ${name} terminal.`);
    if (observer.state === 'exited') throw new Error(`The ${name} session has exited.`);
    const record = this.current();
    let plan = planFor(record, mode);
    // Starting fresh after a drop: the speech it had not passed on goes to the agent now.
    if (plan === 'fresh') this.handOffCarried();
    for (;;) {
      try { return await this.connect(sdp as string | undefined, page, plan, automatic); }
      catch (error) {
        const live = this.live!, message = (error as Error).message;
        // A fork or storage OpenAI refuses falls back quietly: only a session that never started, that nobody canceled, and whose media answer the page has not applied.
        const retry = !this.started.has(live) && !live.answered && !live.requested && !bridge.stopping;
        if (retry && plan === 'fork') { log({ type: 'voice.fork_failed', from: record.liveSessionId, message }); plan = record.turns.length ? 'seed' : 'fresh'; continue; }
        // The page says so beside the connection facts (resume.store).
        if (retry && live.store && /\bstor(e|ed|age)\b|retention|persist/i.test(message)) { this.store = false; log({ type: 'voice.store_refused', message }); continue; }
        // The page learns that voice did not start.
        publish({ type: 'voice_closed', ...(this.failed ?? { reserved: false, finalized: false, usageSeconds: 0, reason: message }) }, page);
        publish(bridge.status());
        throw error;
      }
    }
  }
  failed?: CloseResult;
  async connect(sdp: string | undefined, page: Page | undefined, plan: ResumePlan, automatic: boolean) {
    const bridge = this.bridge, { agent, observer, log, publish, fault, clean } = bridge, { name } = agent.profile;
    const record = this.current(), sourceId = plan === 'fork' ? record.liveSessionId : undefined;
    const startup = attachment(agent, bridge.cwd, observer.state);
    // A fork already has its source's startup input and conversation; it catches up on the work since.
    const observations = plan === 'fork' ? bridge.adapter.history().filter(o => o.at > (record.endedAt ?? 0)) : bridge.adapter.history();
    const history = startupHistory(agent, observations, Math.max(0, 7600 - Buffer.byteLength(startup)));
    let input = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: startup }] }];
    if (history.text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: historyIntro(agent) + history.text }] });
    if (plan === 'seed') input = seedInput(input, record.turns);
    const startupInstructions = [...this.additionalInstructions];
    const live: LiveSession = this.createLive({ apiKey: bridge.apiKey, budget: bridge.ledger, voice: bridge.voice, instructions: this.instructions(), label: `${name} ${bridge.sessionId ?? 'session'}`,
      input: plan === 'fork' ? [] : input, store: this.store, fork: sourceId, log: event => log({ liveRun: live.reservation, ...event }) });
    this.audit?.close(); this.audit = null; this.failed = undefined;
    this.live = live; this.page = page;
    this.mediator?.stop();
    const mediator = this.mediator = new Mediator({ live, observer, agent, deliver: task => bridge.deliver(task), log, publish: event => publish(event), clean, learner: bridge.learner, tuning: bridge.tuning });
    if (this.carried) mediator.history.carry(this.carried.mediator.history);
    if (plan === 'fork') mediator.context.add('thinking', catchUp(agent, bridge.cwd, observer.state) + (history.text ? historyIntro(agent) + history.text : ''));
    log({ type: 'voice.starting', plan, automatic, from: sourceId, seededTurns: plan === 'seed' ? input.length - (history.text ? 2 : 1) : undefined, store: this.store });
    publish(bridge.status());
    // A fork that fails falls back to a new session; its errors are logged, not shown.
    live.on('fault', error => plan === 'fork' && !this.started.has(live) ? log({ type: 'voice.fork_fault', message: error.message }) : fault(error, page));
    live.on('answer', sdp => publish({ type: 'voice_answer', sdp }, page));
    live.on('sent', event => {
      if (/^session\.(thinking|commentary|instructions)\.append$/.test(event.type)) publish({ type: 'context_sent', id: event.event_id, kind: event.type.split('.')[1], text: event.content, notification: event });
    });
    const inherited = (item: Instruction) => item.state === 'acknowledged' && item.sessionId === sourceId;
    const toAppend = plan === 'fork' ? startupInstructions.filter(item => !inherited(item)) : [];
    live.on('event', event => {
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
      if (/^session\.(thinking|commentary|instructions)\.appended$/.test(event.type)) publish({ type: 'context_ack', id: event.client_event_id, startMs: event.start_ms, endMs: event.end_ms });
      if (event.type === 'session.started') {
        this.started.add(live);
        // The replacement took over a dropped session's unsent speech.
        if (this.carried) { clearTimeout(this.carried.timer); this.carried = undefined; }
        for (const item of startupInstructions) {
          if (toAppend.includes(item)) continue;
          Object.assign(item, { state: 'acknowledged', sessionId: live.id, acknowledgedAt: Date.now(), error: undefined, appended: plan === 'fork' ? item.appended : false });
        }
        if (plan === 'fresh') record.turns = [];
        Object.assign(record, { liveSessionId: live.id, stored: live.stored, finalized: false, endedAt: undefined });
        this.save();
        this.audit = new AudioAudit({ dir: path.join(bridge.runDir, 'audio', live.reservation!), log: event => log({ liveRun: live.reservation, ...event }), onError: error => fault(error) });
        this.usage = { voiceSessionId: live.id!, startedAt: live.startedAt ?? Date.now(), seconds: 0, ratio: null, points: [] };
        publish({ type: 'live_usage', ...this.usage });
        publish({ type: 'voice_started', sessionId: live.id, plan, automatic }, page);
        publish(bridge.status());
      }
      // Live reports usage about every 15 seconds; the last few minutes of it are enough for the meters.
      const usage = this.usage;
      if (event.type === 'session.usage.updated' && usage && usage.voiceSessionId === live.id) {
        const ratio = event.context_window?.usage_ratio;
        if (Number.isFinite(ratio)) { usage.ratio = ratio; usage.points = [...usage.points.slice(-39), [Date.now(), ratio]]; }
        usage.seconds = event.usage?.seconds ?? usage.seconds;
        publish({ type: 'live_usage', ...usage });
      }
    });
    live.on('closed', result => {
      if (this.live === live) clearInterval(this.audioWatchdog);
      const own = this.mediator?.live === live ? this.mediator : undefined;
      // One that never started is reported, or replaced, by start().
      if (!this.started.has(live)) { own?.stop(); this.failed = result; return; }
      record.turns.push(...mediator.history.turns());
      Object.assign(record, { finalized: result.finalized, endedAt: Date.now() });
      this.save();
      // Ended without anyone asking (dropped, closed by GPT Live, or its media stalled): resume on the same page, a limited number of times.
      const unexpected = !live.requested || live.closeReason === MEDIA_STALLED;
      const reconnect = unexpected && this.live === live && !bridge.stopping && page?.ws.readyState === WebSocket.OPEN && this.allowReconnect();
      if (unexpected) this.lastDrop = { reason: result.reason, at: Date.now(), reconnecting: Boolean(reconnect) };
      if (reconnect) this.carry(mediator, result.reason); else own?.handOff(result.reason);
      if (reconnect) log({ type: 'voice.reconnecting', reason: result.reason, recent: this.reconnects.length });
      own?.stop();
      publish({ type: 'voice_closed', ...result, moved: this.moved.has(live) || undefined, reconnect: reconnect || undefined, dropped: (unexpected && !reconnect) || undefined }, page);
      if (this.usage && this.usage.voiceSessionId === live.id) { this.usage.endedAt = Date.now(); publish({ type: 'live_usage', ...this.usage }); }
      if (this.live === live) this.page = undefined;
      publish(bridge.status()); bridge.saveTimeline();
    });
    this.lastAudioAt = 0; this.pageAudioAt = 0;
    await live.start(sdp);
    this.watch(live);
    if (live.state !== 'active') return;
    for (const item of toAppend) await this.applyInstruction(live, item);
    if (live.state === 'active') await live.greet(plan === 'fresh' ? greeting(agent) : automatic ? reconnectGreeting(agent) : resumeGreeting(agent));
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
  allowReconnect() {
    const now = Date.now();
    this.reconnects = this.reconnects.filter(at => now - at < RECONNECT_WINDOW_MS);
    if (this.reconnects.length >= RECONNECTS) return false;
    this.reconnects.push(now); return true;
  }
  carry(mediator: Mediator, reason: string) {
    this.handOffCarried();
    this.carried = { mediator, reason, timer: setTimeout(() => this.handOffCarried(), CARRY_MS) };
    this.carried.timer.unref();
  }
  /** Sends a dropped session's unsent speech to the agent when no replacement took it over. */
  handOffCarried() {
    if (!this.carried) return;
    const { mediator, reason, timer } = this.carried;
    clearTimeout(timer); this.carried = undefined;
    mediator.handOff(reason);
  }
  confirmDelivery(task: OutboxEntry) {
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
