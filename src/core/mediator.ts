import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Observation, VoiceRequest } from './adapter.ts';
import type { AgentObserver, ObservedAgent } from './agent-observer.ts';
import { ContextQueue, type ContextSink } from './context-queue.ts';
import { VoiceHistory, type SpokenRequest } from './voice-history.ts';
import { ObservationFeed, type Hold } from './observation-feed.ts';
import { Floor, operatorSpeaking, type MicrophoneLevel } from './floor.ts';
import { DEFAULT_TUNING, holdOf, type Tuning } from './tuning.ts';
import type { InstructionLearner } from './instruction-learner.ts';
import type { DelegationAudit, HandOff } from './delegation-audit.ts';
import { nothingToSend, queueFailed, sessionEndRequest, voiceRequest } from './prompts.ts';

/** What Jev's check before delivery found: its judgment, and when fdc handled the request itself, what GPT Live is told instead. */
export interface Screened { needsAgent?: number | null; handled?: string; /** Handled because it was only about how the companion behaves. */ companion?: boolean }

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
  learner?: InstructionLearner; previousUtterance = '';
  /** Records each hand-off decision of GPT Live with Jev's judgment of it, when Jev is configured. Sends nothing. */
  audit?: DelegationAudit;
  /** Checks a request GPT Live passed on before it reaches the harness (session changes), when Jev is configured. */
  screen?: (said: string, requestId: string) => Promise<Screened>;
  /** The operator's words of each request, for Jev to tune the companion from (jev-tuner.ts). */
  onSaid?: (said: string) => void;
  onObservation: (event: Observation) => void;
  onLive: (event: any) => void;
  constructor({ live, observer, deliver, log, publish, clean, agent = observer.agent, tuning = DEFAULT_TUNING, hold, learner, audit, screen, onSaid, firstRecordId = 0 }: {
    live: MediatedLive; observer: AgentObserver; deliver: (request: VoiceRequest) => void; log: (event: Record<string, unknown>) => void;
    publish: (event: Record<string, unknown>) => void; clean: (text: string) => string; agent?: ObservedAgent; tuning?: Tuning; hold?: Hold | null; learner?: InstructionLearner; audit?: DelegationAudit; screen?: (said: string, requestId: string) => Promise<Screened>; onSaid?: (said: string) => void;
    /** Context records are numbered after this one: a fork's context already holds its source's. */
    firstRecordId?: number;
  }) {
    this.live = live; this.observer = observer; this.deliver = deliver; this.log = log; this.publish = publish; this.clean = clean; this.learner = learner; this.audit = audit; this.screen = screen; this.onSaid = onSaid;
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
    }
    if (event.type === 'session.input_audio.append' && typeof event.audio === 'string') this.history.hearAudio(event);
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event);
      this.publish({ type: 'caption', ...fragment, voiceSessionId: this.live.id, voiceStartedAt: this.live.startedAt });
    }
    if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
      const id = event.delegation.id;
      if (this.seenDelegations.has(id)) return;
      this.seenDelegations.add(id);
      const createdAt = Date.now();
      const attempt = () => {
        const sinceInput = Date.now() - this.history.lastInputAt;
        if (sinceInput < 450 && Date.now() - createdAt < 3000) return this.schedule(attempt, 200);
        this.delegate(id, event.offset_ms);
      };
      this.schedule(attempt, 650);
    }
  }
  // Jev checks what reached the harness, once per request: whether it holds a standing instruction
  // for the companion, and (recorded only) whether it needed the harness at all.
  said(request: SpokenRequest) { return this.clean(request.utterances.filter(u => u.role === 'operator').map(u => u.text).join(' ').replace(/\s+/g, ' ').trim()); }
  check(requestId: string, request: SpokenRequest, handOff: HandOff, delegationId: string | null = null, judged?: number | null) {
    const said = this.said(request);
    if (!said) return;
    this.consider(requestId, request, said);
    if (this.audit) void this.audit.record({ handOff, said, voiceSessionId: this.live.id, delegationId, requestId }, judged).then(needsAgent => this.publish({
      type: 'jev_check', requestId, at: Date.now(), kind: 'handoff', words: said, scores: { needsAgent, handOff },
      outcome: typeof needsAgent !== 'number' ? 'Hand-off check failed' : `${handOff === 'passed' ? 'GPT Live passed it on' : 'GPT Live kept it; sent when voice ended'}; Jev: ${needsAgent >= .5 ? 'needed the harness' : 'could have been answered'} (${needsAgent.toFixed(2)})`,
    }));
  }
  // Whether the words hold a standing instruction for the companion (Jev's learner), and Jev's tuning from them.
  consider(requestId: string, request: SpokenRequest, said: string) {
    const companion = this.clean(request.utterances.filter(u => u.role === 'intermediary').map(u => u.text).join(' ').trim().slice(-400));
    if (this.learner) {
      const utterance = { utterance: said, previous: this.previousUtterance, companion, requestId };
      this.learner.consider(utterance).catch(error => this.log({ type: 'instruction.error', message: (error as Error).message }));
    }
    this.previousUtterance = said;
    this.onSaid?.(said);
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
    const content = this.clean(voiceRequest(request.utterances)), id = randomUUID();
    if (this.screen) return this.screened(id, request, content, delegationId);
    this.send(id, request, content, delegationId);
  }
  // Jev reads the request first; one that only turns sessions on or off is handled by fdc, and GPT Live
  // is told so instead. Its words are taken meanwhile, so a later delegation doesn't send them again.
  async screened(id: string, request: SpokenRequest, content: string, delegationId: string) {
    this.history.markDelivered(request);
    const said = this.said(request);
    let screened: Screened | undefined;
    try { screened = await this.screen!(said, id); } catch (error) { this.log({ type: 'screen.error', message: (error as Error).message }); }
    if (screened?.handled === undefined) return this.send(id, request, content, delegationId, screened?.needsAgent);
    this.log({ type: 'bridge.request_handled', id, delegationId, said, companion: screened.companion });
    // A preference about the companion is still a standing instruction to learn, and Jev's to tune from.
    if (screened.companion) this.consider(id, request, said); else this.previousUtterance = said;
    if (this.live.state === 'active') this.context.add('thinking', screened.handled, delegationId);
  }
  send(id: string, request: SpokenRequest, content: string, delegationId: string, judged?: number | null) {
    try {
      this.deliver({ id, content, delegationId, voiceSessionId: this.live.id, queuedAt: Date.now() });
      this.history.markDelivered(request);
      this.check(id, request, 'passed', delegationId, judged);
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
      this.check(id, request, 'answered');
    } catch (error) { this.fault(error as Error); }
  }
  stop() {
    this.feed.stop(); this.context.stop(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}

