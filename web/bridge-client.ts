// The page's side of /voice: status and events in; controls, audio levels and
// audit samples out.
export type BridgeEvent = { type: string; [field: string]: any };

export class BridgeClient {
  ws?: WebSocket;
  connect(token: string, { onEvent, onClose, onError }: { onEvent(event: BridgeEvent): void; onClose(): void; onError(): void }) {
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/voice`, ['fd-voice', token]); ws.binaryType = 'arraybuffer';
    ws.onmessage = ({ data }) => { if (typeof data === 'string') onEvent(JSON.parse(data)); };
    ws.onclose = onClose;
    ws.onerror = onError;
  }
  get open() { return this.ws?.readyState === WebSocket.OPEN; }
  get bufferedAmount() { return this.ws!.bufferedAmount; }
  send(event: Record<string, unknown>) { this.ws!.send(JSON.stringify(event)); }
  close() { this.ws?.close(); }
}
