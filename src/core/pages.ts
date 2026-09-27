import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

/** One open companion page, on this computer or through the tunnel. */
export interface Page { id: string; ws: WebSocket; via: 'local' | 'tunnel'; alive: boolean }

// Every open companion page. Each one shows the session; a voice session
// belongs to the page that started it (see VoiceSessions).
export class Pages {
  static readonly LIMIT = 8;
  all = new Map<WebSocket, Page>();
  log: (event: Record<string, unknown>) => void;
  heartbeat: NodeJS.Timeout;
  constructor({ log, heartbeatMs = 15000 }: { log: (event: Record<string, unknown>) => void; heartbeatMs?: number }) {
    this.log = log;
    // A page that stops answering (a phone asleep, a network that changed) is
    // closed when it misses a ping, instead of lingering as an open connection.
    this.heartbeat = setInterval(() => this.check(), heartbeatMs); this.heartbeat.unref();
  }
  get size() { return this.all.size; }
  add(ws: WebSocket, via: Page['via']): Page {
    const page: Page = { id: randomUUID(), ws, via, alive: true };
    this.all.set(ws, page);
    ws.on('pong', () => { page.alive = true; });
    this.log({ type: 'page.connected', page: page.id, via, pages: this.all.size });
    return page;
  }
  remove(ws: WebSocket, code?: number, reason?: string) {
    const page = this.all.get(ws);
    if (!page) return;
    this.all.delete(ws);
    this.log({ type: 'page.closed', page: page.id, via: page.via, code, reason: reason || undefined, pages: this.all.size });
    return page;
  }
  send(page: Page, event: object) { if (page.ws.readyState === WebSocket.OPEN) page.ws.send(JSON.stringify(event)); }
  broadcast(event: object) {
    const text = JSON.stringify(event);
    for (const { ws } of this.all.values()) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
  check() {
    for (const page of this.all.values()) {
      if (page.ws.readyState !== WebSocket.OPEN) continue;
      if (!page.alive) { this.log({ type: 'page.unresponsive', page: page.id, via: page.via }); page.ws.terminate(); continue; }
      page.alive = false; page.ws.ping();
    }
  }
  /** Closes every page as the companion stops, recording them now rather than as their sockets finish closing. */
  close() {
    clearInterval(this.heartbeat);
    for (const ws of [...this.all.keys()]) { this.remove(ws, undefined, 'companion stopped'); ws.terminate(); }
  }
}
