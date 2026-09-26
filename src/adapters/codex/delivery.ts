import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { DeliveryResult, ReceivedRequest, VoiceRequest } from '../../core/adapter.ts';

// A voice request as Codex receives it: labeled, so Codex and the timeline can
// tell it from typed input.
export const turnText = ({ id, content }: Pick<VoiceRequest, 'id' | 'content'>) => `[Voice request ${id}]\n${content}`;
export const turnInput = (request: Pick<VoiceRequest, 'id' | 'content'>) => [{ type: 'text', text: turnText(request), text_elements: [] }];
export function receivedRequest(prompt: string): ReceivedRequest | undefined {
  const match = prompt.match(/^\[Voice request ([0-9a-f-]{36})\]\n([\s\S]*)$/);
  return match ? { id: match[1], content: match[2] } : undefined;
}

interface Response { id: number; result?: any; error?: { code: number; message: string } }

// Delivers requests through Codex's app server, as a second client beside the
// terminal: turn/steer while a turn runs, and a new turn otherwise or when the
// steer is refused. Emits `connection`, `update` and `fault` for the adapter.
export class CodexDelivery extends EventEmitter {
  log: (event: Record<string, unknown>) => void;
  /** The running turn as the hooks report it, when the app server has not said. */
  turnHint: () => string | null;
  ws?: WebSocket; threadId?: string;
  ready = false; stopping = false;
  // The running turn, from the app server's own turn notifications.
  activeTurn: string | null = null; turnKnown = false;
  nextId = 1; pending = new Map<number, (response: Response) => void>();
  constructor({ log, turnHint }: { log: (event: Record<string, unknown>) => void; turnHint: () => string | null }) {
    super(); this.log = log; this.turnHint = turnHint;
  }
  async connect(url: string, token: string) {
    const ws = this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', raw => { try { this.receive(JSON.parse(raw.toString())); } catch (error) { this.emit('fault', error); } });
    ws.on('error', error => { if (!this.stopping) this.emit('fault', error); });
    ws.on('close', () => {
      for (const resolve of this.pending.values()) resolve({ id: 0, error: { code: -1, message: 'The Codex app server closed the connection.' } });
      this.pending.clear();
      if (this.ready) { this.ready = false; this.emit('connection', false); }
    });
    const initialized = await this.call('initialize', { clientInfo: { name: 'full_duplex_code', title: 'Full-Duplex Code', version: '0.1.0' } });
    if (initialized.error) throw new Error(`Codex app server: ${initialized.error.message}`);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
  }
  call(method: string, params: unknown, timeoutMs = 15000): Promise<Response> {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ id: 0, error: { code: -1, message: 'The Codex app server is not connected.' } });
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ id, error: { code: -1, message: `${method} timed out` } }); }, timeoutMs);
      this.pending.set(id, response => { clearTimeout(timer); resolve(response); });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  receive(message: any) {
    if (message.id !== undefined && this.pending.has(message.id)) { const resolve = this.pending.get(message.id)!; this.pending.delete(message.id); resolve(message); return; }
    // A request from the app server, such as an approval: the terminal answers it.
    if (message.id !== undefined && message.method) { this.log({ type: 'codex.server_request', method: message.method, threadId: message.params?.threadId }); return; }
    const params = message.params ?? {};
    if (params.threadId !== this.threadId) return;
    if (message.method === 'turn/started') { this.activeTurn = params.turn?.id ?? null; this.turnKnown = true; this.emit('update'); }
    if (message.method === 'turn/completed') { if (this.activeTurn === params.turn?.id) this.activeTurn = null; this.turnKnown = true; this.emit('update'); }
  }
  /** Subscribes to the terminal's thread once Codex has named it. */
  async attach(threadId: string) {
    this.threadId = threadId;
    const resumed = await this.call('thread/resume', { threadId, excludeTurns: true });
    if (resumed.error) { this.emit('fault', new Error(`Codex app server: ${resumed.error.message}`)); return; }
    this.log({ type: 'codex.attached', threadId });
    this.ready = true; this.emit('connection', true);
  }
  runningTurn() { return this.turnKnown ? this.activeTurn : this.turnHint(); }
  async deliver(request: VoiceRequest): Promise<DeliveryResult> {
    const threadId = this.threadId, input = turnInput(request), turn = this.runningTurn();
    if (!this.ready || !threadId) return { state: 'uncertain', error: new Error('Codex has not started its session yet.') };
    if (turn) {
      const steered = await this.call('turn/steer', { threadId, expectedTurnId: turn, input });
      this.log({ type: 'codex.delivery', id: request.id, via: 'turn/steer', turnId: turn, error: steered.error?.message });
      if (!steered.error) return { state: 'sent' };
      // The turn ended or changed meanwhile: the request starts a new one.
    }
    const started = await this.call('turn/start', { threadId, input });
    this.log({ type: 'codex.delivery', id: request.id, via: 'turn/start', turnId: started.result?.turn?.id, error: started.error?.message });
    if (!started.error) { this.activeTurn = started.result?.turn?.id ?? this.activeTurn; return { state: 'sent' }; }
    return { state: 'uncertain', error: new Error(`Codex did not accept the request: ${started.error.message}`) };
  }
  close() { this.stopping = true; this.ws?.close(); }
}
