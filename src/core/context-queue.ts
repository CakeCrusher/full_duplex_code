import type { AgentProfile } from './adapter.ts';
import { estimatedTokens, textFragments } from './text-fragments.ts';
import type { Floor } from './floor.ts';

export type AppendKind = 'thinking' | 'commentary' | 'instructions';
/** The part of a Live session the queue writes to. */
export interface ContextSink {
  state: string;
  ws?: { bufferedAmount: number };
  append(kind: AppendKind, content: string, delegationId?: string | null): Promise<unknown>;
}
interface Fragment { kind: AppendKind; content: string; delegationId: string | null; source: string; queuedAt: number }

export class ContextQueue {
  live: ContextSink;
  onError: (error: Error) => void;
  agent: { profile: AgentProfile };
  queue: Fragment[] = [];
  inFlight = 0; inFlightTokens = 0; tokensPerSecond = 300;
  running = false; stopped = false;
  writeTimer: NodeJS.Timeout | null = null;
  /** While the operator holds the floor, agent context waits, at most `holdMs` from when it was queued. */
  floor?: Floor; holdMs: number;
  constructor(live: ContextSink, onError: (error: Error) => void, agent: { profile: AgentProfile }, { floor, holdMs = 10000 }: { floor?: Floor; holdMs?: number } = {}) {
    this.live = live; this.onError = onError; this.agent = agent; this.floor = floor; this.holdMs = holdMs;
  }
  add(kind: AppendKind, text: string, delegationId: string | null = null, source = '') {
    if (this.stopped || !text) return;
    // Preserve the prepared representation. Chunking is an API transport
    // requirement; overload decisions belong in the feed, before this queue.
    // Budget the label too; six-digit fragment counts leave room for any event
    // permitted by the local transport limit. Never split a Unicode character.
    const prefix = source ? `[${source}; part 999999/999999]\n` : '';
    const parts = textFragments(text, prefix);
    const queuedAt = Date.now();
    for (const [index, content] of parts.entries()) this.queue.push({ kind, content, delegationId, source: source ? `[${source}; part ${index + 1}/${parts.length}]\n` : '', queuedAt });
    this.pump();
  }
  pump() {
    if (this.writeTimer) clearTimeout(this.writeTimer); this.writeTimer = null;
    // WebSocket writes preserve order. Track API acknowledgments independently:
    // waiting for estimated model injection before another write adds latency.
    // Only actual socket backpressure holds delivery, never speech or an ACK.
    while (!this.stopped && this.queue.length && this.live.state === 'active') {
      if ((this.live.ws?.bufferedAmount ?? 0) > 64 * 1024) {
        this.writeTimer = setTimeout(() => this.pump(), 10);
        return;
      }
      // Agent context, including the rest of a batch already going in, waits for the
      // operator to finish. Answers about a delegation do not.
      const next = this.queue[0];
      if (next.kind === 'thinking' && next.delegationId === null && this.floor?.held() && Date.now() < next.queuedAt + this.holdMs) {
        this.writeTimer = setTimeout(() => this.pump(), 100);
        return;
      }
      const { kind, content, delegationId, source = '' } = this.queue.shift()!;
      this.inFlight++; this.running = true;
      // Each append can be a fragment of code or first-person assistant text.
      // Keep its source clear even when the observation header is far behind.
      const framed = source + content;
      const tokens = estimatedTokens(framed); this.inFlightTokens += tokens;
      this.live.append(kind, framed, delegationId).then(ack => {
        const { start_ms, end_ms } = (ack ?? {}) as { start_ms?: number; end_ms?: number };
        const seconds = (end_ms! - start_ms!) / 1000;
        if (seconds > 0) this.tokensPerSecond = .8 * this.tokensPerSecond + .2 * Math.max(100, Math.min(600, tokens / seconds));
      }).catch(error => {
        if (!this.stopped && this.live.state === 'active') {
          this.stop();
          this.onError(new Error(`${this.agent.profile.name} context delivery failed; restart voice to reconnect.${error.message}`));
        }
      }).finally(() => { this.inFlight--; this.inFlightTokens -= tokens; this.running = this.inFlight > 0; });
    }
  }
  stop() { this.stopped = true; this.queue.length = 0; if (this.writeTimer) clearTimeout(this.writeTimer); this.writeTimer = null; }
}
