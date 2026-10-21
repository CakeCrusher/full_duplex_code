import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Observation, VoiceRequest } from './adapter.ts';
import type { AgentObserver, ObservedAgent } from './agent-observer.ts';
import { ContextQueue, type ContextSink } from './context-queue.ts';
import { VoiceHistory, type Spoken, type SpokenRequest } from './voice-history.ts';
import { ObservationFeed, type Hold } from './observation-feed.ts';
import { Floor, operatorSpeaking, type MicrophoneLevel } from './floor.ts';
import { DEFAULT_TUNING, holdOf, type Tuning } from './tuning.ts';
import type { DelegationAudit, HandOff } from './delegation-audit.ts';
import type { Reading, Trigger } from './jev.ts';
import { cueNoDelegation, handledNote, nothingToSend, queueFailed, sessionEndRequest, uncertainNote, voiceRequest } from './prompts.ts';

/** What the gate (Jev's check before delivery) found: Jev's reading, and when fdc handled the request itself, what GPT Live is told instead. */
export interface Gated {
  reading?: Reading; handled?: string;
  /** Handled because it was only about how the companion behaves. */
  companion?: boolean;
  /** Handled because it only asked for things on the page, done there. */
  page?: boolean;
  /** For the harness, with the request: what fdc already did, or what failed. */
  note?: string;
  /** For GPT Live, as the request goes on. */
  told?: string;
}

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
  /** Why voice ended, once it has: speech handed back after that goes to the agent at once. */
  ended?: string;
  /** When GPT Live's own words last moved the page (speech cues): it is presenting. */
  cueAt = 0;
  context: ContextQueue; feed: ObservationFeed;
  /** Whether the operator is talking: agent updates wait for them. */
  floor: Floor;
  /** Records each hand-off decision of GPT Live with Jev's judgment of it, when Jev is configured. Sends nothing. */
  audit?: DelegationAudit;
  /** The gate: reads a request GPT Live passed on before it reaches the harness (sessions, the companion, the page), when Jev is configured. */
  gate?: (said: string, requestId: string, spoken: Spoken[], cued?: boolean) => Promise<Gated>;
  /** Jev's reading of words that reach the harness without the gate's (voice ended, or the voice tool sent them). */
  read?: (trigger: Trigger, spoken: Spoken[]) => Promise<Reading>;
  /** What Jev read in a request, for the learner and the tuner: each reading once. */
  consider?: (reading: Reading, requestId?: string) => void;
  onObservation: (event: Observation) => void;
  onLive: (event: any) => void;
  constructor({ live, observer, deliver, log, publish, clean, agent = observer.agent, tuning = DEFAULT_TUNING, hold, audit, gate, read, consider, firstRecordId = 0 }: {
    live: MediatedLive; observer: AgentObserver; deliver: (request: VoiceRequest) => void; log: (event: Record<string, unknown>) => void;
    publish: (event: Record<string, unknown>) => void; clean: (text: string) => string; agent?: ObservedAgent; tuning?: Tuning; hold?: Hold | null; audit?: DelegationAudit;
    gate?: (said: string, requestId: string, spoken: Spoken[], cued?: boolean) => Promise<Gated>; read?: (trigger: Trigger, spoken: Spoken[]) => Promise<Reading>; consider?: (reading: Reading, requestId?: string) => void;
    /** Context records are numbered after this one: a fork's context already holds its source's. */
    firstRecordId?: number;
  }) {
    this.live = live; this.observer = observer; this.deliver = deliver; this.log = log; this.publish = publish; this.clean = clean; this.audit = audit; this.gate = gate; this.read = read; this.consider = consider;
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
  said(request: SpokenRequest) { return this.clean(request.utterances.filter(u => u.role === 'operator').map(u => u.text).join(' ').replace(/\s+/g, ' ').trim()); }
  /**
   * Each request that reaches the harness is recorded with what GPT Live did and Jev's judgment of whether it needed the
   * harness (the gate's reading, or one made now), and Jev's reading is considered once for a standing instruction and
   * the settings.
   */
  async check(requestId: string, request: SpokenRequest, handOff: HandOff, delegationId: string | null = null, reading?: Reading) {
    const said = this.said(request);
    if (!said) return;
    if (!reading && this.read) reading = await this.read('unsent', this.history.spoken(request.through)).catch(error => { this.log({ type: 'jev.error', message: (error as Error).message }); return undefined; });
    if (reading) this.consider?.(reading, requestId);
    if (!this.audit) return;
    const needsAgent = reading?.needsAgent ?? null;
    this.audit.record({ handOff, said, voiceSessionId: this.live.id, delegationId, requestId }, needsAgent, reading?.transcript);
    this.publish({ type: 'jev_check', requestId, at: Date.now(), kind: 'handoff', words: said, scores: { needsAgent, handOff },
      outcome: typeof needsAgent !== 'number' ? 'Hand-off check failed' : `${{ passed: 'GPT Live passed it on', answered: 'GPT Live kept it; sent when voice ended', escalated: "The voice tool passed it on: the page couldn't do what they meant" }[handOff]}; Jev: ${needsAgent >= .5 ? 'needed the harness' : 'could have been answered'} (${needsAgent.toFixed(2)})` });
  }
  /** The microphone level of the page this voice session listens to. */
  // The operator's held words still going out after a wake count as their talking: GPT Live is hearing them now.
  hear(level: MicrophoneLevel) { if (operatorSpeaking(level) || level.backlogMs! > 0) this.floor.hear(); }
  schedule(fn: () => void, ms: number) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  delegate(delegationId: string, offsetMs: number) {
    if (this.live.state !== 'active') return;
    const request = this.history.request(offsetMs);
    if (!request) {
      this.log({ type: 'bridge.delegation_suppressed', delegationId, reason: 'No new operator speech to send' });
      // Presenting, GPT Live sometimes delegates to move the page its words already moved.
      this.context.add('thinking', Date.now() - this.cueAt < 8000 ? cueNoDelegation : nothingToSend(this.agent), delegationId);
      return;
    }
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', delegationId, text: request.unheard });
    const content = this.clean(voiceRequest(request.utterances, request.notes)), id = randomUUID();
    // Its speech is taken meanwhile, so a later delegation doesn't send it again; it counts as
    // delegated only once the agent has it (delivered).
    this.history.claim(request, id);
    // Words a request already took that went to fdc, or may not have arrived, were judged then.
    if (this.gate && request.fresh) return this.gated(id, request, content, delegationId);
    this.inTurn(() => this.send(id, request, content, delegationId));
  }
  /**
   * Requests reach the agent, and move the page, in the order the operator made them, however long each
   * one's gate takes (a page action or a one-off action can take seconds): while a gate works, later gates
   * and sends wait their turn.
   */
  order: Promise<unknown> = Promise.resolve(); gating = 0;
  inTurn(step: () => unknown) {
    if (!this.gating) { step(); return; }
    this.order = this.order.then(step).catch(error => this.fault(error as Error));
  }
  // The gate reads the request first; one that only turns sessions on or off, or is only about how the
  // companion behaves, is handled by fdc, and GPT Live is told so instead. Its words stay
  // undelegated: they go with the next request, noted, since they may begin what it finishes.
  gated(id: string, request: SpokenRequest, content: string, delegationId: string) {
    const said = this.clean(request.fresh);
    // The gate starts once earlier gates are done: it may move the page, after the moves asked for before.
    const judge = () => this.gate!(said, id, this.history.spoken(request.through), request.cued).catch(error => { this.log({ type: 'gate.error', message: (error as Error).message }); return undefined; });
    this.gating++;
    const done = this.order.then(judge).then(gated => this.afterGate(id, request, content, delegationId, said, gated))
      // Whatever went wrong, the words go with the next request rather than nowhere.
      .catch(error => { this.history.release(id); throw error; })
      .finally(() => { this.gating--; });
    this.order = done.catch(error => this.fault(error as Error));
    return done;
  }
  afterGate(id: string, request: SpokenRequest, content: string, delegationId: string, said: string, gated: Gated | undefined) {
    if (gated?.told && this.live.state === 'active') this.context.add('thinking', gated.told, delegationId);
    if (gated?.handled === undefined) {
      const noted = gated?.note ? this.clean(voiceRequest(request.utterances, [...request.notes ?? [], gated.note])) : content;
      return this.send(id, request, noted, delegationId, gated?.reading);
    }
    this.log({ type: 'bridge.request_handled', id, delegationId, said, companion: gated.companion, page: gated.page });
    this.giveBack(id, handledNote(gated.page ? 'page' : gated.companion ? 'companion' : 'sessions'));
    // Handled here or not, what Jev read is the learner's and the tuner's too (a preference about the companion above all).
    if (gated.reading) this.consider?.(gated.reading, id);
    if (this.live.state === 'active') this.context.add('thinking', gated.handled, delegationId);
  }
  /**
   * fdc passes the operator's latest words on itself, with a note on why: the page can't do what they mean (they were
   * unhappy with it, or its controls failed). A delegation GPT Live makes for them afterwards finds them taken. False
   * when nothing is unsent.
   */
  escalate(note: string) {
    const request = this.live.state === 'active' ? this.history.request(Infinity) : undefined;
    if (!request) return false;
    const id = randomUUID();
    this.history.claim(request, id);
    this.inTurn(() => this.send(id, request, this.clean(voiceRequest(request.utterances, [...request.notes ?? [], note])), null, undefined, 'escalated'));
    return true;
  }
  send(id: string, request: SpokenRequest, content: string, delegationId: string | null, reading?: Reading, handOff: HandOff = 'passed') {
    try {
      this.deliver({ id, content, delegationId, voiceSessionId: this.live.id, queuedAt: Date.now() });
      this.check(id, request, handOff, delegationId, reading).catch(error => this.fault(error as Error));
    } catch (error) {
      this.history.release(id);
      this.fault(error as Error);
      this.context.add('thinking', queueFailed(this.agent), delegationId);
    }
  }
  /** The agent received request `id`: its speech is delegated. */
  delivered(id: string) { this.history.commit(id); }
  /** Request `id`'s delivery was uncertain: its speech goes again with the next request. */
  undelivered(id: string) {
    // A hand-off whose delivery is uncertain is not sent again by itself: the outbox shows it.
    if (this.history.release(id, uncertainNote) && this.ended) this.log({ type: 'bridge.undelivered_after_voice', id });
  }
  // Speech a request took that didn't reach the agent; after voice ended, it goes to the agent now.
  giveBack(id: string, note: string) {
    if (this.history.release(id, note) && this.ended) this.handOff(this.ended);
  }
  // When the voice session ends, speech not yet passed on goes to the agent anyway, marked as such.
  handOff(reason: string) {
    this.ended = reason;
    const request = this.history.request(Infinity);
    if (!request) return;
    const id = randomUUID();
    this.history.claim(request, id);
    this.inTurn(() => {
      try {
        this.deliver({ id, content: this.clean(sessionEndRequest(reason, request.utterances, request.notes)), delegationId: null, voiceSessionId: this.live.id, queuedAt: Date.now() });
        this.log({ type: 'bridge.session_end_handoff', id, reason, utterances: request.utterances.length });
        this.check(id, request, 'answered').catch(error => this.fault(error as Error));
      } catch (error) { this.history.release(id); this.fault(error as Error); }
    });
  }
  /**
   * The connection is done. Only a reason ends voice for its speech (later releases then go to the agent); a dropped
   * or moved connection's speech is carried to the one replacing it, which decides where it goes.
   */
  stop(reason?: string) {
    if (reason) this.ended ??= reason;
    this.feed.stop(); this.context.stop(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}

