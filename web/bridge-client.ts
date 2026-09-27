// The page's side of /voice: status and events in; controls, audio levels and
// audit samples out.
export type BridgeEvent = { type: string; [field: string]: any };

export class BridgeClient {
  ws?: WebSocket;
  /** When the last message arrived: the bridge sends status every second. */
  lastMessageAt = 0;
  connect(token: string, { onOpen, onEvent, onClose }: { onOpen(): void; onEvent(event: BridgeEvent): void; onClose(): void }) {
    this.close();
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/voice`, ['fd-voice', token]); ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.lastMessageAt = Date.now(); onOpen(); };
    ws.onmessage = ({ data }) => { this.lastMessageAt = Date.now(); if (typeof data === 'string') onEvent(JSON.parse(data)); };
    // A refused or failed connection closes too; the page finds out why.
    ws.onclose = () => { if (this.ws === ws) onClose(); };
  }
  get open() { return this.ws?.readyState === WebSocket.OPEN; }
  get connecting() { return this.ws?.readyState === WebSocket.CONNECTING; }
  get bufferedAmount() { return this.ws!.bufferedAmount; }
  send(event: Record<string, unknown>) { if (this.open) this.ws!.send(JSON.stringify(event)); }
  close() { const ws = this.ws; this.ws = undefined; ws?.close(); }
}
