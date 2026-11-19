import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// The language server inside each agy process, which its terminal talks to: the companion's way in while no turn runs.
// agy takes the token the server requires of its callers (CSRF) from ANTIGRAVITY_SERVER_CSRF_TOKEN as it starts, so fdc
// chooses it, and writes the port the server listens on to its log (--log-file), which fdc follows. The log also says
// which conversation the terminal shows, when a tool waits for the operator's approval, and when agy exits (agy 1.5.12).

/** What fdc reads in agy's log. */
export type LogEvent =
  | { type: 'port'; port: number }
  | { type: 'conversation'; id: string }
  | { type: 'confirmation'; tool: string; step: number }
  | { type: 'confirmed'; conversation: string; step: number; approved: boolean }
  | { type: 'exit' }
  | { type: 'settled' };

/** One line of agy's log (glog: level, time, thread, source, then the message), as what fdc reads in it. */
export function logEvent(line: string): LogEvent | undefined {
  const message = line.replace(/^[IWEF]\d{4} [\d:.]+\s+\d+ ([\w.-]+:\d+)\] /, '$1] ');
  let m: RegExpMatchArray | null;
  if ((m = message.match(/listening on random port at (\d+) for HTTP$/))) return { type: 'port', port: Number(m[1]) };
  // The terminal's conversation: on starting a resumed one, opening a new one, or switching (/resume, /fork, /new).
  if ((m = message.match(/^conversation_manager\.go:\d+\] Streaming conversation ([0-9a-f-]{36})/))) return { type: 'conversation', id: m[1] };
  if ((m = message.match(/Surfacing tool confirmation: "([^"]*)" at step (\d+)/))) return { type: 'confirmation', tool: m[1], step: Number(m[2]) };
  if ((m = message.match(/Responding to tool confirmation: convID=([0-9a-f-]+), stepIdx=(\d+), approved=(true|false)/))) return { type: 'confirmed', conversation: m[1], step: Number(m[2]), approved: m[3] === 'true' };
  if (/CLI program exited/.test(message)) return { type: 'exit' };
  // agy is done starting (signed in, its flags read): a first message (-i) goes only after this, and a turn woken
  // through the server before it runs without hooks (agy 1.5.12: a fork woken 0.1 s and 0.5 s after it drew ran none).
  if (/experiment_manager\.go:\d+\] Experiments refreshed after login|manager\.go:\d+\] SetCycleMode called/.test(message)) return { type: 'settled' };
}

/** Follows a text file as it grows: each new line, once. */
export class LogTail {
  file: string; offset = 0; decoder = new StringDecoder('utf8'); partial = ''; timer?: NodeJS.Timeout;
  onLine: (line: string) => void;
  constructor(file: string, onLine: (line: string) => void) { this.file = file; this.onLine = onLine; }
  /** From the start of the file, or (a log agy already wrote to before) from its end. */
  start({ fromEnd = false, intervalMs = 150 } = {}) {
    if (fromEnd) try { this.offset = fs.statSync(this.file).size; } catch {}
    this.poll(); this.timer = setInterval(() => this.poll(), intervalMs); this.timer.unref();
  }
  poll() {
    let fd: number | undefined;
    try {
      const size = fs.statSync(this.file).size;
      if (size < this.offset) this.offset = 0;
      if (size === this.offset) return;
      fd = fs.openSync(this.file, 'r');
      const buffer = Buffer.alloc(Math.min(size - this.offset, 4 * 1024 * 1024)), n = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += n; this.partial += this.decoder.write(buffer.subarray(0, n));
      const lines = this.partial.split('\n'); this.partial = lines.pop() ?? '';
      for (const line of lines) if (line) this.onLine(line);
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  stop() { clearInterval(this.timer); this.poll(); }
}

export class AgyServer extends EventEmitter {
  /** The token agy's server will require, given to agy as it starts (`env`). */
  readonly token = randomBytes(24).toString('hex');
  port?: number; settled = false;
  command: string;
  tail?: LogTail;
  constructor(command = 'agy') { super(); this.command = command; }
  get env() { return { ANTIGRAVITY_SERVER_CSRF_TOKEN: this.token }; }
  /** Follows agy's log: emits each LogEvent, and `port` once the server listens. */
  follow(file: string, fromEnd: boolean) {
    this.tail = new LogTail(file, line => {
      const event = logEvent(line);
      if (!event) return;
      if (event.type === 'port') { if (this.port === undefined) { this.port = event.port; this.emit('ready'); } return; }
      if (event.type === 'settled') { if (!this.settled) { this.settled = true; this.emit('settled'); } return; }
      this.emit('log', event);
    });
    this.tail.start({ fromEnd });
  }
  /**
   * A message to a conversation (`agy agentapi send-message`): Antigravity takes it at its next model call, and a
   * conversation at rest wakes to take it, as it does for a background task's completion.
   */
  send(conversation: string, text: string, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.port === undefined) return reject(new Error("Antigravity's language server has not started."));
      const child = spawn(this.command, ['agentapi', 'send-message', conversation, text], { env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${this.port}`, ANTIGRAVITY_CSRF_TOKEN: this.token }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`agentapi send-message took longer than ${timeoutMs / 1000} s`)); }, timeoutMs);
      child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        let reply: any; try { reply = JSON.parse(out); } catch {}
        if (code === 0 && reply?.response?.sendMessage && !reply.error) resolve();
        else reject(new Error(`Antigravity did not take the message: ${reply?.error ?? out.trim().slice(-300) ?? `exit ${code}`}`));
      });
    });
  }
  /** A method of the language server, as its terminal calls it (Connect, JSON). */
  async call(method: string, body: unknown, timeoutMs = 30000): Promise<any> {
    if (this.port === undefined) throw new Error("Antigravity's language server has not started.");
    const response = await fetch(`http://127.0.0.1:${this.port}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': this.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(reply?.message ?? `${method} answered HTTP ${response.status}`);
    return reply;
  }
  /** Antigravity's own fork of a conversation (what /fork does), at a step: the new conversation's ID. */
  async fork(conversation: string, step: number): Promise<string> {
    const reply = await this.call('ForkConversation', { sourceCascadeId: conversation, forkAtStepIndex: step });
    if (typeof reply?.newCascadeId !== 'string') throw new Error('Antigravity named no fork.');
    return reply.newCascadeId;
  }
  close() { this.tail?.stop(); }
}
