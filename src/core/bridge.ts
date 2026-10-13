import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentAdapter, AgentDefinition, AgentLaunch, VoiceRequest } from './adapter.ts';
import type { AgentObserver } from './agent-observer.ts';
import { redact } from './redact.ts';
import { withoutBinary } from './context-rules.ts';
import { InstructionLearner, LearnedLog, type LearnedInstruction } from './instruction-learner.ts';
import { DelegationAudit } from './delegation-audit.ts';
import { askAgent, distillPrompt, parseDistilled } from './instruction-distiller.ts';
import { JevTuner, type TuningChange } from './jev-tuner.ts';
import { UsageLedger } from './usage-ledger.ts';
import { Timeline } from './timeline.ts';
import { StatusLog, statusSnapshot, type BridgeEvent } from './status.ts';
import { Outbox } from './outbox.ts';
import { VoiceSessions } from './voice-sessions.ts';
import { Endpoints } from './endpoints.ts';
import { Pages, type Page } from './pages.ts';
import { tuning, type Tuning } from './tuning.ts';
import { CompanionRegistry, type CompanionEntry } from './companions.ts';
import { SessionSwitch } from './sessions.ts';

export interface HarnessOptions {
  /** The coding agent, from src/adapters. */
  agent: AgentDefinition;
  root: string; runDir: string; cwd: string; apiKey: string;
  /** The agent session's ID; when unknown, it is learned from the agent's first event. */
  sessionId?: string;
  voice?: string; observation?: string; port?: number; portFallback?: boolean; publicUrl?: string;
  /** A TypeSafe API key: Jev then learns the operator's standing instructions (instruction-learner.ts). */
  jevKey?: string;
  /** Overrides of the low-level settings for how agent updates reach GPT Live (tuning.ts). */
  tuning?: Partial<Tuning>;
  /** With a TypeSafe API key: Jev sets those settings from the operator's instructions (jev-tuner.ts). */
  jevTuning?: boolean;
  /** The agent's own command-line arguments. */
  agentArgs?: string[];
  /** Ask OpenAI to store voice sessions so that Resume voice can fork them (default true; --no-store turns it off). */
  store?: boolean;
}

// The bridge: one local process between the page, GPT Live and the agent.
// It owns the shared state; each concern lives in its own module.
export class Harness {
  agent: AgentDefinition; adapter: AgentAdapter; observer: AgentObserver;
  learner?: InstructionLearner; handOffAudit?: DelegationAudit; tuner?: JevTuner; learned: LearnedLog;
  /** Settings the operator set by hand (FDC_TUNING), which Jev leaves alone; and Jev's pending and latest asks. */
  pinned: (keyof Tuning)[] = []; tuneTimer?: NodeJS.Timeout; tuneAsks = 0;
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
  companions: CompanionRegistry;
  /** Turns the voice of running companions on and off, by voice. */
  sessionSwitch: SessionSwitch;
  /** Every open companion page. */
  pages: Pages;
  agentLaunch?: AgentLaunch;
  clean: (text: unknown) => string;
  statusLog: StatusLog; log: (event: BridgeEvent) => void; publish: (event: BridgeEvent, page?: Page) => void; fault: (error: Error, page?: Page) => void;
  ledger: UsageLedger; timeline: Timeline; outbox: Outbox; voiceSessions: VoiceSessions; endpoints: Endpoints;
  statusTimer?: NodeJS.Timeout; agentLostTimer?: NodeJS.Timeout;
  constructor({ agent, root, runDir, cwd, sessionId, apiKey, voice = 'marin', observation = agent.observationModes[0] ?? '', port = 0, portFallback = false, publicUrl, agentArgs = [], jevKey, tuning: overrides, jevTuning = false, store = true }: HarnessOptions) {
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
    this.learned = new LearnedLog(path.join(root, '.runs', 'learned-instructions.jsonl'));
    if (jevKey && jevTuning) this.tuner = new JevTuner({ apiKey: jevKey, log: this.log });
    if (jevKey) this.handOffAudit = new DelegationAudit({ apiKey: jevKey, file: path.join(root, '.runs', 'delegation-audit.jsonl'), log: this.log });
    this.companions = new CompanionRegistry(path.join(root, '.runs', 'companions'));
    this.sessionSwitch = new SessionSwitch(this);
    this.voiceSessions = new VoiceSessions(this, { store });
    if (jevKey) this.learner = new InstructionLearner({ apiKey: jevKey, log: this.log,
      onJudged: judged => { if (!judged.learned) this.jevCheck(judged.requestId, 'instruction', `Not a standing instruction (${judged.behave.toFixed(2)})`, judged); },
      onLearn: instruction => { this.learnInstruction(instruction).catch(error => this.fault(error as Error)); } });
    this.outbox = new Outbox({ agent, adapter: () => this.adapter, ready: () => this.agentReady, clean: this.clean, log: this.log,
      publish: event => this.publish(event), fault: error => this.fault(error), onSent: entry => this.voiceSessions.confirmDelivery(entry) });
    this.adapter = agent.create({ root, runDir, cwd, sessionId, observation, agentArgs, clean: this.clean, log: this.log });
    const observer = this.observer = this.adapter.observations;
    observer.on('input', event => { this.log({ type: 'agent.input', ...event }); this.publish({ type: 'agent_input', ...event }); });
    observer.on('text', event => { this.log({ type: 'agent.text', ...event }); this.publish({ type: 'agent_text', ...event }); });
    // Pages show observations without their binary data, which stays in the local log: an image
    // read can be over a megabyte, and a page connection backed up with it looks like slow playback.
    observer.on('observation', ({ raw, ...event }) => this.publish({ type: 'agent_observation', ...event, text: withoutBinary(event.text) }));
    observer.on('status', event => { this.log({ type: 'agent.status', ...event }); this.publish({ type: 'agent_status', ...event }); });
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
  deliver(request: VoiceRequest) { this.outbox.add(request); }
  /** A one-off run of the harness for a short piece of writing (tests replace it). */
  ask = (prompt: string) => askAgent(this.agent, prompt, { cwd: this.cwd });
  /** One of Jev's checks of a request to the harness, for the page's request inspector. */
  jevCheck(requestId: string | undefined, kind: 'instruction' | 'handoff', outcome: string, { said, behave, design, lasting }: { said?: string; behave?: number; design?: number; lasting?: string } = {}) {
    if (requestId) this.publish({ type: 'jev_check', requestId, at: Date.now(), kind, outcome, words: said, scores: { behave: behave ?? null, design: design ?? null, lasting: lasting ?? null } });
  }
  // Jev found a likely standing instruction; a one-off run of the harness writes what it says (the
  // operator's words are speech), or finds there is none or one in force already says it.
  async learnInstruction(instruction: LearnedInstruction) {
    const inForce = this.voiceSessions.additionalInstructions.filter(item => item.learned).map(item => ({ id: item.learned!, text: item.text.replace(`${item.learned}: `, '') }));
    let text = instruction.text;
    try {
      const reply = await this.ask(distillPrompt({ said: instruction.said ?? instruction.text, previous: instruction.previous, companion: instruction.companion, inForce, scores: instruction }));
      const distilled = parseDistilled(this.clean(reply));
      this.log({ type: 'instruction.distilled', said: instruction.said, distilled, requestId: instruction.requestId });
      if ('same' in distilled) return this.jevCheck(instruction.requestId, 'instruction', `Already in force as ${distilled.same}`, instruction);
      text = distilled.text;
    } catch (error) {
      // Without the harness's wording, the operator's own words are kept, as before.
      this.log({ type: 'instruction.error', message: `Writing the instruction: ${(error as Error).message}` });
    }
    const id = await this.voiceSessions.learn({ ...instruction, text });
    this.jevCheck(instruction.requestId, 'instruction', `Learned ${id}: ${text}`, instruction);
  }
  /** New settings for how agent updates reach GPT Live, from now on. */
  setTuning(next: Tuning, changes: TuningChange[] = []) {
    this.tuning = next; this.mediator?.applyTuning(next);
    this.log({ type: 'tuning.changed', tuning: next, changes }); this.publish({ type: 'tuning', tuning: next, changes }); this.publish(this.status());
  }
  /** With Jev's tuning on: Jev re-reads the operator's instructions, and those from earlier sessions, and picks the settings that fit. */
  tuneFromInstructions() {
    if (!this.tuner) return;
    clearTimeout(this.tuneTimer);
    this.tuneTimer = setTimeout(async () => {
      // Only the newest ask may change the settings: an older answer arriving late would undo it.
      const ask = ++this.tuneAsks;
      try {
        const { tuning: next, changes } = await this.tuner!.choose({ instructions: this.voiceSessions.additionalInstructions.map(item => item.text), earlier: this.learned.earlier(this.sessionId), current: this.tuning, pinned: this.pinned });
        if (changes.length && ask === this.tuneAsks && !this.stopping) this.setTuning(next, changes);
      } catch (error) { this.log({ type: 'tuning.error', message: (error as Error).message }); }
    }, 1000);
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
    this.log({ type: 'bridge.started', sessionId: this.sessionId, cwd: this.cwd, baseUrl: this.baseUrl });
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
    const agentClosed = this.adapter.close();
    clearInterval(this.statusTimer); clearInterval(this.voiceSessions.audioWatchdog); clearTimeout(this.agentLostTimer); clearTimeout(this.tuneTimer);
    if (this.live) await this.live.close('harness stopped');
    this.voiceSessions.handOffCarried();
    this.mediator?.stop();
    this.audit?.close(); this.saveTimeline();
    this.pages.close();
    await this.endpoints.close();
    await agentClosed;
  }
}
