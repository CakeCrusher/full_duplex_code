import fs from 'node:fs';
import path from 'node:path';
import type { Timeline } from './timeline.ts';
import type { Page, Pages } from './pages.ts';
import type { Harness } from './bridge.ts';
import { speakingPolicy } from './voice-policy.ts';

export type BridgeEvent = Record<string, any>;
// Events the page replays after a reload.
const HISTORY_TYPES = ['caption', 'task', 'fault', 'agent_input', 'agent_text'];

// The run's event log and the stream of updates to the pages.
export class StatusLog {
  runDir: string; clean: (text: string) => string; timeline: Timeline; pages: Pages;
  uiEvents: BridgeEvent[] = [];
  constructor({ runDir, clean, timeline, pages }: { runDir: string; clean: (text: string) => string; timeline: Timeline; pages: Pages }) {
    this.runDir = runDir; this.clean = clean; this.timeline = timeline; this.pages = pages;
  }
  log = (event: BridgeEvent) => fs.appendFileSync(path.join(this.runDir, 'events.jsonl'), this.clean(JSON.stringify({ at: Date.now(), ...event })) + '\n', { mode: 0o600 });
  /** Sends an event to every page, or only to the page it concerns; the timeline is every page's. */
  publish = (event: BridgeEvent, page?: Page) => {
    event = { at: Date.now(), ...event };
    const items = this.timeline.add(event);
    if (items.length) this.pages.broadcast({ type: 'timeline_update', items });
    if (HISTORY_TYPES.includes(event.type)) { this.uiEvents.push(event); if (this.uiEvents.length > 600) this.uiEvents.shift(); }
    if (page) this.pages.send(page, event); else this.pages.broadcast(event);
  };
  fault = (error: Error, page?: Page) => { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: this.clean(error.message) }, page); };
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
  // The page running voice, so that the others can offer to move it.
  const voicePage = live && live.state !== 'closed' ? voice.page?.id ?? null : null;
  return { type: 'status', agent: observer.state, agentReady: Boolean(bridge.agentReady), live: live?.state ?? 'disconnected', voicePage, pages: bridge.pages.size, cwd: bridge.cwd, sessionId: bridge.sessionId, usageSeconds: live?.usageSeconds ?? 0, committedUsd: budget.committedUsd, runDir: bridge.runDir, observation: bridge.observation, speakingLevel: voice.speakingLevel, speakingUpdate, prompt, contextDelivery };
}
