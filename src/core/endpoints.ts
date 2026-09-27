import http from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { Harness } from './bridge.ts';
import { MAX_HOOK_BYTES } from './limits.ts';
import { pageFile } from './page.ts';
import { attachPage } from './browser-socket.ts';
import { Pages } from './pages.ts';

const equal = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req: http.IncomingMessage, maxBytes = 1024 * 1024) {
  let size = 0; const buffers: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('Request too large'); buffers.push(chunk); }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}

// The bridge's HTTP and WebSocket routes and who may use them: the page and
// /voice with the browser token, and /hook plus any adapter socket with the
// agent token, from this machine only.
export class Endpoints {
  bridge: Harness;
  http: http.Server;
  wss: WebSocketServer;
  constructor(bridge: Harness) {
    this.bridge = bridge;
    this.http = http.createServer((req, res) => this.handleHttp(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: bridge.clean(error.message) }));
    }));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: protocols => protocols.has('fd-voice') ? 'fd-voice' : false });
    this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
  }
  // The page and /voice may arrive locally or through the tunnel. Hooks and
  // agent sockets belong to processes on this machine, never to forwarded requests.
  access(req: http.IncomingMessage) {
    const { baseUrl, publicOrigin } = this.bridge;
    const { host, origin } = req.headers;
    const forwarded = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    const local = host === new URL(baseUrl).host && !forwarded;
    const tunnel = Boolean(publicOrigin) && host === new URL(publicOrigin!).host;
    const expectedOrigin = tunnel ? publicOrigin : baseUrl;
    return { local, allowed: (local || tunnel) && (!origin || origin === expectedOrigin) };
  }
  async listen(port: number, fallback: boolean) {
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, '127.0.0.1', () => { this.http.off('error', reject); resolve(); });
    });
    try { await listen(port); } catch (error) {
      // Only the launcher's default port yields to another companion; an
      // explicitly requested port that is taken remains an error.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !fallback) throw error;
      this.bridge.portFellBack = true; await listen(0);
    }
    return (this.http.address() as import('node:net').AddressInfo).port;
  }
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const bridge = this.bridge, route = req.url ?? '';
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers['sec-websocket-protocol']?.split(',').map(s => s.trim())[1];
    const { local, allowed } = this.access(req);
    const agentSocket = Object.hasOwn(bridge.adapter.sockets, route) ? bridge.adapter.sockets[route] : undefined;
    const auth = agentSocket ? equal(token, bridge.agentToken) : route === '/voice' && equal(token, bridge.browserToken);
    // Pages are not exclusive: any number up to the limit, each one watching the session.
    const occupied = agentSocket ? !agentSocket.available() : bridge.pages.size >= Pages.LIMIT;
    if (!auth || !allowed || (agentSocket && !local) || occupied || bridge.stopping) {
      if (!agentSocket) bridge.log({ type: 'page.refused', via: local ? 'local' : 'tunnel', reason: !allowed ? 'address or origin' : !auth ? 'token' : bridge.stopping ? 'stopping' : 'too many pages' });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => agentSocket ? agentSocket.attach(ws) : attachPage(bridge, ws, local ? 'local' : 'tunnel'));
  }
  async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const bridge = this.bridge;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'");
    const { local, allowed } = this.access(req);
    if (!allowed) { res.writeHead(403); return res.end(); }
    if (req.url === '/hook' && req.method === 'POST') {
      if (!local || !equal(req.headers.authorization, `Bearer ${bridge.agentToken}`)) { res.writeHead(403); return res.end(); }
      const event = await body(req, MAX_HOOK_BYTES);
      // Never wait for a model or a network append before returning to the agent.
      // The observer refuses events from another agent session.
      if (!bridge.observer.hook(event)) { res.writeHead(409); return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json'); return res.end('{}');
    }
    if (req.url === '/api/status' && req.method === 'GET') {
      if (!equal(req.headers.authorization, `Bearer ${bridge.browserToken}`)) { res.writeHead(403); return res.end(); }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(bridge.status()));
    }
    const file = req.method === 'GET' ? pageFile(bridge.root, req.url ?? '', bridge.agent.profile) : undefined;
    if (!file) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', `${file.type}; charset=utf-8`);
    return res.end(file.body);
  }
  async close() {
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close(); await new Promise(resolve => this.http.close(resolve));
  }
}
