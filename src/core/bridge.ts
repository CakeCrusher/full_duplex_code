import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AgentAdapter, AgentDefinition, AgentLaunch, VoiceRequest } from './adapter.ts';
import type { AgentObserver } from './agent-observer.ts';
import { redact } from './redact.ts';
import { UsageLedger } from './usage-ledger.ts';
import { Timeline } from './timeline.ts';
import { StatusLog, statusSnapshot, type BridgeEvent } from './status.ts';
import { Outbox } from './outbox.ts';
import { VoiceSessions, type SpeakingUpdate } from './voice-sessions.ts';
import { Endpoints } from './endpoints.ts';

export interface HarnessOptions {
  /** The coding agent, from src/adapters. */
  agent: AgentDefinition;
  root: string; runDir: string; cwd: string; sessionId: string; apiKey: string;
  voice?: string; observation?: string; port?: number; portFallback?: boolean; publicUrl?: string;
  /** The agent's own command-line arguments, and whether it resumes a session. */
  agentArgs?: string[]; resume?: boolean;
}

// The bridge: one local process between the page, GPT Live and the agent.
// It owns the shared state; each concern lives in its own module.
export class Harness {
  agent: AgentDefinition; adapter: AgentAdapter; observer: AgentObserver;
  root: string; runDir: string; cwd: string; sessionId: string; apiKey: string;
  voice: string; observation: string; port: number; portFallback: boolean;
  browserToken = randomBytes(32).toString('hex');
  // Authenticates the agent's side: hooks and adapter sockets.
  agentToken = randomBytes(32).toString('hex');
  publicOrigin: string | null = null; publicBrowserUrl: string | null = null;
  baseUrl = ''; browserUrl = ''; portFellBack = false;
  agentReady = false; stopping = false;
  browser: WebSocket | null = null;
  agentLaunch?: AgentLaunch;
  clean: (text: unknown) => string;
  statusLog: StatusLog; log: (event: BridgeEvent) => void; publish: (event: BridgeEvent) => void; fault: (error: Error) => void;
  ledger: UsageLedger; timeline: Timeline; outbox: Outbox; voiceSessions: VoiceSessions; endpoints: Endpoints;
  statusTimer?: NodeJS.Timeout; agentLostTimer?: NodeJS.Timeout;
  constructor({ agent, root, runDir, cwd, sessionId, apiKey, voice = 'marin', observation = 'hooks', port = 0, portFallback = false, publicUrl, agentArgs = [], resume = false }: HarnessOptions) {
    this.agent = agent; this.root = root; this.runDir = runDir; this.cwd = cwd; this.sessionId = sessionId; this.apiKey = apiKey;
    this.voice = voice; this.observation = observation; this.port = port; this.portFallback = portFallback;
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    if (publicUrl) this.setPublicUrl(publicUrl);
    this.clean = text => redact(text, [apiKey, this.browserToken, this.agentToken]);
    this.timeline = new Timeline(undefined, agent);
    this.statusLog = new StatusLog({ runDir, clean: this.clean, timeline: this.timeline, browser: () => this.browser });
    this.log = this.statusLog.log; this.publish = this.statusLog.publish; this.fault = this.statusLog.fault;
    this.ledger = new UsageLedger(path.join(root, '.runs', 'budget.json'));
    this.voiceSessions = new VoiceSessions(this);
    this.outbox = new Outbox({ agent, adapter: () => this.adapter, ready: () => this.agentReady, clean: this.clean, log: this.log,
      publish: event => this.publish(event), fault: error => this.fault(error), onSent: entry => this.voiceSessions.confirmDelivery(entry) });
    this.adapter = agent.create({ root, runDir, cwd, sessionId, observation, agentArgs, resume, clean: this.clean, log: this.log });
    const observer = this.observer = this.adapter.observations;
    observer.on('input', event => { this.log({ type: 'agent.input', ...event }); this.publish({ type: 'agent_input', ...event }); });
    observer.on('text', event => { this.log({ type: 'agent.text', ...event }); this.publish({ type: 'agent_text', ...event }); });
    observer.on('observation', event => this.publish({ type: 'agent_observation', ...event }));
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
  get speakingLevel() { return this.voiceSessions.speakingLevel; }
  get speakingUpdate() { return this.voiceSessions.speakingUpdate; }
  set speakingUpdate(update: SpeakingUpdate) { this.voiceSessions.speakingUpdate = update; }
  get uiEvents() { return this.statusLog.uiEvents; }
  // Public address of a tunnel that forwards to this bridge. Known only after
  // the tunnel starts, which needs the bridge's port first.
  setPublicUrl(url: string) {
    this.publicOrigin = new URL(url).origin;
    this.publicBrowserUrl = `${this.publicOrigin}/#${this.browserToken}`;
  }
  saveTimeline() { this.statusLog.saveTimeline(); }
  status() { return statusSnapshot(this); }
  instructions() { return this.voiceSessions.instructions(); }
  appendInstruction(text: unknown) { return this.voiceSessions.appendInstruction(text); }
  setSpeakingLevel(level: unknown) { return this.voiceSessions.setSpeakingLevel(level); }
  startLive(sdp?: unknown) { return this.voiceSessions.start(sdp); }
  deliver(request: VoiceRequest) { this.outbox.add(request); }
  async start() {
    const port = await this.endpoints.listen(this.port, this.portFallback);
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.browserUrl = `${this.baseUrl}/#${this.browserToken}`;
    this.agentLaunch = this.adapter.launch({ baseUrl: this.baseUrl, token: this.agentToken });
    // This private descriptor permits repeatable local tests without exposing the API key.
    fs.writeFileSync(path.join(this.runDir, 'connection.json'), JSON.stringify({ baseUrl: this.baseUrl, browserToken: this.browserToken, sessionId: this.sessionId, cwd: this.cwd }, null, 2), { mode: 0o600 });
    this.statusTimer = setInterval(() => this.publish(this.status()), 1000);
    this.log({ type: 'bridge.started', sessionId: this.sessionId, cwd: this.cwd, baseUrl: this.baseUrl });
    return this;
  }
  async close() {
    if (this.stopping) return; this.stopping = true;
    this.adapter.close();
    clearInterval(this.statusTimer); clearInterval(this.voiceSessions.audioWatchdog); clearTimeout(this.agentLostTimer);
    if (this.live) await this.live.close('harness stopped');
    this.mediator?.stop();
    this.audit?.close(); this.saveTimeline();
    await this.endpoints.close();
  }
}
