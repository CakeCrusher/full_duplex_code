import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { UsageLedger } from './usage-ledger.ts';
import type { AppendKind } from './context-queue.ts';

export const SAMPLE_RATE = 24000;
export type LiveState = 'new' | 'connecting' | 'active' | 'closing' | 'closed';
export interface CloseResult { finalized: boolean; reserved: boolean; usageSeconds: number; sessionId?: string; reason: string; closeCode?: number }
interface Pending { resolve: (event: any) => void; reject: (error: Error) => void }

// One GPT Live session: created over HTTPS (WebRTC) or a WebSocket, or forked
// from a stored one, then controlled through its sideband socket.
export class LiveSession extends EventEmitter {
  apiKey: string; budget: UsageLedger; label: string; voice: string; instructions: string; input: unknown[];
  log: (event: Record<string, unknown>) => void; url: string;
  /** Whether OpenAI keeps the session for forking, as asked and as confirmed at startup; and the stored session this one forks. */
  store: boolean; stored = false; fork?: string;
  /** Someone asked for the close (rather than GPT Live or the connection ending it), and the page has the media answer. */
  requested = false; answered = false; socketClose?: { code: number; reason: string };
  state: LiveState = 'new';
  pending = new Map<string, Pending>();
  usageSeconds = 0;
  closed: Promise<CloseResult>;
  resolveClosed!: (result: CloseResult) => void;
  id?: string; reservation?: string; startedAt?: number; transport?: 'webrtc' | 'websocket';
  ws?: WebSocket; creation?: AbortController; finalEvent?: any; audioBytes?: number; closeReason?: string;
  resolveReady?: (event: any) => void; rejectReady?: (error: Error) => void;
  startTimer?: NodeJS.Timeout; closeTimer?: NodeJS.Timeout; ackTimer?: NodeJS.Timeout | null;
  constructor({ apiKey, budget, label = 'voice session', voice = 'marin', instructions = '', input = [], log = () => {}, url = 'wss://api.openai.com/v1/live/sessions', store = false, fork }: {
    apiKey: string; budget: UsageLedger; label?: string; voice?: string; instructions?: string; input?: unknown[];
    log?: (event: Record<string, unknown>) => void; url?: string; store?: boolean; fork?: string;
  }) {
    super();
    this.apiKey = apiKey; this.budget = budget; this.label = label; this.voice = voice; this.instructions = instructions; this.input = input; this.log = log; this.url = url;
    this.store = store; this.fork = fork;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start(sdp?: string) {
    if (this.state !== 'new') throw new Error('Session already started');
    try {
      if (!this.apiKey) throw new Error('OPENAI_API_KEY is missing');
      this.reservation = this.budget.reserve(null, this.label);
    } catch (error) {
      // A rejected start must release the microphone, allow another attempt,
      // and settle close() even though no API connection was opened.
      this.finish(false);
      throw error;
    }
    this.state = 'connecting';
    this.transport = sdp ? 'webrtc' : 'websocket';
    let answer: any;
    // A fork inherits the model, instructions, input and conversation; only storage (and the WebSocket audio format) may change.
    const forkPath = this.fork ? `/${encodeURIComponent(this.fork)}/fork` : '';
    let socketUrl = this.url + forkPath;
    if (sdp) {
      this.creation = new AbortController();
      try {
        const response = await fetch(this.url.replace(/^ws/, 'http') + forkPath, {
          method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: this.fork ? { store: this.store } : { model: 'gpt-live-1', instructions: this.instructions, input: this.input,
            audio: { output: { voice: this.voice } }, delegation: { type: 'client' }, store: this.store },
          transport: { type: 'webrtc', sdp } }),
          signal: AbortSignal.any([this.creation.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) {
          const detail = await response.json().then(body => body?.error?.message, () => undefined);
          throw new Error(`OpenAI voice connection failed (HTTP ${response.status}${typeof detail === 'string' ? `: ${detail.slice(0, 300)}` : ''}).`);
        }
        answer = await response.json();
        if (!answer.session?.id || !answer.transport?.sdp) throw new Error('OpenAI returned an incomplete voice connection.');
        this.id = answer.session.id;
        socketUrl = `${this.url}/${encodeURIComponent(this.id!)}/attach`;
      } catch (error) { this.finish(false); throw error; }
      if ((this.state as LiveState) === 'closed') throw new Error('Voice startup canceled');
    }
    const ws = this.ws = new WebSocket(socketUrl, { headers: { Authorization: `Bearer ${this.apiKey}` }, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    const ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.startTimer = setTimeout(() => this.abort('session startup timed out'), 20000);
    const format = { type: 'audio/pcm', rate: SAMPLE_RATE };
    ws.on('open', () => {
      if (answer) { this.answered = true; this.emit('answer', answer.transport.sdp); return; }
      ws.send(JSON.stringify({ type: 'session.start', event_id: randomUUID(), session: this.fork ? { store: this.store, audio: { format } } : {
        model: 'gpt-live-1', instructions: this.instructions, input: this.input,
        audio: { format, output: { voice: this.voice } }, delegation: { type: 'client' }, store: this.store,
      } }));
    });
    ws.on('message', raw => {
      try { this.receive(JSON.parse(raw.toString())); }
      catch (err) { this.emit('fault', err); this.abort((err as Error).message); }
    });
    ws.on('error', err => { this.emit('fault', err); this.abort(err.message); });
    ws.on('close', (code, reason) => {
      this.socketClose = { code, reason: reason.toString() };
      this.log({ type: 'bridge.live_socket_closed', code, reason: this.socketClose.reason || undefined });
      this.finish(false);
    });
    return ready;
  }
  receive(event: any) {
    if (!['session.output_audio.delta', 'session.input_audio.append'].includes(event.type)) this.log({ direction: 'received', ...event });
    if (event.type === 'session.started') {
      clearTimeout(this.startTimer); this.state = 'active'; this.id = event.session.id; this.startedAt = Date.now();
      // OpenAI says whether it keeps the session; a fork reports the instructions it inherited.
      this.stored = event.session.store ?? this.store;
      if (this.fork && typeof event.session.instructions === 'string') this.instructions = event.session.instructions;
      this.budget.update(this.reservation!, 0, { sessionId: this.id });
      this.resolveReady!(event);
    }
    if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      this.usageSeconds = Math.max(this.usageSeconds, event.usage?.seconds ?? 0);
      this.budget.update(this.reservation!, this.usageSeconds, { finalized: event.type === 'session.closed', sessionId: this.id, reason: event.reason });
    }
    const ackId = event.client_event_id ?? event.error?.client_event_id;
    if (ackId && this.pending.has(ackId)) {
      const p = this.pending.get(ackId)!; this.pending.delete(ackId);
      this.watchAcknowledgments();
      if (event.type === 'error') p.reject(new Error(event.error?.message ?? 'Command rejected')); else p.resolve(event);
    }
    this.emit('event', event);
    if (event.type === 'error' && this.state !== 'closing') {
      this.emit('fault', new Error(event.error?.message ?? 'Live API error'));
      if (this.state === 'connecting') this.abort(event.error?.message ?? 'Startup rejected');
    }
    if (event.type === 'session.closed') { this.finalEvent = event; this.ws!.close(); this.finish(true); }
  }
  send(event: Record<string, any>) {
    if (this.state !== 'active' || this.ws!.readyState !== WebSocket.OPEN) throw new Error(`Live session is ${this.state}`);
    if (this.ws!.bufferedAmount > 1024 * 1024) { this.abort('Network backpressure'); throw new Error('Live connection too slow'); }
    if (event.type !== 'session.input_audio.append') this.log({ direction: 'sent', ...event });
    this.ws!.send(JSON.stringify(event));
    this.emit('sent', event);
  }
  audio(pcm: Buffer) {
    if (this.transport === 'webrtc') throw new Error('WebRTC microphone audio must use the media track.');
    if (this.state !== 'active') return;
    if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples');
    const audioSeconds = ((this.audioBytes ?? 0) + pcm.length) / (SAMPLE_RATE * 2);
    if (audioSeconds > (Date.now() - this.startedAt!) / 1000 + 2) {
      this.close('Input audio exceeded real-time pacing');
      throw new Error('Audio must be streamed at real-time speed');
    }
    this.audioBytes = (this.audioBytes ?? 0) + pcm.length;
    this.send({ type: 'session.input_audio.append', audio: pcm.toString('base64') });
  }
  append(kind: AppendKind, content: string, delegationId: string | null = null): Promise<any> {
    const eventId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(eventId, { resolve, reject });
      if (!this.ackTimer) this.watchAcknowledgments();
      try { this.send({ type: `session.${kind}.append`, event_id: eventId, delegation_id: delegationId, content }); }
      catch (err) { this.pending.delete(eventId); this.watchAcknowledgments(); reject(err); }
    });
  }
  watchAcknowledgments() {
    clearTimeout(this.ackTimer ?? undefined); this.ackTimer = null;
    if (!this.pending.size) return;
    // Appends enter the model over time. A large burst can legitimately take
    // longer than 20 seconds; detect stalled progress instead of aging each
    // individual append while earlier context is still being acknowledged.
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      const pending = [...this.pending.values()]; this.pending.clear();
      for (const p of pending) p.reject(new Error('Context acknowledgments stalled for 20 seconds'));
    }, 20000);
  }
  /** A one-time welcome at the start of the connection. */
  async greet(text: string) {
    await this.append('commentary', text);
  }
  close(reason = 'requested'): Promise<CloseResult> {
    this.closeReason ??= reason; this.requested = true;
    if (this.state === 'active') {
      this.log({ type: 'bridge.closing', reason });
      this.send({ type: 'session.close', event_id: randomUUID() }); this.state = 'closing';
      this.closeTimer = setTimeout(() => this.abort('Final usage timeout'), 15000);
    } else if (this.state === 'new' || this.state === 'connecting') this.abort(reason);
    return this.closed;
  }
  abort(reason: string) {
    if (this.state === 'closed') return;
    this.closeReason ??= reason;
    this.log({ type: 'bridge.aborted', reason });
    this.creation?.abort();
    this.rejectReady?.(new Error(reason));
    this.ws?.terminate(); this.finish(false);
  }
  finish(finalized: boolean) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of [this.startTimer, this.closeTimer, this.ackTimer]) clearTimeout(timer ?? undefined);
    this.rejectReady?.(new Error('Connection closed before startup'));
    for (const p of this.pending.values()) p.reject(new Error('Session closed'));
    this.pending.clear();
    const result = { finalized: Boolean(finalized || this.finalEvent), reserved: Boolean(this.reservation), usageSeconds: this.usageSeconds, sessionId: this.id,
      reason: this.closeReason ?? (this.finalEvent ? `closed by GPT Live (${this.finalEvent.reason ?? 'no reason given'})` : 'connection to GPT Live lost'), closeCode: this.socketClose?.code };
    this.log({ type: 'bridge.closed', ...result }); this.resolveClosed(result); this.emit('closed', result);
  }
}
