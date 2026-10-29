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
import { cueNoDelegation, nothingToSend, queueFailed, sessionEndRequest, turnOutcome, uncertainNote, voiceRequest } from './prompts.ts';

/** What the voice tool made of the operator's turn (turn.ts): Jev's reading, whether their words go to the agent, and what it did itself. */
export interface Decision {
  reading?: Reading;
  /** Their words go to the agent. */
  send: boolean;
  /** For the agent, with their words: what the voice tool did already, or what failed. Words kept carry it to the next request. */
  note?: string;
  /** For GPT Live: what the voice tool did or found (the page tells it its own news). */
  told?: string;
  /** The page moved for their words: GPT Live's own words in its answer don't move it again. */
  moved?: boolean;
  /** Sent although Jev found nothing for the agent: the page failed or fell short, which the agent fixes. */
  escalated?: boolean;
}

// What GPT Live says while the operator only pauses ("Mm-hmm", "Go on"): no answer, so not the end of their turn.
const BACKCHANNEL = new Set(['mm', 'mmm', 'mhm', 'hm', 'hmm', 'uh', 'huh', 'um', 'ah', 'oh', 'okay', 'ok', 'yeah', 'yes', 'yep', 'right', 'sure', 'alright', 'go', 'on', 'ahead', 'i', 'see', 'got', 'it', 'so']);
/** Whether GPT Live's words so far answer anything: a whole word beyond a backchannel. */
const answers = (said: string) => (said.toLowerCase().match(/[a-z']+(?=[^a-z'])/g) ?? []).some(word => !BACKCHANNEL.has(word));

/** The part of a Live session the mediator uses. */
export interface MediatedLive extends ContextSink, Pick<EventEmitter, 'on' | 'off'> {
  id?: string;
  startedAt?: number;
  close(reason?: string): unknown;
}

// Wires one voice session: agent observations become Live context, and the operator's turns become requests to the
// agent. With Jev, each turn is read once as it ends and what needs the agent goes to it (turn.ts); without, GPT Live
// decides, and its delegations send the operator's words.
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
  /** Records each turn's words with what came of them and Jev's judgment, when Jev is configured. Sends nothing. */
  audit?: DelegationAudit;
  /** The voice tool acting on the operator's turn (turn.ts), when Jev is configured: what it did, and whether their words go to the agent. */
  route?: (request: SpokenRequest, spoken: Spoken[], why: Trigger) => Promise<Decision>;
  /** Jev's reading of words that reach the harness without the gate's (voice ended, or the voice tool sent them). */
  read?: (trigger: Trigger, spoken: Spoken[]) => Promise<Reading>;
  /** What Jev read in a request, for the learner and the tuner: each reading once. */
  consider?: (reading: Reading, requestId?: string) => void;
  /** The operator's latest turn: its last word (fragment), when it was read, and what came of it. */
  turn?: { last: number; at: number; done: Promise<Decision | undefined> };
  /** GPT Live's answer so far and when it last spoke, and whether it has begun answering; the wait for the operator's quiet. */
  answer = ''; answerAt = 0; answering = false; quiet?: NodeJS.Timeout;
  /**
   * How long the operator is quiet before their turn has ended, when GPT Live doesn't answer first (a pause mid-sentence is
   * no end: "Take me to … tonight" was read as "Take me to"). At 2.5 s, long requests made in pieces went in pieces more
   * often than at 4 (labeled sessions, Oct 28).
   */
  operatorQuietMs = 4000;
  onObservation: (event: Observation) => void;
  onLive: (event: any) => void;
  constructor({ live, observer, deliver, log, publish, clean, agent = observer.agent, tuning = DEFAULT_TUNING, hold, audit, route, read, consider, firstRecordId = 0 }: {
    live: MediatedLive; observer: AgentObserver; deliver: (request: VoiceRequest) => void; log: (event: Record<string, unknown>) => void;
    publish: (event: Record<string, unknown>) => void; clean: (text: string) => string; agent?: ObservedAgent; tuning?: Tuning; hold?: Hold | null; audit?: DelegationAudit;
    route?: (request: SpokenRequest, spoken: Spoken[], why: Trigger) => Promise<Decision>; read?: (trigger: Trigger, spoken: Spoken[]) => Promise<Reading>; consider?: (reading: Reading, requestId?: string) => void;
    /** Context records are numbered after this one: a fork's context already holds its source's. */
    firstRecordId?: number;
  }) {
    this.live = live; this.observer = observer; this.deliver = deliver; this.log = log; this.publish = publish; this.clean = clean; this.audit = audit; this.route = route; this.read = read; this.consider = consider;
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
    if (event.type === 'session.input_audio.append' && typeof event.audio === 'string') this.history.hearAudio(event);
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event);
      this.publish({ type: 'caption', ...fragment, voiceSessionId: this.live.id, voiceStartedAt: this.live.startedAt });
    }
    // The operator's turn ends when GPT Live starts answering them, after a moment's quiet, or when GPT Live asks to pass
    // their words on. Their transcript also shows they are talking, for pages that send no levels.
    if (event.type === 'session.input_transcript.delta' && String(event.delta ?? '').trim()) { this.floor.hear(); this.listen(); }
    if (event.type === 'session.output_transcript.delta') this.answered(String(event.delta ?? ''));
    if (event.type === 'session.delegation.created' && event.delegation?.target === 'client' && !this.seenDelegations.has(event.delegation.id)) {
      this.seenDelegations.add(event.delegation.id);
      this.turnEnded('delegation', event.delegation.id);
    }
  }
  /** The operator said more: once they have been quiet a moment, their turn has ended. */
  listen() {
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.turnEnded('turn'), this.operatorQuietMs);
    this.quiet.unref?.();
  }
  /** GPT Live said more: a whole word beyond a backchannel starts its answer, which ends the operator's turn ("Mm-hmm" while they pause doesn't). */
  answered(delta: string) {
    if (Date.now() - this.answerAt > 1500) { this.answer = ''; this.answering = false; }
    this.answerAt = Date.now(); this.answer = (this.answer + delta).slice(-300);
    if (!this.answering && answers(this.answer)) { this.answering = true; this.turnEnded('turn'); }
  }
  /** The operator's turn has ended: once the transcript of their last words is in (it can trail GPT Live's answer), their words are read. */
  turnEnded(why: Trigger, delegationId?: string) {
    clearTimeout(this.quiet);
    const ended = Date.now();
    const attempt = () => { if (Date.now() - this.history.lastInputAt < 450 && Date.now() - ended < 3000) this.schedule(attempt, 200); else this.decide(why, delegationId); };
    attempt();
  }
  /**
   * The operator's words no request took yet, read once: with Jev, the voice tool does what it can itself and what needs
   * the agent goes to it (turn.ts); without, GPT Live decides, and only its asking to pass words on sends them. The same
   * words are read again only with more of theirs. Requests reach the agent, and move the page, in the order the operator
   * made them, however long each reading takes.
   */
  decide(why: Trigger, delegationId?: string) {
    if (this.live.state !== 'active') return;
    const last = this.history.fragments.findLast(f => f.role === 'operator')?.seq ?? -1;
    // GPT Live asking to pass on words already read hears what came of them.
    if (this.turn?.last === last) { if (delegationId) void this.turn.done.then(decision => this.outcome(delegationId, decision)); return; }
    if (!this.route && !delegationId) return;
    const request = this.history.request();
    if (!request?.fresh) { if (delegationId) this.outcome(delegationId); return; }
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', delegationId, text: request.unheard });
    // Its speech is taken meanwhile, so a later turn doesn't send it again; it counts as delegated only once the agent has it.
    const id = randomUUID();
    this.history.claim(request, id);
    this.pending++;
    // What Jev reads as their latest words: all of theirs since the last reading.
    const since = this.turn?.last ?? -1;
    const decided = this.order.then(() => this.route ? this.route(request, this.history.spoken(request.through, since), why) : { send: true })
      // Jev failing, the words go to the agent: keeping work from it is the costly mistake.
      .catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); return { send: true } as Decision; });
    const done = decided.then(decision => { this.decided(id, request, decision, delegationId); return decision; })
      // Whatever went wrong, the words go with the next request rather than nowhere.
      .catch(error => { this.history.release(id); this.fault(error as Error); return undefined; })
      .finally(() => { this.pending--; });
    this.turn = { last, at: Date.now(), done };
    this.order = done;
  }
  /** What came of a turn: the words go to the agent, noted with what the voice tool did; or they stay for the next request, noted with it. GPT Live hears what was done. */
  decided(id: string, request: SpokenRequest, { reading, send, note, told, escalated }: Decision, delegationId?: string) {
    if (told && this.live.state === 'active') this.context.add('thinking', told, delegationId ?? null);
    if (send) return this.send(id, request, this.clean(voiceRequest(request.utterances, [...request.notes ?? [], ...note ? [note] : []])), delegationId ?? null, reading, escalated ? 'escalated' : 'passed');
    this.log({ type: 'turn.kept', id, said: this.said(request).slice(-200), needsAgent: reading?.needsAgent ?? null, handled: Boolean(note) });
    if (reading) this.consider?.(reading, id);
    this.audit?.record({ handOff: 'kept', said: this.said(request), voiceSessionId: this.live.id, delegationId: delegationId ?? null, requestId: id }, reading?.needsAgent ?? null, reading?.transcript);
    this.giveBack(id, note);
    if (delegationId && !told) this.outcome(delegationId, { send: false });
  }
  /** GPT Live asked to pass words on: what came of them (nothing new to send, sent, or kept). */
  outcome(delegationId: string, decision?: Decision) {
    if (this.live.state !== 'active') return;
    // Presenting, GPT Live sometimes asks to pass on words its own words already moved the page for.
    const text = !decision ? (Date.now() - this.cueAt < 8000 ? cueNoDelegation : nothingToSend(this.agent)) : decision.told ?? turnOutcome(this.agent, decision);
    this.context.add('thinking', text, delegationId);
  }
  said(request: SpokenRequest) { return this.clean(request.utterances.filter(u => u.role === 'operator').map(u => u.text).join(' ').replace(/\s+/g, ' ').trim()); }
  /**
   * Each request that reaches the harness is recorded with how it got there and Jev's judgment of whether it needed the
   * harness (the turn's reading, or one made now), and Jev's reading is considered once for a standing instruction and
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
      outcome: typeof needsAgent !== 'number' ? 'Hand-off check failed' : `${{ passed: this.route ? 'Jev passed it on' : 'GPT Live passed it on', kept: 'Kept', answered: 'Kept; sent when voice ended', escalated: "The voice tool passed it on: the page couldn't do what they meant" }[handOff]}; Jev: ${needsAgent >= .5 ? 'needed the harness' : 'could have been answered'} (${needsAgent.toFixed(2)})` });
  }
  /** The microphone level of the page this voice session listens to. */
  // The operator's held words still going out after a wake count as their talking: GPT Live is hearing them now.
  hear(level: MicrophoneLevel) { if (operatorSpeaking(level) || level.backlogMs! > 0) this.floor.hear(); }
  schedule(fn: () => void, ms: number) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  /** Sends that come without a reading (voice ended) wait their turn behind the readings under way, in the order the operator spoke. */
  order: Promise<unknown> = Promise.resolve(); pending = 0;
  inTurn(step: () => unknown) {
    if (!this.pending) { step(); return; }
    this.order = this.order.then(step).catch(error => this.fault(error as Error));
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
  giveBack(id: string, note?: string) {
    if (this.history.release(id, note) && this.ended) this.handOff(this.ended);
  }
  // When the voice session ends, speech not yet passed on goes to the agent anyway, marked as such.
  handOff(reason: string) {
    this.ended = reason;
    const request = this.history.request();
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
    this.feed.stop(); this.context.stop(); clearTimeout(this.quiet); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}

