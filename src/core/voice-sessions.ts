import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import type { OutboxEntry } from './outbox.ts';
import type { Page } from './pages.ts';
import { LiveSession } from './live-session.ts';
import { Mediator } from './mediator.ts';
import { AudioAudit } from './audio-audit.ts';
import { startupHistory } from './startup-history.ts';
import { attachment, deliveryConfirmation, disregardInstruction, greeting, historyIntro, liveInstructions } from './prompts.ts';
import type { LearnedInstruction } from './instruction-learner.ts';

export interface Instruction { id: string; text: string; state: string; sessionId?: string; acknowledgedAt?: number; error?: string; appended?: boolean; /** Set for an instruction Jev learned: its short ID, such as I3. */ learned?: string }

// Voice connections one after another beside the same agent session: startup
// instructions and history, added instructions, and
// the spoken confirmation of delivered requests.
export class VoiceSessions {
  bridge: Harness;
  live?: LiveSession;
  mediator?: Mediator;
  audit: AudioAudit | null = null;
  additionalInstructions: Instruction[] = [];
  lastAudioAt = 0;
  audioWatchdog?: NodeJS.Timeout;
  /** The page the current voice session belongs to: its events go there, and its microphone is the one heard. */
  page?: Page;
  /** Sessions that ended because another page started voice, and one being ended now. */
  moved = new WeakSet<LiveSession>(); moving = false;
  /** Opens each voice connection; tests replace it. */
  createLive = (options: ConstructorParameters<typeof LiveSession>[0]) => new LiveSession(options);
  /** How many instructions Jev has learned in this companion, for their IDs. */
  learnedCount = 0;
  constructor(bridge: Harness) { this.bridge = bridge; }
  instructions() {
    const additional = this.additionalInstructions.map(item => item.text).join('\n\n');
    return liveInstructions(this.bridge.agent) + (additional ? `\n\nAdditional operator instructions:\n${additional}` : '');
  }
  /** An instruction Jev learned from the operator: it joins this companion's instructions at once, under an ID the operator can remove it by. */
  async learn({ text, ...judged }: LearnedInstruction) {
    const id = `I${++this.learnedCount}`;
    this.bridge.log({ type: 'instruction.learned', id, text, ...judged });
    const item = await this.appendInstruction(`${id}: ${text}`, id).catch(error => { this.bridge.log({ type: 'instruction.error', id, message: (error as Error).message }); return undefined; });
    if (item) this.bridge.publish({ type: 'instruction_learned', id, text, state: item.state });
  }
  /** Removes a learned instruction: later voice sessions leave it out, and a running one is told to disregard it, since an instruction already given cannot be taken back. */
  async removeLearned(id: unknown) {
    const index = this.additionalInstructions.findIndex(item => item.learned !== undefined && item.learned === id);
    if (index < 0) return;
    const [item] = this.additionalInstructions.splice(index, 1), live = this.live;
    this.bridge.log({ type: 'instruction.removed', id: item.learned, text: item.text });
    this.bridge.publish({ type: 'instruction_removed', id: item.learned }); this.bridge.publish(this.bridge.status());
    if (live?.state === 'active' && item.appended) await live.append('instructions', disregardInstruction(item.learned!, item.text.replace(`${item.learned}: `, ''))).catch(error => this.bridge.fault(error as Error));
  }
  async appendInstruction(text: unknown, learned?: string) {
    const { clean, log, publish, fault } = this.bridge;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Enter an instruction first.');
    text = clean(text.trim());
    if (Buffer.byteLength(text as string) > 440) throw new Error('Please shorten this instruction before appending it.');
    if (this.additionalInstructions.reduce((size, item) => size + Buffer.byteLength(item.text), 0) + Buffer.byteLength(text as string) > 16000) throw new Error('This companion already has many additional instructions. Start a new companion to add more.');
    const live = this.live;
    if (['new', 'connecting', 'closing'].includes(live?.state as string)) throw new Error('Wait for the voice connection to settle, then append your instruction.');
    const item: Instruction = { id: randomUUID(), text: text as string, state: live?.state === 'active' ? 'pending' : 'next_session', sessionId: live?.state === 'active' ? live.id : undefined, learned };
    this.additionalInstructions.push(item);
    log({ type: 'voice.instruction', ...item }); publish(this.bridge.status());
    if (live?.state !== 'active') return item;
    try {
      await live.append('instructions', text as string);
      if (this.live !== live || live.state !== 'active') return item;
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
  async start(sdp?: unknown, page?: Page) {
    const bridge = this.bridge, { agent, observer, log, publish, fault, clean } = bridge, { name } = agent.profile;
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
    const startup = attachment(agent, bridge.cwd, observer.state);
    const history = startupHistory(agent, bridge.adapter.history(), Math.max(0, 7600 - Buffer.byteLength(startup)));
    const input = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: startup }] }];
    if (history.text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: historyIntro(agent) + history.text }] });
    const startupInstructions = [...this.additionalInstructions];
    const live: LiveSession = this.createLive({ apiKey: bridge.apiKey, budget: bridge.ledger, voice: bridge.voice, instructions: this.instructions(), label: `${name} ${bridge.sessionId ?? 'session'}`, input, log: event => log({ liveRun: live.reservation, ...event }) });
    this.audit?.close(); this.audit = null;
    this.live = live; this.page = page;
    this.mediator?.stop();
    this.mediator = new Mediator({ live, observer, agent, deliver: task => bridge.deliver(task), log, publish: event => publish(event), clean, learner: bridge.learner });
    publish(bridge.status());
    live.on('fault', error => fault(error, page));
    live.on('answer', sdp => publish({ type: 'voice_answer', sdp }, page));
    live.on('sent', event => {
      if (/^session\.(thinking|commentary|instructions)\.append$/.test(event.type)) publish({ type: 'context_sent', id: event.event_id, kind: event.type.split('.')[1], text: event.content, notification: event });
    });
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
        for (const item of startupInstructions) Object.assign(item, { state: 'acknowledged', sessionId: live.id, acknowledgedAt: Date.now(), error: undefined, appended: false });
        this.audit = new AudioAudit({ dir: path.join(bridge.runDir, 'audio', live.reservation!), log: event => log({ liveRun: live.reservation, ...event }), onError: error => fault(error) });
        publish({ type: 'voice_started', sessionId: live.id }, page);
        publish(bridge.status());
      }
    });
    live.on('closed', result => {
      clearInterval(this.audioWatchdog);
      if (this.mediator?.live === live) this.mediator.handOff(result.reason);
      this.mediator?.stop();
      publish({ type: 'voice_closed', ...result, moved: this.moved.has(live) || undefined }, page);
      if (this.live === live) this.page = undefined;
      publish(bridge.status()); bridge.saveTimeline();
    });
    this.lastAudioAt = Date.now();
    await live.start(sdp as string | undefined);
    this.audioWatchdog = setInterval(() => { if (Date.now() - this.lastAudioAt > 5000) live.close('Microphone audio stream stopped'); }, 1000);
    if (live.state === 'active') await live.greet(greeting(agent));
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
