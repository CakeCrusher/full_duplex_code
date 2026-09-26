import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { AgentSocket, DeliveryResult, VoiceRequest } from '../../core/adapter.ts';

// Delivers requests through the voice channel: the MCP server Claude runs
// (channel-server.ts) connects back to the bridge at /channel and turns each
// request into a channel notification, which reaches Claude even mid-turn.
// Emits `connection`, `delivery`, `update` and `fault` for the adapter.
export class ChannelDelivery extends EventEmitter implements AgentSocket {
  log: (event: Record<string, unknown>) => void;
  ready = false; stopping = false;
  channel?: WebSocket;
  // Requests written to the channel and not yet confirmed.
  pending = new Map<string, (result: DeliveryResult) => void>();
  constructor(log: (event: Record<string, unknown>) => void) { super(); this.log = log; }
  available() { return this.channel?.readyState !== WebSocket.OPEN; }
  attach(ws: WebSocket) {
    this.channel = ws;
    ws.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString());
        this.log(event);
        if (event.type === 'channel.ready') { this.ready = true; this.emit('connection', true); }
        if (event.type === 'channel.sent') this.confirmed(event.id ?? event.message_id);
        this.emit('update');
      } catch (error) { this.emit('fault', error); }
    });
    ws.on('error', error => this.emit('fault', error));
    ws.on('close', () => {
      if (this.channel !== ws) return;
      this.ready = false; this.emit('connection', false);
      if (this.stopping) return;
      const error = new Error('A voice message has uncertain delivery; it will not be automatically resent.');
      for (const [id, resolve] of this.pending) { this.pending.delete(id); resolve({ state: 'uncertain', error }); }
    });
  }
  confirmed(id: string) {
    const resolve = this.pending.get(id);
    if (resolve) { this.pending.delete(id); resolve({ state: 'sent' }); }
    // The channel server keeps confirmations while it reconnects, so a request
    // reported uncertain can still be confirmed later.
    else this.emit('delivery', { id, state: 'sent' });
  }
  deliver(request: VoiceRequest): Promise<DeliveryResult> {
    return new Promise(resolve => {
      const channel = this.channel;
      if (channel?.readyState !== WebSocket.OPEN) return resolve({ state: 'uncertain', error: new Error('The voice channel is not connected.') });
      this.pending.set(request.id, resolve);
      channel.send(JSON.stringify({ type: 'channel.deliver', id: request.id, content: request.content }), error => {
        if (!error || this.pending.get(request.id) !== resolve) return;
        this.pending.delete(request.id); resolve({ state: 'uncertain', error });
      });
    });
  }
  close() { this.stopping = true; }
}
