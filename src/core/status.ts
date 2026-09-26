import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { Timeline } from './timeline.ts';
import type { Harness } from './bridge.ts';
import { speakingPolicy } from './voice-policy.ts';

export type BridgeEvent = Record<string, any>;
// Events the page replays after a reload.
const HISTORY_TYPES = ['caption', 'task', 'fault', 'agent_input', 'agent_text'];

// The run's event log and the stream of updates to the page.
export class StatusLog {
  runDir: string; clean: (text: string) => string; timeline: Timeline;
  browser: () => WebSocket | null | undefined;
  uiEvents: BridgeEvent[] = [];
  constructor({ runDir, clean, timeline, browser }: { runDir: string; clean: (text: string) => string; timeline: Timeline; browser: () => WebSocket | null | undefined }) {
    this.runDir = runDir; this.clean = clean; this.timeline = timeline; this.browser = browser;
  }
  log = (event: BridgeEvent) => fs.appendFileSync(path.join(this.runDir, 'events.jsonl'), this.clean(JSON.stringify({ at: Date.now(), ...event })) + '\n', { mode: 0o600 });
  publish = (event: BridgeEvent) => {
    event = { at: Date.now(), ...event };
    const items = this.timeline.add(event), browser = this.browser();
    if (items.length && browser?.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type: 'timeline_update', items }));
    if (HISTORY_TYPES.includes(event.type)) { this.uiEvents.push(event); if (this.uiEvents.length > 600) this.uiEvents.shift(); }
    if (browser?.readyState === WebSocket.OPEN) browser.send(JSON.stringify(event));
  };
  fault = (error: Error) => { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: this.clean(error.message) }); };
  saveTimeline() { fs.writeFileSync(path.join(this.runDir, 'timeline.json'), this.clean(JSON.stringify(this.timeline.snapshot())), { mode: 0o600 }); }
}

// Everything the page shows about the bridge, sent every second and on change.
export function statusSnapshot(bridge: Harness) {
  const { voiceSessions: voice, observer } = bridge;
  const live = voice.live;
  const budget = bridge.ledger.summary();
  const speakingUpdate = ['new', 'connecting', 'active'].includes(live?.state as string)
    ? voice.speakingUpdate : { state: 'next_session', level: voice.speakingLevel };
  const prompt = {
    instructions: live?.instructions ?? voice.instructions(),
    mode: live?.id ? live.state === 'closed' ? 'previous' : 'session' : 'preview',
    speakingPreference: speakingPolicy(bridge.agent, voice.speakingLevel),
    additional: voice.additionalInstructions.map(item => ({ ...item, state: item.sessionId === live?.id && live?.state === 'active' ? item.state : 'next_session' })),
  };
  const context = voice.mediator?.context;
  const feed = voice.mediator?.feed;
  const contextDelivery = { waiting: context?.queue.length ?? 0, inFlight: context?.inFlight ?? 0,
    observationsWaiting: feed?.pending.length ?? 0,
    oldestObservationMs: feed?.pending.length ? Date.now() - feed.pending[0].receivedAt : 0,
    pendingEstimatedTokens: context?.inFlightTokens ?? 0,
    estimatedBacklogSeconds: context ? context.inFlightTokens / context.tokensPerSecond : 0 };
  return { type: 'status', agent: observer.state, agentReady: Boolean(bridge.agentReady), live: live?.state ?? 'disconnected', cwd: bridge.cwd, sessionId: bridge.sessionId, usageSeconds: live?.usageSeconds ?? 0, committedUsd: budget.committedUsd, runDir: bridge.runDir, observation: bridge.observation, speakingLevel: voice.speakingLevel, speakingUpdate, prompt, contextDelivery };
}
