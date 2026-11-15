import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Observation, VoiceRequest } from './adapter.ts';
import type { AgentObserver, ObservedAgent } from './agent-observer.ts';
import { ContextQueue, type ContextSink } from './context-queue.ts';
import { phantom, VoiceHistory, type Spoken, type SpokenRequest } from './voice-history.ts';
import { ObservationFeed, type Hold } from './observation-feed.ts';
import { Floor, operatorSpeaking, type MicrophoneLevel } from './floor.ts';
import { DEFAULT_TUNING, holdOf, type Tuning } from './tuning.ts';
import type { DelegationAudit, HandOff } from './delegation-audit.ts';
import type { Reading, Trigger } from './jev.ts';
import type { Actions, Waiting } from './turn.ts';
import { cueNoDelegation, heldNote, nothingToSend, queueFailed, sessionEndRequest, turnOutcome, uncertainNote, voiceRequest, recordRequest } from './prompts.ts';

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
  /** Not decided: the operator hasn't finished saying it, and the job delegation reads it again with what they add. */
  wait?: boolean;
  /** Waiting words a reading found to need the agent: they go to it, whatever a later reading of the whole stretch finds. */
  needed?: boolean;
  /** What the voice tool did itself first (turn.ts), when both calls were made together. */
  actions?: import('./turn.ts').Actions;
}

/** The voice tool's two readings of a turn (turn.ts): what it does itself, then, with GPT Live's reply, whether the words go to the agent. */
export interface Route {
  actions: (request: SpokenRequest, spoken: Spoken[], why: Trigger) => Promise<Actions>;
  job: (request: SpokenRequest, spoken: Spoken[], reply: string | undefined, actions: Actions, waiting?: Waiting) => Promise<Decision>;
}

// What GPT Live says while the operator only pauses ("Mm-hmm", "Go on"): no answer, so not the end of their turn.
const BACKCHANNEL = new Set(['mm', 'mmm', 'mhm', 'hm', 'hmm', 'uh', 'huh', 'um', 'ah', 'oh', 'okay', 'ok', 'yeah', 'yes', 'yep', 'right', 'sure', 'alright', 'go', 'on', 'ahead', 'i', 'see', 'got', 'it', 'so']);
/** Whether GPT Live's words so far answer anything: a whole word beyond a backchannel. */
const answers = (said: string) => (said.toLowerCase().match(/[a-z']+(?=[^a-z'])/g) ?? []).some(word => !BACKCHANNEL.has(word));
// Words that carry nothing of what GPT Live will do about the operator's words: acknowledgments and the words around them.
const FILLER = new Set("thanks thank one sec second moment hold just let me you it that this the a an to and of is i i'm im i'll ill we we'll its it's there on for be will can now here up".split(' '));
/** How much GPT Live's reply says, past its acknowledgments ("Okay. Hold on." says nothing; "Walking you through the map now" does). */
const substance = (said: string) => (said.toLowerCase().match(/[a-z']+/g) ?? []).filter(word => !BACKCHANNEL.has(word) && !FILLER.has(word)).length;

/** The part of a Live session the mediator uses. */
export interface MediatedLive extends ContextSink, Pick<EventEmitter, 'on' | 'off'> {
  id?: string;
  startedAt?: number;
  close(reason?: string): unknown;
}

// Wires one voice session: agent observations become Live context, and the operator's turns become requests to the
// agent. With Jev, each turn is read twice (turn.ts): as it ends, for what the voice tool does itself (the page, sessions,
// how the companion behaves); and once the companion has replied, for whether their words need the agent, which then
// gets them. Without Jev, GPT Live decides, and its delegations send the operator's words.
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
  /** The operator's latest turn: its last word (fragment), when it was read, and what came of it. */
  turn?: { last: number; at: number; done: Promise<Decision | undefined> };
  /** GPT Live's answer so far and when it last spoke, and whether it has begun answering; the wait for the operator's quiet. */
  answer = ''; answerAt = 0; answering = false; quiet?: NodeJS.Timeout;
  /** What GPT Live said lately, as it said it: its reply to the operator's turn, for the job delegation. */
  voiceSaid: { at: number; text: string }[] = [];
  /**
   * How long the job delegation waits for GPT Live's reply to a turn: until the reply says REPLY_WORDS words past its
   * acknowledgments at a sentence's end, or stops at one for REPLY_PAUSE_MS; at most replyMs after the turn was read, and
   * no longer than replyStartMs if it hasn't begun. Its reply shows what it could answer itself (on the labeled sessions,
   * read about 3 s after the turn: 50 of 79 stretches of talk kept from the agent against 28 without it, a request lost in
   * 25 rather than 33). Until Oct 31 the wait ended with the reply's first sentence, mostly an acknowledgment: a median of
   * 7 words read of 21 said ("Okay. Hold on.", "Got it. Walking"). The page doesn't wait on this reading (presenter.ts).
   */
  static REPLY_MS = 6000; static REPLY_START_MS = 2500; static REPLY_WORDS = 10; static REPLY_PAUSE_MS = 900;
  replyMs = Mediator.REPLY_MS; replyStartMs = Mediator.REPLY_START_MS; replyPauseMs = Mediator.REPLY_PAUSE_MS;
  /**
   * How long the operator is quiet before their turn has ended, when GPT Live doesn't answer first (a pause mid-sentence is
   * no end: "Take me to … tonight" was read as "Take me to"). At 2.5 s, long requests made in pieces went in pieces more
   * often than at 4 (labeled sessions, Oct 28).
   */
  operatorQuietMs = 4000;
  /**
   * Words the operator hasn't finished saying wait undecided (the job delegation reads them again, with what they add, at the
   * end of their next turn). They go to the agent anyway once the conversation stays quiet for HELD_QUIET_MS (neither the
   * operator nor GPT Live speaking: they have stopped, not paused), or at the next reading that finds they need the agent
   * once they have waited HELD_CAP_MS (finished or not: they went on to other things). On the labeled training sessions,
   * after a turn ended in the middle of a request the operator spoke again within 10 s of it in 90% of cases, 15 s in 92%;
   * the quiet waits about 15 s past the turn's end.
   */
  static HELD_QUIET_MS = 12000; static HELD_CAP_MS = 20000;
  heldQuietMs = Mediator.HELD_QUIET_MS; heldCapMs = Mediator.HELD_CAP_MS; heldTimer?: NodeJS.Timeout; heldAt = 0;
  /** The job delegation's own reading: the operator's last word it decided on (its next reading's latest words are all after it), since when words wait undecided, and whether a reading found they need the agent. */
  jobRead = -1; undecidedSince = 0; undecidedNeeded = false;
  /** The operator's words the job delegation last kept with the voice: from where, through where, and when (reconsider). */
  lastKept?: { since: number; through: number; at: number };
  /** How long after words stayed with the voice its saying that it can't answer them still sends them. */
  static RECONSIDER_MS = 90000;
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
    this.agent = agent; this.replays = replays;
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
    this.feed.compactTokens = tuning.compactTokens; this.context.holdMs = tuning.holdLongestMs;
  }
  fault(error: Error) { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: error.message }); }
  liveEvent(event: any) {
    // A connection the operator's voice woke begins with their held words: they have the floor from its start. The floor
    // had not heard them on this connection, so what waited for the start (the page, their goal, the agent's work) went
    // in as the replay began, and GPT Live spoke over their words: in 52 of the 112 such wakes of Nov 1 to 12, against 3
    // of the 26 where nothing was sent meanwhile.
    if (event.type === 'session.started') { if (this.replays) this.floor.hear(); this.feed.flush(); this.context.pump(); }
    if (event.type === 'session.input_audio.append' && typeof event.audio === 'string') this.history.hearAudio(event);
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event);
      this.publish({ type: 'caption', ...fragment, voiceSessionId: this.live.id, voiceStartedAt: this.live.startedAt });
    }
    // The operator's turn ends when GPT Live starts answering them, after a moment's quiet, or when GPT Live asks to pass
    // their words on. Their transcript also shows they are talking, for pages that send no levels.
    if (event.type === 'session.input_transcript.delta' && String(event.delta ?? '').trim() && !phantom(String(event.delta))) { this.floor.hear(); this.listen(); }
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
    const now = Date.now();
    this.voiceSaid.push({ at: now, text: delta });
    while (this.voiceSaid.length && now - this.voiceSaid[0].at > 60000) this.voiceSaid.shift();
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
    // The operator's last word: not a piece that is no speech of theirs, after which the words before it were read again.
    const last = this.history.fragments.findLast(f => f.role === 'operator' && !this.history.unheard(f))?.seq ?? -1;
    // GPT Live asking to pass on words already read: if they went, or the voice tool acted on them itself, it hears so; if
    // Jev kept them, they go now (either one asking sends them).
    if (this.turn?.last === last) { if (delegationId) void this.turn.done.then(decision => decision?.send || decision?.told ? this.outcome(delegationId, decision) : this.passOn(delegationId)); return; }
    if (!this.route && !delegationId) return;
    const request = this.history.request();
    if (!request?.fresh) { if (delegationId) this.outcome(delegationId); return; }
    if (request.unheard) this.log({ type: 'bridge.unheard_transcript', delegationId, text: request.unheard });
    // The words stay where they are while they are read: a request is built only when a decision sends it, from the cursor
    // to the latest words (send), so words an earlier turn kept go first and nothing goes twice.
    const id = randomUUID();
    request.id = id;
    this.pending++;
    // What Jev reads as their latest words: all of theirs since the voice tool's last reading for its own actions (a page
    // command never runs twice for the same words); for the job delegation, all since its last decision, so that words the
    // operator hadn't finished are judged within the whole of what they said.
    const since = this.turn?.last ?? -1, spoken = this.history.spoken(request.through, since), jobSpoken = this.history.spoken(request.through, this.jobRead);
    const heardAt = this.history.lastInputAt, route = this.route, overdue = Boolean(this.undecidedSince) && Date.now() - this.undecidedSince >= this.heldCapMs;
    // The voice tool's own part, at once and in the operator's order; GPT Live hears what it did, and the learner and the
    // tuner take the reading.
    const actions = this.actionsOrder.then(() => route?.actions(request, spoken, why))
      .catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); return undefined; });
    this.actionsOrder = actions;
    void actions.then(done => {
      if (done?.told && this.live.state === 'active') this.context.add('thinking', done.told, delegationId ?? null);
      if (done?.reading) this.consider?.(done.reading, id);
    });
    // Whether the words go to the agent, once GPT Live has replied; requests reach the agent in the order they were made.
    // Jev failing, the words go to the agent: keeping work from it is the costly mistake.
    const decided = Promise.all([actions, this.order]).then(async ([done]): Promise<Decision> => {
      if (!route || !done) return { send: true };
      // GPT Live asked to pass them on: they go, as they do when Jev finds they need the agent. Either one asking sends:
      // on 284 labeled sessions (Oct 28) the times the operator had to step in fell from 120 to 51, for more talk sent
      // (206 times instead of 173). Jev turned down 324 of GPT Live's 628 asks of Nov 1 to 13, and GPT Live asked again
      // right after 75 times.
      // Words the voice tool handled itself (turning sessions on or off, how the voice should behave) are answered by what it did.
      if (delegationId) return done.keptNote ? { send: false, note: done.keptNote, reading: done.reading } : { send: true, note: done.note, reading: done.reading };
      // The wait for a reply that never begins (replyStartMs) is not idle: in 70 of the 215 turns the voice didn't answer
      // (Oct 31 to Nov 12), the operator went on speaking during it, and their words then waited instead of going in pieces.
      const reply = await this.replyTo(spoken.at(-1)?.at ?? heardAt, heardAt);
      // They went on speaking before the decision, so they haven't finished: nothing is sent yet, and the end of their turn
      // reads these words with what they add. Sent at once, they went in pieces ("Actually, I like the soft shapes one the"
      // reached Codex a second after the turn ended, Oct 29, while the operator went on about the rim and the face).
      const continued = this.history.lastInputAt > heardAt;
      return route.job(request, jobSpoken, reply, done, { continued, overdue, needed: this.undecidedNeeded, sent: this.lastSent && { ago: Date.now() - this.lastSent.at, said: this.lastSent.said, id: this.lastSent.id } });
    }).catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); return { send: true } as Decision; });
    // What GPT Live was told about the turn stays with it: asked again to pass the words on, it hears the same.
    const done = decided.then(async decision => { const told = (await actions)?.told; this.decided(id, request, decision, delegationId, told); return told && !decision.told ? { ...decision, told } : decision; })
      // Whatever went wrong, the words go with the next request rather than nowhere.
      .catch(error => { this.fault(error as Error); return undefined; })
      .finally(() => { this.pending--; });
    this.turn = { last, at: Date.now(), done };
    this.order = done;
  }
  /**
   * GPT Live's reply to the operator's latest words, begun at `from` (it often answers before their transcript is in): what
   * it said since, once it says enough of what it makes of them or stops (REPLY_WORDS, replyPauseMs); at most replyMs
   * from now, none if it hasn't begun within replyStartMs. A word of theirs after `heardAt` ends the wait.
   */
  replyTo(from: number, heardAt: number): Promise<string | undefined> {
    const started = Date.now();
    return new Promise(resolve => {
      const check = () => {
        const said = this.voiceSaid.filter(d => d.at >= from), text = said.map(d => d.text).join('').replace(/\s+/g, ' ').trim(), waited = Date.now() - started;
        const spoke = answers(`${text} `), ended = spoke && /[.!?…]["”’)]?$/.test(text);
        const enough = ended && substance(text) >= Mediator.REPLY_WORDS, stopped = ended && Date.now() - (said.at(-1)?.at ?? 0) >= this.replyPauseMs;
        if (enough || stopped || waited >= this.replyMs || (!spoke && waited >= this.replyStartMs) || this.history.lastInputAt > heardAt || this.live.state !== 'active') resolve(text || undefined);
        else this.schedule(check, 150);
      };
      check();
    });
  }
  /** What came of a turn: the words go to the agent, noted with what the voice tool did; or they stay for the next request, noted with it. GPT Live hears what was done (unless the voice tool's own reading told it already: toldBefore). */
  decided(id: string, request: SpokenRequest, { reading, send, later, note, told, wait, needed }: Decision, delegationId?: string, toldBefore?: string) {
    if (told && this.live.state === 'active') this.context.add('thinking', told, delegationId ?? null);
    // Kept as needing nothing: should the voice then say it can't answer them, they are read again (reconsider).
    // Words kept just before these (the question, then "okay" while the voice looks) are still what it may fail to answer.
    const before = this.lastKept && Date.now() - this.lastKept.at <= Mediator.RECONSIDER_MS ? this.lastKept.since : this.jobRead;
    this.lastKept = !send && !wait ? { since: before, through: request.through, at: Date.now() } : undefined;
    // Sent, or kept as needing nothing: the job delegation's next reading starts after these words. Not finished: they wait for it.
    if (wait) { this.undecidedSince ||= Date.now(); this.undecidedNeeded ||= Boolean(needed); this.awaitQuiet(); }
    else { this.jobRead = Math.max(this.jobRead, request.through); this.undecidedSince = 0; this.undecidedNeeded = false; clearTimeout(this.heldTimer); }
    if (send) return this.send(id, note ? [note] : [], delegationId ?? null, reading, 'passed', later);
    this.log({ type: 'turn.kept', id, said: this.said(request).slice(-200), needsAgent: reading?.needsAgent ?? null, handled: Boolean(note), ...wait && { waiting: true } });
    this.audit?.record({ handOff: 'kept', said: this.said(request), voiceSessionId: this.live.id, delegationId: delegationId ?? null, requestId: id, jevCall: reading?.id }, reading?.needsAgent ?? null, reading?.transcript);
    // Kept: they go with the next request, with what the voice tool did with them; after voice ended, they go now.
    if (note) this.history.note(request.through, note);
    if (this.ended) this.handOff(this.ended);
    if (delegationId && !told && !toldBefore) this.outcome(delegationId, { send: false, wait });
  }
  /**
   * The voice now says it can't answer or find what the operator asked (presenter.ts: it looked on the page and it isn't
   * there, or it doesn't know): their words that stayed with it are read once more, with all it has said since, and go to
   * the agent if they need it. Read with the reply's first words only, "let me check the page" kept them from the agent, and
   * nothing read them again when the check came up empty. Not once the operator has spoken again: that turn decides.
   */
  reconsider() {
    const kept = this.lastKept, route = this.route;
    if (!kept || !route || this.live.state !== 'active' || this.pending || Date.now() - kept.at > Mediator.RECONSIDER_MS) return;
    if (this.history.fragments.some(f => f.role === 'operator' && f.seq > kept.through && !this.history.unheard(f))) return;
    const request = this.history.request();
    if (!request) return;
    this.lastKept = undefined;
    const id = randomUUID(), spoken = this.history.spoken(kept.through, kept.since), from = spoken.at(-1)?.at ?? kept.at;
    const reply = this.voiceSaid.filter(d => d.at >= from).map(d => d.text).join('').replace(/\s+/g, ' ').trim().slice(-600) || undefined;
    request.id = id; this.pending++;
    this.log({ type: 'turn.reconsidered', id, said: this.said(request).slice(-200), reply: reply?.slice(-200) });
    this.order = this.order.then(() => route.job(request, spoken, reply, {}))
      // Jev failing, they go to the agent, as at the end of a turn: the voice has just said it can't answer them.
      .catch(error => { this.log({ type: 'turn.error', message: (error as Error).message }); return { send: true } as Decision; })
      // Found to need the agent, they go now, finished or not: the voice has answered since, and no later reading takes
      // them up. Kept again, they are not read a third time.
      .then(decision => { this.decided(id, request, decision.wait ? { ...decision, send: true, wait: false, needed: false } : decision); this.lastKept = undefined; })
      .catch(error => { this.fault(error as Error); })
      .finally(() => { this.pending--; });
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
      // Once they speak again, the end of that turn reads the waiting words with the new ones (and waits again, if so).
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
  /** GPT Live asked to pass words on: what came of them (nothing new to send, sent, or kept). */
  outcome(delegationId: string, decision?: Decision) {
    if (this.live.state !== 'active') return;
    // Presenting, GPT Live sometimes asks to pass on words its own words already moved the page for.
    const text = !decision ? (Date.now() - this.cueAt < 8000 ? cueNoDelegation : nothingToSend(this.agent)) : decision.told ?? turnOutcome(this.agent, decision);
    this.context.add('thinking', text, delegationId);
  }
  /** GPT Live asked to pass on words the voice tool read and kept: they go now, in turn (either one asking sends them). */
  passOn(delegationId: string) {
    this.pending++;
    this.order = this.order.then(() => { this.undecidedSince = 0; this.undecidedNeeded = false; this.send(randomUUID(), [], delegationId, undefined, 'passed'); })
      .catch(error => this.fault(error as Error)).finally(() => { this.pending--; });
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
      outcome: typeof needsAgent !== 'number' ? 'Hand-off check failed' : `${{ passed: this.route ? 'Jev passed it on' : 'GPT Live passed it on', kept: 'Kept', answered: 'Kept; sent when voice ended', held: "Waited for the operator to finish; sent once they stayed quiet" }[handOff]}; Jev: ${needsAgent >= .5 ? 'needed the harness' : 'could have been answered'} (${needsAgent.toFixed(2)})` });
  }
  /** The microphone level of the page this voice session listens to. */
  // The operator's held words still going out after a wake count as their talking: GPT Live is hearing them now.
  hear(level: MicrophoneLevel) { if (operatorSpeaking(level) || level.backlogMs! > 0) this.floor.hear(); }
  schedule(fn: () => void, ms: number) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  /** Sends that come without a reading (voice ended) wait their turn behind the readings under way, in the order the operator spoke. */
  order: Promise<unknown> = Promise.resolve(); actionsOrder: Promise<unknown> = Promise.resolve(); pending = 0;
  inTurn(step: () => unknown) {
    if (!this.pending) { step(); return; }
    this.order = this.order.then(step).catch(error => this.fault(error as Error));
  }
  /**
   * Sends what the operator and the voice said from the cursor to the latest words, in the order said, whichever turn's
   * decision sends it: words an earlier turn kept go with it, before the words that follow them, and words a request on its
   * way took go with none other. Nothing left to send (a request on its way took them all): GPT Live, if it asked, hears so.
   */
  send(id: string, notes: readonly string[], delegationId: string | null, reading?: Reading, handOff: HandOff = 'passed', followUp = false) {
    const request = this.history.request();
    if (!request) { if (delegationId) this.outcome(delegationId, { send: true }); return; }
    this.history.claim(request, id);
    this.jobRead = Math.max(this.jobRead, request.through);
    try {
      const now = Date.now(), from = this.conversation?.cursor(), allNotes = [...request.notes ?? [], ...notes];
      const said = this.said(request), content = this.clean(this.conversation ? recordRequest(this.conversation.text(from!, now), allNotes) : voiceRequest(request.utterances, allNotes));
      // The next request starts just before this one ended: a line heard in the same millisecond after it was cut comes
      // with the next, never with neither (at worst one line twice).
      if (this.conversation) { this.cutFrom.set(id, from!); this.conversation.move(now - .5); }
      this.deliver({ id, content, delegationId, voiceSessionId: this.live.id, queuedAt: Date.now(), said, ...followUp && { followUp } });
      this.lastSent = { at: Date.now(), said, id };
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
    this.feed.stop(); this.context.stop(); clearTimeout(this.quiet); clearTimeout(this.heldTimer); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}

