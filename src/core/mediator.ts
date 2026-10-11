import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Observation, VoiceRequest } from './adapter.ts';
import type { AgentObserver, ObservedAgent } from './agent-observer.ts';
import { ContextQueue, type ContextSink } from './context-queue.ts';
import { VoiceHistory } from './voice-history.ts';
import { ObservationFeed, type Hold } from './observation-feed.ts';
import { Floor, operatorSpeaking, type MicrophoneLevel } from './floor.ts';
import { DEFAULT_TUNING, holdOf, type Tuning } from './tuning.ts';
import type { InstructionLearner } from './instruction-learner.ts';
import { CATCH_AFTER_MS, CATCH_THRESHOLD, type WorkCatcher } from './work-catcher.ts';
import { caughtRequest, nothingToSend, queueFailed, sessionEndRequest, voiceRequest } from './prompts.ts';

/** The part of a Live session the mediator uses. */
export interface MediatedLive extends ContextSink, Pick<EventEmitter, 'on' | 'off'> {
  id?: string;
  startedAt?: number;
  close(reason?: string): unknown;
}

// Wires one voice session: agent observations become Live context, and Live
// delegations become requests to the agent.
export class Mediator {
  live: MediatedLive; observer: AgentObserver; agent: ObservedAgent;
  deliver: (request: VoiceRequest) => void;
  log: (event: Record<string, unknown>) => void;
  publish: (event: Record<string, unknown>) => void;
  clean: (text: string) => string;
  history = new VoiceHistory(); seenDelegations = new Set<string>(); timers = new Set<NodeJS.Timeout>();
  context: ContextQueue; feed: ObservationFeed;
  /** Whether the operator is talking: agent updates wait for them. */
  floor: Floor;
  /** Learns the operator's standing instructions, when Jev is configured. */
  learner?: InstructionLearner; judgedThrough = -1; judgeTimer?: NodeJS.Timeout; previousUtterance = '';
  /** Sends on work GPT Live answered without passing on, when Jev is configured. */
  catcher?: WorkCatcher; catchTimer?: NodeJS.Timeout; delegatedAt = 0;
  onObservation: (event: Observation) => void;
  onLive: (event: any) => void;
  constructor({ live, observer, deliver, log, publish, clean, agent = observer.agent, tuning = DEFAULT_TUNING, hold, learner, catcher, firstRecordId = 0 }: {
    live: MediatedLive; observer: AgentObserver; deliver: (request: VoiceRequest) => void; log: (event: Record<string, unknown>) => void;
    publish: (event: Record<string, unknown>) => void; clean: (text: string) => string; agent?: ObservedAgent; tuning?: Tuning; hold?: Hold | null; learner?: InstructionLearner; catcher?: WorkCatcher;
    /** Context records are numbered after this one: a fork's context already holds its source's. */
    firstRecordId?: number;
  }) {
    this.live = live; this.observer = observer; this.deliver = deliver; this.log = log; this.publish = publish; this.clean = clean; this.learner = learner; this.catcher = catcher;
    this.agent = agent;
    this.floor = new Floor({ thinkMs: tuning.thinkMs, pauseMs: tuning.pauseMs });
    if (hold === undefined) hold = holdOf(tuning);
    this.context = new ContextQueue(live, error => {
      this.fault(error);
      live.close(`${this.agent.profile.name} context delivery failed`);
    }, this.agent, { floor: this.floor, holdMs: tuning.holdLongestMs });
    // Earlier work reaches Live only through the bounded startup history; the feed
    // sends only observations that arrive from now on.
    this.feed = new ObservationFeed(this.context, log, { agent: this.agent, hold, floor: this.floor, compactTokens: tuning.compactTokens });
    this.feed.projector.sequence = firstRecordId;
    this.onObservation = event => this.feed.add(event);
    this.onLive = event => this.liveEvent(event);
    live.on('event', this.onLive); observer.on('observation', this.onObservation);
  }
  /** New settings take effect at once: the floor, the hold and the compaction threshold. */
  applyTuning(tuning: Tuning) {
    Object.assign(this.floor, { thinkMs: tuning.thinkMs, pauseMs: tuning.pauseMs });
    if (this.feed.hold) this.feed.hold = holdOf(tuning);
    this.feed.compactTokens = tuning.compactTokens; this.context.holdMs = tuning.holdLongestMs;
  }
  fault(error: Error) { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: error.message }); }
  liveEvent(event: any) {
    if (event.type === 'session.started') { this.feed.flush(); this.context.pump(); }
    // GPT Live's transcript of the operator also shows they are talking, for pages that send no levels.
    if (event.type === 'session.input_transcript.delta' && String(event.delta ?? '').trim()) {
      this.floor.hear();
      // Once the operator pauses, Jev judges what they said.
      if (this.learner) { clearTimeout(this.judgeTimer); this.judgeTimer = setTimeout(() => this.judge(), 2500); }
      if (this.catcher) { clearTimeout(this.catchTimer); this.catchTimer = setTimeout(() => this.catchWork().catch(error => this.log({ type: 'work.error', message: (error as Error).message })), CATCH_AFTER_MS); }
    }
    if (event.type === 'session.input_audio.append' && typeof event.audio === 'string') this.history.hearAudio(event);
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event);
      this.publish({ type: 'caption', ...fragment, voiceSessionId: this.live.id, voiceStartedAt: this.live.startedAt });
    }
    if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
      const id = event.delegation.id;
      if (this.seenDelegations.has(id)) return;
      this.seenDelegations.add(id); this.delegatedAt = Date.now();
      const createdAt = Date.now();
      const attempt = () => {
        const sinceInput = Date.now() - this.history.lastInputAt;
        if (sinceInput < 450 && Date.now() - createdAt < 3000) return this.schedule(attempt, 200);
        this.delegate(id, event.offset_ms);
      };
      this.schedule(attempt, 650);
    }
  }
  // What the operator said since the last judgment, with what came before as context.
  judge() {
    // Speech carried over from a dropped session was judged there.
    const fragments = this.history.fragments.filter(f => f.seq > this.judgedThrough && !f.carried);
    const said = fragments.filter(f => f.role === 'operator' && !this.history.unheard(f)).map(f => f.text).join('').trim();
    if (!said || !this.learner) return;
    this.judgedThrough = fragments.at(-1)!.seq;
    const firstOperator = fragments.find(f => f.role === 'operator')!.seq;
    const companion = this.history.fragments.filter(f => f.role === 'intermediary' && f.seq < firstOperator).slice(-40).map(f => f.text).join('').trim().slice(-400);
    const utterance = { utterance: this.clean(said), previous: this.previousUtterance, companion: this.clean(companion) };
    this.previousUtterance = utterance.utterance;
    this.learner.consider(utterance).catch(error => this.log({ type: 'instruction.error', message: (error as Error).message }));
  }
  // The operator has been quiet since speaking and GPT Live passed nothing on: if Jev judges
  // that what they said needs the agent, it goes there anyway, marked as such.
  async catchWork() {
    if (this.live.state !== 'active' || Date.now() - this.delegatedAt < CATCH_AFTER_MS) return;
    const request = this.history.request(Infinity);
    if (!request || !this.catcher) return;
    const said = request.utterances.filter(u => u.role === 'operator').map(u => u.text).join(' ');
    const needsAgent = await this.catcher.needsAgent(this.clean(said));
    // Passed on, or more said, while Jev was judging: the newer state decides.
    if (needsAgent < CATCH_THRESHOLD || this.live.state !== 'active' || this.history.request(Infinity)?.through !== request.through || Date.now() - this.delegatedAt < CATCH_AFTER_MS) return;
    this.deliver({ id: randomUUID(), content: this.clean(caughtRequest(request.utterances)), delegationId: null, voiceSessionId: this.live.id, queuedAt: Date.now() });
    this.history.markDelivered(request);
    this.log({ type: 'work.caught', needsAgent, utterances: request.utterances.length });
  }
  /** The microphone level of the page this voice session listens to. */
  hear(level: MicrophoneLevel) { if (operatorSpeaking(level)) this.floor.hear(); }
  schedule(fn: () => void, ms: number) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  delegate(delegationId: string, offsetMs: number) {
    if (this.live.state !== 'active') return;
    const request = this.history.request(offsetMs);
    if (!request) {
      this.log({ type: 'bridge.delegation_suppressed', delegationId, reason: 'No new operator speech to send' });
      this.context.add('thinking', nothingToSend(this.agent), delegationId);
      return;
    }
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', delegationId, text: request.unheard });
    const content = this.clean(voiceRequest(request.utterances));
    try {
      this.deliver({ id: randomUUID(), content, delegationId, voiceSessionId: this.live.id, queuedAt: Date.now() });
      this.history.markDelivered(request);
    } catch (error) {
      this.fault(error as Error);
      this.context.add('thinking', queueFailed(this.agent), delegationId);
    }
  }
  // When the voice session ends, speech not yet passed on goes to the agent anyway, marked as such.
  handOff(reason: string) {
    const request = this.history.request(Infinity);
    if (!request) return;
    const id = randomUUID();
    try {
      this.deliver({ id, content: this.clean(sessionEndRequest(reason, request.utterances)), delegationId: null, voiceSessionId: this.live.id, queuedAt: Date.now() });
      this.history.markDelivered(request);
      this.log({ type: 'bridge.session_end_handoff', id, reason, utterances: request.utterances.length });
    } catch (error) { this.fault(error as Error); }
  }
  stop() {
    this.feed.stop(); this.context.stop(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); clearTimeout(this.judgeTimer); clearTimeout(this.catchTimer);
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}

