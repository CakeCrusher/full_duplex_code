import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentDefinition, AgentLaunch, Observation, ObservationKind, VoiceRequest } from './adapter.ts';
import type { AgentObserver } from './agent-observer.ts';
import { redact } from './redact.ts';
import { withoutBinary } from './context-rules.ts';
import { InstructionLearner, LearnedLog, type LearnedInstruction } from './instruction-learner.ts';
import { DelegationAudit } from './delegation-audit.ts';
import { JevAudit } from './jev-audit.ts';
import { askAgent, distillPrompt, parseDistilled } from './instruction-distiller.ts';
import { tuningFrom, type TuningChange } from './jev-tuner.ts';
import { HISTORY_BYTES, Jev, type Moment, type Reading } from './jev.ts';
import { perceivedText } from './perceived.ts';
import { DEFAULT_FEATURES, type Feature, type Features } from './features.ts';
import { agentInstructions, instructionsRemoved } from './prompts.ts';
import type { Spoken } from './voice-history.ts';
import { Stage } from './stage.ts';
import { PageAudit } from './page-audit.ts';
import { Presenter } from './presenter.ts';
import { UsageLedger } from './usage-ledger.ts';
import { Timeline } from './timeline.ts';
import { StatusLog, statusSnapshot, type BridgeEvent } from './status.ts';
import { Outbox } from './outbox.ts';
import { VoiceSessions } from './voice-sessions.ts';
import { Endpoints } from './endpoints.ts';
import { Pages, type Page } from './pages.ts';
import { DEFAULT_TUNING, tuning, type Tuning } from './tuning.ts';
import { CompanionRegistry, type CompanionEntry } from './companions.ts';
import { SessionSwitch } from './sessions.ts';
import { Forks } from './forks.ts';
import { VoiceNotes } from './notes.ts';
import type { NoteHotkey } from './hotkey.ts';
import type { AgentSession } from './adapter.ts';

export interface HarnessOptions {
  /** The coding agent, from src/adapters. */
  agent: AgentDefinition;
  root: string; runDir: string; cwd: string; apiKey: string;
  /** The agent session's ID; when unknown, it is learned from the agent's first event. */
  sessionId?: string;
  voice?: string; observation?: string; port?: number; portFallback?: boolean; publicUrl?: string;
  /** A TypeSafe API key: Jev then decides what reaches the agent, and does the optional features on. */
  jevKey?: string;
  /** Overrides of the low-level settings for how agent updates reach GPT Live (tuning.ts). */
  tuning?: Partial<Tuning>;
  /** Jev's optional features on (features.ts): orchestration, instructions (the learner), configuration (the tuner). */
  features?: Iterable<Feature>;
  /** The agent's own command-line arguments. */
  agentArgs?: string[];
  /** Ask OpenAI to store voice sessions so that Resume voice can fork them (default true; --no-store turns it off). */
  store?: boolean;
  /** Where the page being presented is remembered, so a restart of fdc picks it up again (stage.ts). */
  stageFile?: string;
}

/** What the agent does inside a turn, and what ends one (adapter.ts, ObservationKind). */
const IN_TURN = new Set<ObservationKind>(['prompt', 'tool', 'tool_failure', 'attention']), TURN_ENDS = new Set<ObservationKind>(['turn_end', 'turn_failed', 'session_end']);
/**
 * How long an agent in a turn may do nothing before the turn counts as over. Inside Claude's recorded turns (1,102, Nov 1
 * to 13) the longest stretch without any event passed 2 minutes in 16% and 3 minutes in 3%; a request released during
 * such a stretch is steered in, as every request was before requests could be held.
 */
export const QUIET_TURN_MS = 180000;

// The bridge: one local process between the page, GPT Live and the agent.
// It owns the shared state; each concern lives in its own module.
export class Harness {
  agent: AgentDefinition; adapter: AgentAdapter; observer: AgentObserver;
  /** The main session as the adapter was created for it, and the fork open for a tangent, if any (forks.ts). */
  agentSession!: AgentSession; forks!: Forks;
  /** Jev, when a TypeSafe key is set: its readings (jev.ts) decide what reaches the agent, and act for the features on; each call is recorded with what came of it (jev-audit.ts). */
  jev?: Jev; jevAudit?: JevAudit; learner?: InstructionLearner; handOffAudit?: DelegationAudit; jevTuning: boolean; learned: LearnedLog;
  /** Jev's optional features on (features.ts). */
  features: Features;
  /** Settings the operator set by hand (FDC_TUNING), which Jev leaves alone; the latest ask for settings (only its answer counts), and the one waiting. */
  pinned: (keyof Tuning)[] = []; tuneAsks = 0; tuneTimer?: NodeJS.Timeout;
  /** Every change to the settings in this run, newest last: when, by whom, from what to what (Developer mode lists them). */
  tuningHistory: { id?: string; at: number; by: string; changes: TuningChange[]; /** When the operator took it back (revertTuning). */ reverted?: number }[] = [];
  root: string; runDir: string; cwd: string; sessionId?: string; apiKey: string;
  voice: string; observation: string; port: number; portFallback: boolean;
  /** How agent updates reach GPT Live; a running voice session takes a change at once. */
  tuning: Tuning;
  browserToken = randomBytes(32).toString('hex');
  // Authenticates the agent's side: hooks and adapter sockets.
  agentToken = randomBytes(32).toString('hex');
  publicOrigin: string | null = null; publicBrowserUrl: string | null = null;
  baseUrl = ''; browserUrl = ''; portFellBack = false;
  agentReady = false; stopping = false;
  /** When this companion started serving; 0 until then. */
  startedAt = 0;
  /** Since when the agent has been in the middle of a turn, by its own events: from its first prompt or tool call after the last turn's end. */
  workingSince?: number;
  /** When the agent last did anything, its subagents' work included. */
  agentActiveAt = 0;
  heldTimer?: NodeJS.Timeout;
  /**
   * How long the agent's turn has been running, or undefined between turns. A turn that reports no end (Claude
   * interrupted in its terminal) is over once the agent has done nothing for QUIET_TURN_MS.
   */
  agentWorking() {
    const quiet = Date.now() - Math.max(this.agentActiveAt, this.workingSince ?? 0);
    if (this.workingSince !== undefined && quiet >= QUIET_TURN_MS) { this.log({ type: 'agent.turn_quiet', seconds: Math.round(quiet / 1000) }); this.turnOver(); }
    return this.workingSince === undefined ? undefined : Date.now() - this.workingSince;
  }
  /** The agent's turn is over: what was held for its end goes to it. */
  turnOver() { this.workingSince = undefined; clearTimeout(this.heldTimer); this.outbox.releaseHeld(); }
  /** While a request is held, a look now and then at whether the agent has gone quiet. */
  watchHeld() {
    clearTimeout(this.heldTimer);
    this.heldTimer = setTimeout(() => { if (this.agentWorking() !== undefined && [...this.outbox.values()].some(entry => entry.state === 'held')) this.watchHeld(); }, 15000);
    this.heldTimer.unref();
  }
  companions: CompanionRegistry;
  /** Turns the voice of running companions on and off, by voice. */
  sessionSwitch: SessionSwitch;
  /** Every open companion page. */
  pages: Pages;
  agentLaunch?: AgentLaunch;
  /** fdc's instructions to the agent, in its system prompt however the session started (prompts.ts, agentInstructions). */
  agentInstructions: string;
  clean: (text: unknown) => string;
  statusLog: StatusLog; log: (event: BridgeEvent) => void; publish: (event: BridgeEvent, page?: Page) => void; fault: (error: Error, page?: Page) => void;
  ledger: UsageLedger; timeline: Timeline; outbox: Outbox; voiceSessions: VoiceSessions; endpoints: Endpoints;
  /** The page the agent last showed the operator, which the gate can move (stage.ts). */
  stage: Stage;
  /** Every action on that page and what GPT Live was told of it, in the run's page.jsonl (page-audit.ts). */
  pageAudit: PageAudit;
  /** Moves the stage by what GPT Live says: speech cues, the words Jev matches to a command, the following ring. */
  presenter: Presenter;
  /** The operator's voice notes on the timeline (notes.ts), and the chord that records one from anywhere (hotkey.ts, started by the launcher). */
  notes: VoiceNotes; noteHotkey?: NoteHotkey;
  statusTimer?: NodeJS.Timeout; agentLostTimer?: NodeJS.Timeout;
  constructor({ agent, root, runDir, cwd, sessionId, apiKey, voice = 'marin', observation = agent.observationModes[0] ?? '', port = 0, portFallback = false, publicUrl, agentArgs = [], jevKey, tuning: overrides, features = DEFAULT_FEATURES, store = true, stageFile }: HarnessOptions) {
    this.agent = agent; this.root = root; this.runDir = runDir; this.cwd = cwd; this.sessionId = sessionId; this.apiKey = apiKey;
    this.voice = voice; this.observation = observation; this.port = port; this.portFallback = portFallback;
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    if (publicUrl) this.setPublicUrl(publicUrl);
    this.clean = text => redact(text, [apiKey, this.browserToken, this.agentToken, ...(jevKey ? [jevKey] : [])]);
    this.timeline = new Timeline(undefined, agent);
    this.pages = new Pages({ log: event => this.log(event) });
    this.statusLog = new StatusLog({ runDir, clean: this.clean, timeline: this.timeline, pages: this.pages });
    this.log = this.statusLog.log; this.publish = this.statusLog.publish; this.fault = this.statusLog.fault;
    this.ledger = new UsageLedger(path.join(root, '.runs', 'budget.json'));
    this.tuning = tuning(overrides); this.pinned = Object.keys(overrides ?? {}) as (keyof Tuning)[];
    if (this.pinned.length) this.tuningHistory.push({ at: Date.now(), by: 'FDC_TUNING', changes: this.pinned.map(name => ({ name, from: DEFAULT_TUNING[name], to: this.tuning[name] })) });
    this.learned = new LearnedLog(path.join(root, '.runs', 'learned-instructions.jsonl'));
    this.features = new Set(features);
    this.jevTuning = Boolean(jevKey && this.features.has('configuration'));
    if (jevKey) {
      const jevAudit = this.jevAudit = new JevAudit({ file: path.join(runDir, 'jev.jsonl'), clean: this.clean });
      this.jev = new Jev({ apiKey: jevKey, log: this.log, record: call => jevAudit.called(call), agent, features: this.features });
      this.handOffAudit = new DelegationAudit({ file: path.join(root, '.runs', 'delegation-audit.jsonl'), log: this.log });
    }
    this.companions = new CompanionRegistry(path.join(root, '.runs', 'companions'));
    this.pageAudit = new PageAudit({ file: path.join(runDir, 'page.jsonl'), clean: this.clean });
    this.stage = new Stage({ log: this.log, file: stageFile, onChange: () => void this.voiceSessions?.briefStage(), record: action => this.pageAudit.action(action) });
    this.presenter = new Presenter(this);
    this.sessionSwitch = new SessionSwitch(this);
    this.voiceSessions = new VoiceSessions(this, { store });
    if (jevKey && this.features.has('instructions')) this.learner = new InstructionLearner({ log: this.log,
      onJudged: judged => { if (!judged.learned) this.jevCheck(judged.requestId, 'instruction', `Not a standing instruction (${judged.behave.toFixed(2)})`, judged); },
      onLearn: instruction => { this.learnInstruction(instruction).catch(error => this.fault(error as Error)); } });
    this.forks = new Forks(this);
    this.notes = new VoiceNotes(this);
    // A request goes to the session in focus when it was sent: the main one, or a fork open for a tangent (forks.ts).
    this.outbox = new Outbox({ agent, adapter: entry => this.forks.adapterFor(entry.target), ready: entry => entry.target === 'fork' ? this.forks.ready : this.agentReady, clean: this.clean, log: this.log,
      working: entry => entry.target !== 'fork' && this.agentWorking() !== undefined, onHeld: entry => { this.voiceSessions.heldDelivery(entry); this.watchHeld(); },
      publish: event => this.publish(event), fault: error => this.fault(error), onDispatched: entry => this.voiceSessions.dispatchedDelivery(entry), onSent: entry => this.voiceSessions.confirmDelivery(entry), onUncertain: entry => this.voiceSessions.uncertainDelivery(entry) });
    this.agentInstructions = agentInstructions(agent);
    this.agentSession = { root, runDir, cwd, sessionId, observation, agentArgs, instructions: this.agentInstructions, clean: this.clean, log: this.log };
    this.adapter = agent.create(this.agentSession);
    const observer = this.observer = this.adapter.observations;
    observer.on('input', event => { this.log({ type: 'agent.input', ...event }); this.publish({ type: 'agent_input', ...event }); });
    observer.on('text', event => { this.log({ type: 'agent.text', ...event }); this.publish({ type: 'agent_text', ...event }); });
    // Pages show observations without their binary data, which stays in the local log: an image
    // read can be over a megabyte, and a page connection backed up with it looks like slow playback.
    observer.on('observation', ({ raw, ...event }) => this.publish({ type: 'agent_observation', ...event, text: withoutBinary(event.text) }));
    // The agent's work, priced for Standby (activity.ts): a subagent's events are its parent's business.
    // While a fork is in focus, the main session's work weighs nothing for Standby, as for the voice (forks.ts).
    observer.on('observation', (observation: Observation) => { if (!observation.child && observation.kind !== 'event' && this.forks.focus === 'main') this.voiceSessions.activity.add(observation.kind); });
    observer.on('observation', (observation: Observation) => { if (!observation.child) this.stage.observe(observer.toolUse(observation), observation.name === this.agent.profile.turnEnd); });
    observer.on('status', event => { this.log({ type: 'agent.status', ...event }); this.publish({ type: 'agent_status', ...event }); });
    // The agent's turn, by its own events: it begins with a prompt or a tool call and ends where the agent reports its end.
    // A request that can wait is held until then (outbox.ts). Not by the agent's status: Claude's stays "working" after a
    // turn that left background work running, and a request held then stayed held with Claude idle.
    observer.on('observation', (observation: Observation) => {
      this.agentActiveAt = Date.now();
      if (observation.child) return;
      if (TURN_ENDS.has(observation.kind)) this.turnOver(); else if (IN_TURN.has(observation.kind)) this.workingSince ??= Date.now();
    });
    observer.on('status', ({ state }) => { if (state !== 'working' && state !== 'needs_attention') this.turnOver(); });
    observer.on('fault', error => this.fault(error));
    const { name, transport } = agent.profile;
    this.adapter.on('connection', ready => {
      this.agentReady = ready;
      if (ready) { clearTimeout(this.agentLostTimer); this.outbox.dispatchQueued(); }
      else if (!this.stopping) this.agentLostTimer = setTimeout(() => { if (!this.agentReady) this.live?.close(`${name} ${transport} disconnected`); }, 10000);
      this.publish(this.status());
    });
    this.adapter.on('delivery', ({ id }) => this.outbox.confirm(id));
    this.adapter.on('session', id => { this.sessionId = id; if (this.baseUrl) this.writeConnection(); this.register(); this.publish(this.status()); });
    this.adapter.on('update', () => this.publish(this.status()));
    this.adapter.on('fault', error => this.fault(error));
    this.endpoints = new Endpoints(this);
  }
  // The current voice session's state, owned by the voice-sessions module.
  get live() { return this.voiceSessions.live; }
  set live(live) { this.voiceSessions.live = live; }
  get mediator() { return this.voiceSessions.mediator; }
  set mediator(mediator) { this.voiceSessions.mediator = mediator; }
  get audit() { return this.voiceSessions.audit; }
  set audit(audit) { this.voiceSessions.audit = audit; }
  get uiEvents() { return this.statusLog.uiEvents; }
  // Public address of a tunnel that forwards to this bridge. Known only after
  // the tunnel starts, which needs the bridge's port first.
  setPublicUrl(url: string) {
    this.publicOrigin = new URL(url).origin;
    this.publicBrowserUrl = `${this.publicOrigin}/#${this.browserToken}`;
    this.register();
  }
  saveTimeline() { this.statusLog.saveTimeline(); }
  status() { return statusSnapshot(this); }
  instructions() { return this.voiceSessions.instructions(); }
  appendInstruction(text: unknown) { return this.voiceSessions.appendInstruction(text); }
  startLive(sdp?: unknown, page?: Page, mode: 'resume' | 'fresh' = 'fresh', automatic = false) { return this.voiceSessions.start(sdp, page, mode, automatic); }
  deliver(request: VoiceRequest) { const target = this.forks.focus; if (target === 'fork') this.forks.asked = Date.now(); this.outbox.add({ ...request, target }); }
  /** The session in focus changed (forks.ts): the voice hears that session's work from now. */
  focusChanged() { this.mediator?.observe(this.forks.observer()); this.publish(this.status()); }
  /** A line for the voice about what fdc did by itself, quietly. */
  tell(text: string) { if (this.live?.state === 'active') this.mediator?.context.add('thinking', text); }
  /** A one-off run of the harness for a short piece of writing (tests replace it). */
  ask = (prompt: string) => askAgent(this.agent, prompt, { cwd: this.cwd });
  /** One of Jev's checks of a request to the harness, for the page's request inspector. */
  jevCheck(requestId: string | undefined, kind: 'instruction' | 'handoff', outcome: string, { said, behave, design, lasting }: { said?: string; behave?: number; design?: number; lasting?: string } = {}) {
    if (requestId) this.publish({ type: 'jev_check', requestId, at: Date.now(), kind, outcome, words: said, scores: { behave: behave ?? null, design: design ?? null, lasting: lasting ?? null } });
  }
  // Jev found a likely standing instruction; a one-off run of the harness writes what it says (the
  // operator's words are speech), or finds there is none or one in force already says it.
  async learnInstruction(instruction: LearnedInstruction) {
    const inForce = this.voiceSessions.learnedInForce();
    let text = instruction.text, replaces: string[] = [];
    try {
      const reply = await this.ask(distillPrompt({ said: instruction.said ?? instruction.text, transcript: instruction.transcript, inForce, scores: instruction, remove: instruction.remove }));
      const distilled = parseDistilled(this.clean(reply));
      this.log({ type: 'instruction.distilled', said: instruction.said, distilled, requestId: instruction.requestId });
      if ('same' in distilled) return this.jevCheck(instruction.requestId, 'instruction', `Already in force as ${distilled.same}`, instruction);
      if ('none' in distilled) return this.jevCheck(instruction.requestId, 'instruction', 'Nothing to change in the instructions', instruction);
      // They asked for instructions to go, and gave no new one: those are removed, as the page's Remove takes one out, and
      // the voice says so. Only when Jev read a removal too: nothing takes a removed instruction's place, so both must
      // find it asked for (the harness alone changed the list on 1 of 7 made-up requests that were no instruction).
      if ('remove' in distilled) {
        const gone = instruction.remove ? inForce.filter(item => distilled.remove.includes(item.id)) : [];
        for (const item of gone) await this.removeInstruction(item.id);
        if (gone.length && this.live?.state === 'active') this.mediator?.context.add('commentary', instructionsRemoved(gone));
        return this.jevCheck(instruction.requestId, 'instruction', gone.length ? `Removed ${gone.map(item => item.id).join(', ')}` : instruction.remove ? 'Asked to remove an instruction that is not in force' : 'Nothing removed: Jev read no request to remove one', instruction);
      }
      text = distilled.text;
      // Only instructions that are in force: the harness may name one that isn't.
      replaces = (distilled.replaces ?? []).filter(id => inForce.some(item => item.id === id));
    } catch (error) {
      // Without the harness's wording, the operator's own words are kept, as before. Not words that only asked for an
      // instruction to go: kept, "forget the thing about short answers" became an instruction itself.
      this.log({ type: 'instruction.error', message: `Writing the instruction: ${(error as Error).message}` });
      if (instruction.removalOnly) return this.jevCheck(instruction.requestId, 'instruction', 'Could not tell which instruction to remove', instruction);
    }
    const id = await this.voiceSessions.learn({ ...instruction, text });
    if (!id) return this.jevCheck(instruction.requestId, 'instruction', 'The instruction could not be added', instruction);
    // The instructions it takes the place of go, as the page's Remove takes one out.
    for (const old of replaces) await this.removeInstruction(old).catch(error => this.log({ type: 'instruction.error', id: old, message: (error as Error).message }));
    this.jevCheck(instruction.requestId, 'instruction', `Learned ${id}${replaces.length ? ` in place of ${replaces.join(', ')}` : ''}: ${text}`, instruction);
  }
  /**
   * New settings for how agent updates reach GPT Live, from now on. A change is learned behavior, as an instruction Jev
   * learns is: it has an ID, so the page shows it and plays the same sound once, however often the event reaches it.
   */
  setTuning(next: Tuning, changes: TuningChange[] = [], by = 'Jev') {
    this.tuning = next; this.mediator?.applyTuning(next);
    const id = changes.length ? randomUUID() : undefined;
    if (changes.length) { this.tuningHistory.push({ id, at: Date.now(), by, changes }); if (this.tuningHistory.length > 200) this.tuningHistory.shift(); }
    this.log({ type: 'tuning.changed', id, by, tuning: next, changes }); this.publish({ type: 'tuning', id, by, tuning: next, changes }); this.publish(this.status());
  }
  /**
   * The operator takes back a change to the settings (Revert on the page): each setting it changed returns to its value
   * before it, and is theirs from then on: Jev leaves a setting the operator set alone, as it does those set with FDC_TUNING.
   */
  revertTuning(id: unknown) {
    const entry = this.tuningHistory.find(item => item.id !== undefined && item.id === id);
    if (!entry || entry.reverted) return;
    const next = { ...this.tuning }, changes: TuningChange[] = [];
    for (const { name, from } of entry.changes) {
      if (next[name] !== from) changes.push({ name, from: next[name], to: from });
      next[name] = from;
      if (!this.pinned.includes(name)) this.pinned.push(name);
    }
    entry.reverted = Date.now();
    this.log({ type: 'tuning.reverted', id, changes });
    this.setTuning(next, changes, 'you (reverted)');
  }
  /**
   * Jev's reading of a moment (jev.ts): the latest words (the last of `spoken`), with the latest of what the voice companion
   * had perceived before them, word for word as GPT Live got it (perceived.ts: the same conversation however many Standby
   * wakes, resumes and restarts of fdc came between, as far as GPT Live has it), and the operator's instructions to the
   * companion in force, as GPT Live has them, and the operator's goal with what was shown for it. Of the operator's words
   * the voice tool's own reading also asks, with those features on, whether they give a standing instruction (the learner)
   * and which settings fit (the tuner).
   */
  read({ spoken = [], ...moment }: Omit<Moment, 'latest' | 'history' | 'instructions' | 'learn' | 'tune'> & { spoken?: Spoken[] }, timeoutMs?: number): Promise<Reading> {
    if (!this.jev) return Promise.reject(new Error('Jev is not configured'));
    const words = ['turn', 'delegation', 'unsent'].includes(moment.trigger), tune = this.jevTuning && (words || moment.trigger === 'settings');
    const ask = tune ? ++this.tuneAsks : 0, latest = spoken.at(-1), record = this.voiceSessions.run?.record ?? this.voiceSessions.current();
    return this.jev.read({ ...moment, ...latest && { latest: { role: latest.role, text: this.clean(latest.text) }, history: this.clean(perceivedText(record, spoken.slice(0, -1), latest.at, HISTORY_BYTES)) },
      goal: moment.goal ?? this.voiceSessions.goalLine(),
      instructions: this.voiceSessions.additionalInstructions.map(item => item.text), learn: (words && this.features.has('instructions')) || undefined,
      removable: words && this.features.has('instructions') ? this.voiceSessions.learnedInForce() : undefined,
      tune: tune ? { earlier: this.learned.earlier(this.sessionId), current: this.tuning, pinned: this.pinned } : undefined }, timeoutMs)
      .then(reading => Object.assign(reading, ask ? { tuneAsk: ask } : {}));
  }
  /**
   * What Jev read in the operator's words, acted on once: a standing instruction to learn, and the settings that fit (only
   * the latest ask's: an older answer arriving late would undo it). Done last with the voice tool's own reading (turn.ts),
   * with the tuner's alone and with that of words already sent, so the reading's record is then complete (jev-audit.ts).
   */
  consider(reading: Reading & { tuneAsk?: number }, requestId?: string) {
    if (reading.considered) return;
    reading.considered = true;
    const learned = this.learner?.consider(reading, requestId);
    let settings: TuningChange[] | string | undefined;
    if (reading.tuning && reading.tuneAsk !== this.tuneAsks) settings = 'superseded by a later reading';
    else if (reading.tuning && !this.stopping) {
      const { tuning: next, changes } = tuningFrom(reading.tuning, this.tuning, this.pinned);
      if (changes.length) this.setTuning(next, changes);
      settings = changes;
    }
    this.jevAudit?.decided(reading.id, { ...reading.instruction && { learned: learned?.scope ?? false }, ...settings && { settings } }, true);
  }
  /** With Jev's tuning on: when the instructions change or voice starts, Jev reads them again for the settings that fit. */
  tuneFromInstructions() {
    if (!this.jevTuning) return;
    clearTimeout(this.tuneTimer);
    this.tuneTimer = setTimeout(() => this.read({ trigger: 'settings' }, 8000).then(reading => this.consider(reading), error => this.log({ type: 'tuning.error', message: (error as Error).message })), 1000);
  }
  /** The operator removes an instruction Jev learned, by its ID. */
  removeInstruction(id: unknown) { return this.voiceSessions.removeLearned(id); }
  async start() {
    const port = await this.endpoints.listen(this.port, this.portFallback);
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.browserUrl = `${this.baseUrl}/#${this.browserToken}`;
    try { this.agentLaunch = await this.adapter.launch({ baseUrl: this.baseUrl, token: this.agentToken }); }
    catch (error) { await this.close(); throw error; }
    this.writeConnection();
    this.startedAt = Date.now(); this.register();
    this.statusTimer = setInterval(() => this.publish(this.status()), 1000);
    if (this.learned.earlier(this.sessionId).length) this.tuneFromInstructions();
    this.log({ type: 'bridge.started', sessionId: this.sessionId, cwd: this.cwd, baseUrl: this.baseUrl, features: this.jev ? [...this.features] : undefined });
    return this;
  }
  // This private descriptor permits repeatable local tests without exposing the API key.
  writeConnection() {
    fs.writeFileSync(path.join(this.runDir, 'connection.json'), JSON.stringify({ baseUrl: this.baseUrl, browserToken: this.browserToken, sessionId: this.sessionId, cwd: this.cwd }, null, 2), { mode: 0o600 });
  }
  // This companion as the others list it and switch to it.
  companionEntry(): CompanionEntry {
    return { pid: process.pid, port: Number(new URL(this.baseUrl).port), token: this.browserToken, cwd: this.cwd, agent: this.agent.profile.product,
      sessionId: this.sessionId, startedAt: this.startedAt, publicUrl: this.publicOrigin ?? undefined };
  }
  // Once started, and until stopping; the switcher is a convenience, so a registry that fails is only logged.
  register() {
    if (!this.startedAt || this.stopping) return;
    try { this.companions.register(this.companionEntry()); } catch (error) { this.log({ type: 'companions.failed', message: (error as Error).message }); }
  }
  async close() {
    if (this.stopping) return; this.stopping = true;
    if (this.startedAt) try { this.companions.remove(this.companionEntry()); } catch (error) { this.log({ type: 'companions.failed', message: (error as Error).message }); }
    // fdc stopping: nothing stays held.
    this.outbox.releaseHeld();
    const agentClosed = this.adapter.close();
    this.forks.close();
    clearInterval(this.statusTimer); clearInterval(this.voiceSessions.audioWatchdog); clearInterval(this.voiceSessions.standbyTimer); clearTimeout(this.agentLostTimer); clearTimeout(this.tuneTimer);
    if (this.live) await this.live.close('harness stopped');
    this.voiceSessions.handOffCarried();
    this.mediator?.stop();
    this.noteHotkey?.close(); this.notes.close();
    this.audit?.close(); this.jevAudit?.close(); this.stage.close(); this.saveTimeline();
    this.pages.close();
    await this.endpoints.close();
    await agentClosed;
  }
}
