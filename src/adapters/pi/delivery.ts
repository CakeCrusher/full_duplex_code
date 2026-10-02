import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { AgentSocket, DeliveryResult, VoiceRequest } from '../../core/adapter.ts';

// Delivers requests through the companion's extension inside Pi: it connects to
// the bridge at /pi and hands each request to Pi as a steer, which reaches a
// running turn, or starts one while Pi is idle. Emits `connection`, `delivery`,
// `update` and `fault` for the adapter.
export class PiDelivery extends EventEmitter implements AgentSocket {
  log: (event: Record<string, unknown>) => void;
  ready = false; stopping = false;
  socket?: WebSocket;
  // Requests written to the socket and not yet confirmed.
  pending = new Map<string, (result: DeliveryResult) => void>();
  constructor(log: (event: Record<string, unknown>) => void) { super(); this.log = log; }
  available() { return this.socket?.readyState !== WebSocket.OPEN; }
  attach(ws: WebSocket) {
    this.socket = ws;
    ws.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString());
        this.log(event);
        if (event.type === 'pi.ready') { this.ready = true; this.emit('connection', true); }
        if (event.type === 'pi.sent') this.confirmed(event.id);
        this.emit('update');
      } catch (error) { this.emit('fault', error); }
    });
    ws.on('error', error => this.emit('fault', error));
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.ready = false; this.emit('connection', false);
      if (this.stopping) return;
      // Pi switching sessions reconnects; a request in flight is never resent.
      const error = new Error('A voice message has uncertain delivery; it will not be automatically resent.');
      for (const [id, resolve] of this.pending) { this.pending.delete(id); resolve({ state: 'uncertain', error }); }
    });
  }
  confirmed(id: string) {
    const resolve = this.pending.get(id);
    if (resolve) { this.pending.delete(id); resolve({ state: 'sent' }); }
    else this.emit('delivery', { id, state: 'sent' });
  }
  deliver(request: VoiceRequest): Promise<DeliveryResult> {
    return new Promise(resolve => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) return resolve({ state: 'uncertain', error: new Error("Pi's companion extension is not connected.") });
      this.pending.set(request.id, resolve);
      socket.send(JSON.stringify({ type: 'pi.deliver', id: request.id, content: request.content }), error => {
        if (!error || this.pending.get(request.id) !== resolve) return;
        this.pending.delete(request.id); resolve({ state: 'uncertain', error });
      });
    });
  }
  close() { this.stopping = true; }
}
