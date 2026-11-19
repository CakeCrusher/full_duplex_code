import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Observation, VoiceRequest } from './adapter.ts';
import type { AgentObserver, ObservedAgent } from './agent-observer.ts';
import { ContextQueue, type ContextSink } from './context-queue.ts';
import { phantom, VoiceHistory, type Spoken, type SpokenRequest } from './voice-history.ts';
import { ObservationFeed, type Hold } from './observation-feed.ts';
import { Floor, operatorSpeaking, operatorVoice, type MicrophoneLevel } from './floor.ts';
import { LIVE_SPEECH_RMS } from './activity.ts';
import { DEFAULT_TUNING, holdOf, type Tuning } from './tuning.ts';
import type { DelegationAudit, HandOff } from './delegation-audit.ts';
import type { Reading, Trigger } from './jev.ts';
import type { Did, Early, Waiting } from './turn.ts';
import type { StageView } from './stage.ts';
import { askedNoDelegation, askNoted, cueNoDelegation, heldNote, instructedNote, nothingToSend, queueFailed, sessionEndRequest, turnOutcome, uncertainNote, voiceRequest, recordRequest } from './prompts.ts';

/** What the voice tool made of the operator's turn (turn.ts): Jev's reading, whether their words go to the agent, and what it did itself. */
export interface Decision {
  reading?: Reading;
  /** Their words go to the agent. */
  send: boolean;
  /** They can wait for the end of the turn the agent is running (turn.ts): fdc holds them until then. */
  later?: boolean;
  /** For the agent, with their words: what the voice tool did already, or what failed. Words kept carry it to the next request. */
  note?: string;
  /** For GPT Live: what the voice tool did or found (the page tells it its own news). */
  told?: string;
  /** Not decided: the operator hasn't finished saying it, and the next quiet's request reads it again with what they add. */
  wait?: boolean;
  /** Waiting words a reading found to need the agent: they go to it, whatever a later reading of the whole stretch finds. */
  needed?: boolean;
  /** What the voice tool did on the page for them, when the quiet's request was the first to read it for these words (turn.ts). */
  did?: Did;
  /** Kept, and never to go by themselves: the voice tool did what they asked on the page, or the operator's instructions keep them from the agent (withheld). */
  settled?: boolean; withheld?: boolean;
}

/**
 * The voice tool's requests (turn.ts). The operator's turn, the same request twice: as GPT Live begins to answer, for
 * the page (page); and once the conversation has gone quiet, for everything else, with all GPT Live said in reply and
 * what ran on the page since their words began at `since` (quiet). And when only GPT Live spoke: whether what it said
 * leaves something with the agent (voice).
 */
export interface Route {
  page: (request: SpokenRequest, spoken: Spoken[], waiting?: Waiting & { reply?: string }) => Promise<{ view?: StageView; did?: Did }>;
  quiet: (request: SpokenRequest, spoken: Spoken[], reply: string | undefined, since: number, early: Early, waiting?: Waiting) => Promise<Decision>;
  voice: (spoken: Spoken[], waiting?: Waiting) => Promise<Decision>;
}

// What GPT Live says while the operator only pauses ("Mm-hmm", "Go on"): no answer, so not the end of their turn.
// "'Kay" is one too: GPT Live said it while the operator paused mid-sentence, which ended their turn on ". I" (Nov 18).
const BACKCHANNEL = new Set(['mm', 'mmm', 'mhm', 'hm', 'hmm', 'uh', 'huh', 'um', 'ah', 'oh', 'okay', 'ok', 'kay', "'kay", 'yeah', 'yes', 'yep', 'right', 'sure', 'alright', 'go', 'on', 'ahead', 'i', 'see', 'got', 'it', 'so']);
/** Whether GPT Live's words so far answer anything: a whole word beyond a backchannel. */
const answers = (said: string) => (said.toLowerCase().match(/[a-z']+(?=[^a-z'])/g) ?? []).some(word => !BACKCHANNEL.has(word));
/** The part of a Live session the mediator uses. */
export interface MediatedLive extends ContextSink, Pick<EventEmitter, 'on' | 'off'> {
  id?: string;
  startedAt?: number;
  close(reason?: string): unknown;
}

// Wires one voice session: agent observations become Live context, and what is said becomes requests to the agent. With
// Jev, the operator's turn is read twice (turn.ts): as GPT Live begins to answer, for what the voice tool does on the
// page; and once the conversation has gone quiet (neither side speaking for quietMs), for everything else: what the
// voice tool does itself (sessions, how the companion behaves), and whether their words need the agent, which then gets
// them. What GPT Live says when the operator has said nothing new is read at the quiet too: it gets something from the
// agent by saying what the agent should do. Without Jev, GPT Live decides, and its delegations send the operator's words.
/** The conversation record a request is cut from (perceived.ts), and the session's place in it (forks.ts). */
export interface Conversation { text(from: number, until: number): string; cursor(): number; move(at: number, back?: boolean): void }

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
  /** The voice tool acting on the operator's turn (turn.ts), when Jev is configured: what it does itself, and then whether their words go to the agent. */
  route?: Route;
  /** Jev's reading of words that reach the harness without the gate's (voice ended, or the voice tool sent them); its record (jev-audit.ts) says which request took them and how. */
  read?: (trigger: Trigger, spoken: Spoken[], record?: { requestId: string; handOff: HandOff }) => Promise<Reading>;
  /** What Jev read in a request, for the learner and the tuner: each reading once. */
  consider?: (reading: Reading, requestId?: string) => void;
  /** The operator's last word (fragment) the page was read for, as GPT Live began to answer; the last the quiet's request read; and, without Jev, the last GPT Live's asking sent. */
  pageRead = -1; quietRead = -1; passed = -1;
  /** GPT Live's asks to pass words on since the quiet's last request: the latest is answered with what came of them. */
  asks: string[] = [];
  /** The quiet's last decision, and the operator's last word it read: GPT Live asking about those words afterwards hears it. */
  lastDecision?: { last: number; decision: Decision };
  /** The page as the turn's first request read it, for the quiet's. */
  view?: StageView;
  /** GPT Live's answer so far and when it last spoke, and whether it has begun answering. */
  answer = ''; answerAt = 0; answering = false;
  /** What GPT Live said lately, as it said it, numbered: its reply to the operator's turn, and its own words when they said nothing; and through which a request has read them. */
  voiceSaid: { at: number; text: string; seq: number }[] = []; voiceSeq = 0; voiceRead = 0;
  /**
   * The conversation is quiet once neither side has spoken for quietMs (the setting, tuning.ts): then what was said is
   * decided (quiet). The operator's rule (Nov 18): "until the voice companion stops, until neither the person nor the
   * voice companion is talking for x amount of time". Until then the decision came once the reply said ten words past
   * its acknowledgments at a sentence's end or paused 0.9 s, at most 6 s after the turn was read: a median of 7 words
   * of the reply, which missed what the companion went on to say, and the operator's turn ended after 4 s of their own
   * quiet when GPT Live didn't answer. Either side's transcript counts as speaking, GPT Live's audio, and the
   * operator's voice in the microphone while a transcript is recent (HEARD_MS: a voice GPT Live transcribes nothing
   * of, a video or other people, is not the conversation).
   */
  quietMs: number; quietTimer?: NodeJS.Timeout; spokeAt = 0; transcriptAt = 0;
  static HEARD_MS = 4000;
  /**
   * Words the operator hasn't finished saying wait undecided (they are read again, with what they add, at the next
   * quiet). They go to the agent anyway once the conversation stays quiet for HELD_QUIET_MS (neither the
   * operator nor GPT Live speaking: they have stopped, not paused), or at the next reading that finds they need the agent
   * once they have waited HELD_CAP_MS (finished or not: they went on to other things). On the labeled training sessions,
   * after a turn ended in the middle of a request the operator spoke again within 10 s of it in 90% of cases, 15 s in 92%;
   * the quiet waits about 15 s past the turn's end.
   */
  static HELD_QUIET_MS = 12000; static HELD_CAP_MS = 20000;
  heldQuietMs = Mediator.HELD_QUIET_MS; heldCapMs = Mediator.HELD_CAP_MS; heldTimer?: NodeJS.Timeout; heldAt = 0;
  /** The job delegation: the operator's last word it decided on (what they say after it and before the latest words still waits, and is read with them as all they are saying), since when words wait undecided, and whether a reading found they need the agent. */
  jobRead = -1; undecidedSince = 0; undecidedNeeded = false;
  /** The request that last went to the agent from this connection: when, and the operator's words in it (turn.ts asks whether words right after it add to it). */
  lastSent?: { at: number; said: string; id: string };
  replays: boolean;
  /**
   * The conversation record (perceived.ts) a request is cut from, the one Jev reads and the voice was given: its text from
   * the session's place (forks.ts, cursors) to now, and moving that place. Without it (tests), the speech alone.
   */
  conversation?: Conversation;
  /** Where each request on its way was cut from: a request that doesn't arrive puts the place back. */
  cutFrom = new Map<string, number>();
  onObservation: (event: Observation) => void;
  onLive: (event: any) => void;
  constructor({ live, observer, deliver, log, publish, clean, agent = observer.agent, tuning = DEFAULT_TUNING, hold, audit, route, read, consider, firstRecordId = 0, replays = false, conversation }: {
    live: MediatedLive; observer: AgentObserver; deliver: (request: VoiceRequest) => void; log: (event: Record<string, unknown>) => void;
    publish: (event: Record<string, unknown>) => void; clean: (text: string) => string; agent?: ObservedAgent; tuning?: Tuning; hold?: Hold | null; audit?: DelegationAudit;
    route?: Route; read?: Mediator['read']; consider?: (reading: Reading, requestId?: string) => void;
    /** Context records are numbered after this one: a fork's context already holds its source's. */
    firstRecordId?: number;
    /** The connection begins with the operator's held words: their voice woke it from Standby, and the page replays them to it. */
    replays?: boolean;
    conversation?: Conversation;
  }) {
    this.conversation = conversation;
    this.live = live; this.observer = observer; this.deliver = deliver; this.log = log; this.publish = publish; this.clean = clean; this.audit = audit; this.route = route; this.read = read; this.consider = consider;
    this.agent = agent; this.replays = replays; this.quietMs = tuning.quietMs;
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
  /** The agent session the voice hears from now: a fork's work while it is in focus, the main session's otherwise (forks.ts). */
  observe(observer: AgentObserver) { if (observer === this.observer) return; this.observer.off('observation', this.onObservation); this.observer = observer; observer.on('observation', this.onObservation); }
  /** New settings take effect at once: the floor, the hold and the compaction threshold. */
  applyTuning(tuning: Tuning) {
    Object.assign(this.floor, { thinkMs: tuning.thinkMs, pauseMs: tuning.pauseMs });
    if (this.feed.hold) this.feed.hold = holdOf(tuning);
    this.feed.compactTokens = tuning.compactTokens; this.context.holdMs = tuning.holdLongestMs; this.quietMs = tuning.quietMs;
  }
  fault(error: Error) { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: error.message }); }
  liveEvent(event: any) {
    // A connection the operator's voice woke begins with their held words: they have the floor from its start. The floor
    // had not heard them on this connection, so what waited for the start (the page, their goal, the agent's work) went
    // in as the replay began, and GPT Live spoke over their words: in 52 of the 112 such wakes of Nov 1 to 12, against 3
    // of the 26 where nothing was sent meanwhile.
    // Words carried from a connection that dropped are read at this one's first quiet, whoever speaks first.
    if (event.type === 'session.started') { if (this.replays) this.floor.hear(); this.feed.flush(); this.context.pump(); if (this.history.request()?.fresh) this.spoke(); }
    if (event.type === 'session.input_audio.append' && typeof event.audio === 'string') this.history.hearAudio(event);
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event);
      this.publish({ type: 'caption', ...fragment, voiceSessionId: this.live.id, voiceStartedAt: this.live.startedAt });
    }
    // GPT Live starting its answer, or asking to pass the operator's words on, is the moment the page is read for what
    // they ask of it (early). Either side's words keep the conversation going: it is decided once it goes quiet (spoke).
    if (event.type === 'session.input_transcript.delta' && String(event.delta ?? '').trim() && !phantom(String(event.delta))) { this.floor.hear(); this.transcriptAt = Date.now(); this.spoke(); }
    if (event.type === 'session.output_transcript.delta') this.answered(String(event.delta ?? ''));
    if (event.type === 'session.delegation.created' && event.delegation?.target === 'client' && !this.seenDelegations.has(event.delegation.id)) {
      this.seenDelegations.add(event.delegation.id);
      this.spoke(); this.turnEnded(event.delegation.id);
    }
  }
  /** Either side spoke: the conversation is quiet once neither has for quietMs. */
  spoke() {
    this.spokeAt = Date.now();
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.quiet(), this.quietMs);
    this.quietTimer.unref?.();
  }
  /** GPT Live said more: a whole word beyond a backchannel starts its answer ("Mm-hmm" while they pause doesn't). */
  answered(delta: string) {
    const now = Date.now();
    this.voiceSaid.push({ at: now, text: delta, seq: ++this.voiceSeq });
    while (this.voiceSaid.length && now - this.voiceSaid[0].at > 60000) this.voiceSaid.shift();
    if (now - this.answerAt > 1500) { this.answer = ''; this.answering = false; }
    this.answerAt = this.transcriptAt = now; this.answer = (this.answer + delta).slice(-300);
    this.spoke();
    if (!this.answering && answers(this.answer)) { this.answering = true; this.turnEnded(); }
  }
  /** GPT Live began to answer, or asked to pass the operator's words on: once the transcript of their last words is in (it can trail GPT Live's answer), the page is read for them. */
  turnEnded(delegationId?: string) {
    const ended = Date.now();
    const attempt = () => { if (Date.now() - this.history.lastInputAt < 450 && Date.now() - ended < 3000) this.schedule(attempt, 200); else this.early(delegationId); };
    attempt();
  }
  /** The operator's last word: not a piece that is no speech of theirs, after which the words before it were read again. */
  lastWord() { return this.history.fragments.findLast(f => f.role === 'operator' && !this.history.unheard(f))?.seq ?? -1; }
  /**
   * The operator's words since `since` (the last word a request of this kind read) as Jev is given them: their latest
   * words, all of theirs since then (a page command never runs twice for the same words, an instruction is learned
   * once); and, when words before those still wait undecided (they hadn't finished), all they are saying, which the
   * questions about what goes to the agent read: judged apart, a request made in pieces was read as fragments.
   */
  words(request: SpokenRequest, since: number) {
    const spoken = this.history.spoken(request.through, since), latest = spoken.at(-1);
    const whole = this.jobRead < since ? this.history.spoken(request.through, this.jobRead).at(-1) : undefined;
    return { spoken, from: latest?.at ?? this.history.lastInputAt, saying: whole?.role === 'operator' && whole.text !== latest?.text ? whole.text : undefined };
  }
  /** The request that last went to the agent from this connection, as a reading is told of it. */
  sent() { return this.lastSent && { ago: Date.now() - this.lastSent.at, said: this.lastSent.said, id: this.lastSent.id }; }
  /**
   * The operator's turn is under way and GPT Live has begun to answer, or asked to pass their words on. With Jev, the
   * page is read now for what they ask of it (turn.ts, pageTurn), in the order they asked, and GPT Live's asking sends
   * nothing: it is answered at once, and its reply is read whole at the quiet (the operator's rule, Nov 17: its
   * delegation is one more signal; OpenAI's API has no way to turn it off, and it asks without being told to: 628 times
   * from Nov 1 to 13, of which Jev turned down 324). Without Jev, GPT Live decides, and its asking sends their words.
   */
  early(delegationId?: string) {
    if (this.live.state !== 'active') return;
    const route = this.route;
    if (!route) { if (delegationId) this.passOn(delegationId); return; }
    const last = this.lastWord();
    // Asking about words the quiet has decided already: it hears what came of them.
    if (delegationId && this.lastDecision?.last === last) return this.outcome(delegationId, this.lastDecision.decision);
    if (delegationId) { this.context.add('thinking', askNoted(this.agent), delegationId); this.asks.push(delegationId); }
    if (last === this.pageRead) return;
    const request = this.history.request();
    if (!request?.fresh) return;
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', delegationId, text: request.unheard });
    request.id = randomUUID();
    const { spoken, from, saying } = this.words(request, this.pageRead);
    this.pageRead = last; this.pending++;
    this.actionsOrder = this.actionsOrder.then(() => route.page(request, spoken, { ...saying && { saying }, needed: this.undecidedNeeded, sent: this.sent(), reply: this.replied(from) }))
      .then(done => {
        this.view = done.view;
        // What it did on the page answers the operator: GPT Live hears it without waiting for them to finish.
        if (done.did && this.live.state === 'active') this.context.add('thinking', done.did.told, null, '', Date.now(), true);
      }).catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); })
      .finally(() => { this.pending--; });
  }
  /** Without Jev, GPT Live's asking sends the operator's words that no request took yet; asked again for words it sent, it hears so. */
  passOn(delegationId: string) {
    const last = this.lastWord();
    if (last === this.passed) return this.outcome(delegationId, { send: true });
    const request = this.history.request();
    if (!request?.fresh) return this.outcome(delegationId);
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', delegationId, text: request.unheard });
    this.passed = last;
    this.send(randomUUID(), [], delegationId);
  }
  /**
   * The conversation has gone quiet. What was said since the last reading is decided by one request, after any under
   * way and in the order things were said: the operator's turn, whole, with all GPT Live said in reply (decideTurn); or,
   * when they said nothing new, what GPT Live said (decideVoice). Someone speaking before it is read puts it off to the
   * next quiet.
   */
  quiet() {
    if (!this.route || this.live.state !== 'active') return;
    this.pending++;
    this.order = Promise.all([this.actionsOrder, this.order]).then(async () => {
      if (this.live.state !== 'active' || Date.now() - this.spokeAt < this.quietMs) return;
      const last = this.lastWord(), request = last > this.quietRead ? this.history.request() : null;
      if (request?.fresh) await this.decideTurn(request, last); else await this.decideVoice();
    }).catch(error => this.fault(error as Error)).finally(() => { this.pending--; });
  }
  /**
   * The operator's turn at the quiet: the voice tool does what is its own to do and their words go to the agent, wait
   * for them to finish, or stay with the voice (turn.ts, quietTurn). Jev failing, they go to the agent: keeping work
   * from it is the costly mistake. The learner and the tuner take this reading.
   */
  async decideTurn(request: SpokenRequest, last: number) {
    const id = request.id = randomUUID(), { spoken, from, saying } = this.words(request, this.quietRead);
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', text: request.unheard });
    // The page as the request made as GPT Live began to answer read it, for these words only: otherwise it is read afresh.
    const overdue = Boolean(this.undecidedSince) && Date.now() - this.undecidedSince >= this.heldCapMs, read = this.pageRead === last, early = { view: read ? this.view : undefined, read };
    this.quietRead = this.pageRead = last; this.voiceRead = this.voiceSeq;
    const decision = await this.route!.quiet(request, spoken, this.replied(from), from, early, { ...saying && { saying }, needed: this.undecidedNeeded, overdue, sent: this.sent() })
      .catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); return { send: true } as Decision; });
    if (decision.did && this.live.state === 'active') this.context.add('thinking', decision.did.told, null, '', Date.now(), true);
    if (decision.reading) this.consider?.(decision.reading, id);
    // GPT Live asked to pass these words on: it hears what came of them, as the answer to its latest asking.
    this.lastDecision = { last, decision };
    this.decided(id, request, decision, this.asks.splice(0).at(-1));
  }
  /**
   * Only GPT Live spoke since the last reading: whether what it said leaves something with the agent (turn.ts,
   * voiceTurn). It then goes with the conversation since the last request, the operator's words that stayed with the
   * voice among it. Jev failing, nothing goes: nothing of the operator's is lost by it.
   */
  async decideVoice() {
    const spoken = this.history.spoken(Infinity, undefined, true), latest = spoken.at(-1);
    if (latest?.role !== 'intermediary' || this.voiceSeq <= this.voiceRead) return;
    this.voiceRead = this.voiceSeq;
    const decision = await this.route!.voice(spoken, { sent: this.sent() }).catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); return undefined; });
    if (decision?.send) this.send(randomUUID(), decision.note ? [decision.note] : [], null, decision.reading, 'own', false, latest.text);
  }
  /** What GPT Live has said since `from`, so far. */
  replied(from: number) { return this.voiceSaid.filter(d => d.at >= from).map(d => d.text).join('').replace(/\s+/g, ' ').trim() || undefined; }
  /**
   * What came of a turn: the words go to the agent, noted with what the voice tool did; or they stay for the next request,
   * noted with it. GPT Live hears what the voice tool did, and, when it asked to pass them on (`asked`), what came of
   * them: that they went (as the request goes), that they wait for the operator to finish, or that nothing went and why.
   */
  decided(id: string, request: SpokenRequest, decision: Decision, asked?: string) {
    const { reading, send, later, note, told, wait, needed, settled } = decision;
    if (told && this.live.state === 'active') this.context.add('thinking', told, null);
    // Sent, or kept as needing nothing: what waits for the job delegation starts after these words. Not finished: they wait for the next quiet.
    if (wait) { this.undecidedSince ||= Date.now(); this.undecidedNeeded ||= Boolean(needed); this.awaitQuiet(); }
    else { this.jobRead = Math.max(this.jobRead, request.through); this.undecidedSince = 0; this.undecidedNeeded = false; clearTimeout(this.heldTimer); }
    if (send) return this.send(id, note ? [note] : [], asked ?? null, reading, 'passed', later);
    if (asked && !told) this.outcome(asked, decision);
    this.log({ type: 'turn.kept', id, said: this.said(request).slice(-200), needsAgent: reading?.needsAgent ?? null, handled: Boolean(note), ...wait && { waiting: true } });
    this.audit?.record({ handOff: 'kept', said: this.said(request), voiceSessionId: this.live.id, delegationId: null, requestId: id, jevCall: reading?.id }, reading?.needsAgent ?? null, reading?.transcript);
    // Kept: they go with the next request, with what the voice tool did with them; after voice ended, they go now.
    // Settled (done on the page, or kept from the agent by the operator's instructions), they never go by themselves, at
    // the voice's end either: they are context for the next request, in the conversation it is cut from.
    if (settled) this.history.markDelivered(request);
    else if (note) this.history.note(request.through, note);
    if (this.ended) this.handOff(this.ended);
  }
  /** Words the job delegation put off because the operator hadn't finished, that no request has taken yet. */
  undecided() { return this.undecidedSince > 0 && this.history.fragments.some(f => f.role === 'operator' && f.seq > this.jobRead && !f.sent && !f.claim); }
  /**
   * Words waiting undecided go to the agent once the conversation has been quiet for heldQuietMs: by then the operator has
   * stopped rather than paused. Their next words, if they come first, are read with the waiting ones instead.
   */
  awaitQuiet() {
    clearTimeout(this.heldTimer);
    this.heldAt = Date.now();
    const check = () => {
      // Once they speak again, the next quiet reads the waiting words with the new ones (and waits again, if so).
      if (this.live.state !== 'active' || !this.undecided() || this.history.lastInputAt > this.heldAt) return;
      const quiet = Date.now() - Math.max(this.history.lastInputAt, this.answerAt);
      if (quiet < this.heldQuietMs || this.pending) { this.heldTimer = setTimeout(check, Math.max(200, this.heldQuietMs - quiet)); this.heldTimer.unref?.(); return; }
      this.sendHeld();
    };
    this.heldTimer = setTimeout(check, this.heldQuietMs);
    this.heldTimer.unref?.();
  }
  /** The operator stopped partway and said no more: what they said since the last request goes to the agent, noted as such. */
  sendHeld() {
    clearTimeout(this.heldTimer);
    if (!this.undecided()) return;
    const request = this.history.request();
    if (!request) return;
    const id = randomUUID(), seconds = Math.round((Date.now() - this.history.lastInputAt) / 1000);
    this.jobRead = Math.max(this.jobRead, request.through); this.undecidedSince = 0; this.undecidedNeeded = false;
    this.log({ type: 'turn.held_sent', id, seconds, said: this.said(request).slice(-200) });
    this.inTurn(() => this.send(id, [heldNote(seconds)], null, undefined, 'held'));
  }
  /** GPT Live asked to pass words on: what came of them (nothing new to send, sent, waiting, or kept and why), told to it as the answer to its asking. */
  outcome(delegationId: string, decision?: Decision) {
    if (this.live.state !== 'active') return;
    // Presenting, GPT Live sometimes asks to pass on words its own words already moved the page for. What the voice tool
    // did on the page it was told as it was done: it hears only that nothing is left to pass on.
    const text = !decision ? (Date.now() - this.cueAt < 8000 ? cueNoDelegation : nothingToSend(this.agent))
      : decision.told ?? (decision.send || decision.wait ? turnOutcome(this.agent, decision) : decision.did || (decision.settled && !decision.withheld) ? askedNoDelegation : decision.withheld ? instructedNote(this.agent) : turnOutcome(this.agent, decision));
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
    // Words that reach the harness without a turn's reading (voice ended) are read now, and the learner and the tuner take
    // that reading; a turn's own were taken from the voice tool's reading of it.
    if (!reading && this.read) {
      reading = await this.read('unsent', this.history.spoken(request.through), { requestId, handOff }).catch(error => { this.log({ type: 'jev.error', message: (error as Error).message }); return undefined; });
      if (reading) this.consider?.(reading, requestId);
    }
    if (!this.audit) return;
    const needsAgent = reading?.needsAgent ?? null;
    this.audit.record({ handOff, said, voiceSessionId: this.live.id, delegationId, requestId, jevCall: reading?.id }, needsAgent, reading?.transcript);
    this.publish({ type: 'jev_check', requestId, at: Date.now(), kind: 'handoff', words: said, scores: { needsAgent, handOff },
      outcome: typeof needsAgent !== 'number' ? 'Hand-off check failed' : `${{ passed: this.route ? 'Jev passed it on' : 'GPT Live passed it on', kept: 'Kept', answered: 'Kept; sent when voice ended', held: "Waited for the operator to finish; sent once they stayed quiet", own: 'The companion asked for it' }[handOff]}; Jev: ${needsAgent >= .5 ? 'needed the harness' : 'could have been answered'} (${needsAgent.toFixed(2)})` });
  }
  /**
   * The levels of the page this voice session listens to: its microphone and what it plays. The operator's held words
   * still going out after a wake count as their talking (GPT Live is hearing them now); their voice in the microphone
   * and GPT Live's audio keep the conversation from being quiet (spoke).
   */
  hear(level: MicrophoneLevel & { outputRms?: number }) {
    const held = level.backlogMs! > 0;
    if (operatorSpeaking(level) || held) this.floor.hear();
    if (held || (level.outputRms ?? 0) >= LIVE_SPEECH_RMS || (operatorVoice(level) && Date.now() - this.transcriptAt < Mediator.HEARD_MS)) this.spoke();
  }
  schedule(fn: () => void, ms: number) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  /** Sends that come without a reading (voice ended) wait their turn behind the readings under way, in the order the operator spoke. */
  order: Promise<unknown> = Promise.resolve(); actionsOrder: Promise<unknown> = Promise.resolve(); pending = 0;
  inTurn(step: () => unknown) {
    if (!this.pending) { step(); return; }
    this.order = this.order.then(step).catch(error => this.fault(error as Error));
  }
  /**
   * Sends what the operator and the voice said from the cursor to the latest words, in the order said, whichever
   * decision sends it: words an earlier turn kept go with it, before the words that follow them, and words a request on its
   * way took go with none other. Nothing left to send (a request on its way took them all): GPT Live, if it asked, hears so.
   * What GPT Live itself said the agent should do (`own`, its words) goes the same way, with or without words of the
   * operator's since the last request.
   */
  send(id: string, notes: readonly string[], delegationId: string | null, reading?: Reading, handOff: HandOff = 'passed', followUp = false, own?: string) {
    const request = this.history.request();
    if (!request && !own) { if (delegationId) this.outcome(delegationId, { send: true }); return; }
    if (request) { this.history.claim(request, id); this.jobRead = Math.max(this.jobRead, request.through); }
    try {
      const now = Date.now(), from = this.conversation?.cursor(), allNotes = [...request?.notes ?? [], ...notes], utterances = [...request?.utterances ?? [], ...own ? [{ role: 'intermediary' as const, text: own }] : []];
      const said = own ?? this.said(request!), content = this.clean(this.conversation ? recordRequest(this.conversation.text(from!, now), allNotes) : voiceRequest(utterances, allNotes));
      // The next request starts just before this one ended: a line heard in the same millisecond after it was cut comes
      // with the next, never with neither (at worst one line twice).
      if (this.conversation) { this.cutFrom.set(id, from!); this.conversation.move(now - .5); }
      this.deliver({ id, content, delegationId, voiceSessionId: this.live.id, queuedAt: Date.now(), said, ...followUp && { followUp }, ...own && { own: true } });
      this.lastSent = { at: Date.now(), said, id };
      if (!own) this.check(id, request!, handOff, delegationId, reading).catch(error => this.fault(error as Error));
      else { this.log({ type: 'turn.own_sent', id, said: said.slice(-200) }); this.audit?.record({ handOff, said, voiceSessionId: this.live.id, delegationId, requestId: id, jevCall: reading?.id }, reading?.needsAgent ?? null, reading?.transcript); }
    } catch (error) {
      if (request) this.history.release(id);
      this.fault(error as Error);
      this.context.add('thinking', queueFailed(this.agent), delegationId);
    }
  }
  /** The agent received request `id`: its speech is delegated. */
  delivered(id: string) { this.history.commit(id); }
  /** Request `id`'s delivery was uncertain: its speech goes again with the next request. */
  undelivered(id: string) {
    const from = this.cutFrom.get(id); if (from !== undefined) this.conversation?.move(from, true);
    // A hand-off whose delivery is uncertain is not sent again by itself: the outbox shows it.
    if (this.history.release(id, uncertainNote) && this.ended) this.log({ type: 'bridge.undelivered_after_voice', id });
  }
  // When the voice session ends, speech not yet passed on goes to the agent anyway, marked as such.
  handOff(reason: string) {
    this.ended = reason;
    if (!this.history.request()) return;
    // After the decisions under way, which may send these words themselves: what is left then goes, from the cursor to the latest words.
    this.inTurn(() => {
      const request = this.history.request();
      if (!request) return;
      const id = randomUUID();
      this.history.claim(request, id);
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
    this.feed.stop(); this.context.stop(); clearTimeout(this.quietTimer); clearTimeout(this.heldTimer); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}

