// fdc's own connection to Open Claude in Chrome, the browser tools the coding agent uses: the
// same native host, attached as one more client, so fdc can act on the pages the agent opened
// without going through the agent. Newline-delimited JSON over the host's per-user socket.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export const browserSocket = () => process.env.OCIC_PIPE ?? path.join(os.tmpdir(), `open-claude-in-chrome-${os.userInfo().uid}`, 'bridge.sock');

export class Browser {
  socket?: net.Socket; buffer = ''; seq = 0; pending = new Map<string, Pending>();
  connecting?: Promise<net.Socket>; path: string; timeoutMs: number;
  constructor(socketPath = browserSocket(), timeoutMs = 8000) { this.path = socketPath; this.timeoutMs = timeoutMs; }
  connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return this.connecting ??= new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.path);
      socket.setEncoding('utf8');
      socket.once('connect', () => { socket.write('{"type":"client_hello"}\n'); this.socket = socket; this.connecting = undefined; resolve(socket); });
      socket.once('error', error => { this.connecting = undefined; reject(new Error(`Open Claude in Chrome isn't reachable (${error.message})`)); });
      socket.on('data', chunk => this.receive(String(chunk)));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
        for (const [id, call] of this.pending) { clearTimeout(call.timer); call.reject(new Error('Open Claude in Chrome disconnected')); this.pending.delete(id); }
      });
    });
  }
  receive(chunk: string) {
    this.buffer += chunk;
    for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      const call = this.pending.get(message.id);
      // The acknowledgment of the hello and recordings broadcast to every client are not replies.
      if (!call) continue;
      this.pending.delete(message.id); clearTimeout(call.timer);
      if (message.type === 'tool_error') call.reject(new Error(String(message.error)));
      else call.resolve((message.result?.content ?? []).map((part: any) => part.text ?? '').join(''));
    }
  }
  /** One tool call; resolves to its text. */
  async call(tool: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<string> {
    const socket = await this.connect(), id = `fdc${++this.seq}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${tool} took over ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, type: 'tool_request', tool, args }) + '\n');
    });
  }
  /** The tabs the browser tools can act on (the shared tab group). */
  async tabs(): Promise<{ tabId: number; title: string; url: string }[]> {
    const text = await this.call('tabs_context_mcp');
    try { return JSON.parse(text.split('\n\n')[0]).availableTabs ?? []; } catch { return []; }
  }
  /** Runs JavaScript in a tab's page and returns its JSON-parsed result; a thrown error rejects. */
  async evaluate<T = unknown>(tabId: number, expression: string, timeoutMs?: number): Promise<T> {
    const text = await this.call('javascript_tool', { action: 'javascript_exec', tabId, text: expression }, timeoutMs);
    if (/^Error: |^Tab \d+ is not in the MCP group/.test(text)) throw new Error(text.replace(/^Error: /, ''));
    if (text === 'undefined') return undefined as T;
    try { return JSON.parse(text) as T; } catch { return text as T; }
  }
  close() { this.socket?.destroy(); this.socket = undefined; }
}
