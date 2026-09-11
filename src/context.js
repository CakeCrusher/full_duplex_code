import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function redact(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 8)) result = result.split(secret).join('[redacted]');
  return result.replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted API key]');
}

// A byte bound stays below the API's 500-token append limit even for code,
// unusual Unicode, and text whose tokenizer differs from the local estimate.
export function chunks(text, maxBytes = 440) {
  const output = []; let chunk = ''; let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes) { output.push(chunk); chunk = ''; size = 0; }
    chunk += char; size += bytes;
  }
  if (chunk) output.push(chunk);
  return output;
}

export class ContextQueue {
  constructor(live, onError, log = () => {}) { Object.assign(this, { live, onError, log }); this.queue = []; this.running = false; this.stopped = false; }
  add(kind, text, delegationId = null) {
    if (this.stopped || !text) return;
    const parts = chunks(text).map(content => ({ kind, content, delegationId }));
    // Bound memory and make lost context explicit. Full source remains in the log.
    if (this.queue.length + parts.length > 256) {
      const dropped = this.queue.splice(0, Math.max(0, this.queue.length + parts.length - 255));
      this.log({ type: 'bridge.context_overflow', dropped: dropped.length });
      this.queue.push({ kind: 'thinking', content: 'Bridge state: some older agent output exceeded the voice context backlog and was omitted. Do not assume you saw every detail; the full local log remains available.', delegationId: null });
    }
    this.queue.push(...parts.slice(-255)); this.pump();
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length && this.live.state === 'active') {
        const { kind, content, delegationId } = this.queue.shift();
        try { await this.live.append(kind, content, delegationId); }
        catch (err) { if (!this.stopped && this.live.state === 'active') this.onError(err); }
      }
    } finally { this.running = false; }
  }
  stop() { this.stopped = true; this.queue.length = 0; }
}

export class VoiceHistory {
  constructor() { this.fragments = []; this.delegatedThrough = -1; this.lastInputAt = 0; }
  add(event) {
    const role = event.type === 'session.input_transcript.delta' ? 'operator' : 'intermediary';
    const fragment = { seq: this.fragments.length, role, text: event.delta, startMs: event.start_ms, endMs: event.end_ms, receivedAt: Date.now() };
    this.fragments.push(fragment);
    if (role === 'operator') this.lastInputAt = fragment.receivedAt;
    return fragment;
  }
  request(offsetMs) {
    // Transcript arrival can lag the delegation event. The caller waits briefly
    // before taking this snapshot; no transcript fragment itself triggers work.
    const newest = this.fragments.filter(f => f.role === 'operator' && f.seq > this.delegatedThrough && f.startMs <= offsetMs + 3000);
    if (!newest.length) return null;
    const before = this.fragments.filter(f => f.seq < newest[0].seq).slice(-80);
    const context = before.reduce((lines, f) => {
      if (lines.at(-1)?.role === f.role) lines.at(-1).text += f.text;
      else lines.push({ role: f.role, text: f.text });
      return lines;
    }, []).map(f => `${f.role}: ${f.text}`).join('\n').slice(-6000);
    const text = newest.map(f => f.text).join('');
    return { text, context, through: newest.at(-1).seq };
  }
  markDelivered(request) { this.delegatedThrough = Math.max(this.delegatedThrough, request.through); }
}

export class LineReader {
  constructor(onLine, onError = () => {}) { this.onLine = onLine; this.onError = onError; this.decoder = new StringDecoder('utf8'); this.partial = ''; }
  push(buffer) {
    this.partial += this.decoder.write(buffer);
    let newline;
    while ((newline = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, newline); this.partial = this.partial.slice(newline + 1);
      if (!line.trim()) continue;
      try { this.onLine(JSON.parse(line)); } catch (err) { this.onError(err); }
    }
    if (this.partial.length > 4 * 1024 * 1024) { this.partial = ''; this.onError(new Error('Oversized transcript line skipped')); }
  }
}

export class TranscriptTail {
  constructor(file, onRecord, onError = () => {}) {
    Object.assign(this, { file, onRecord, onError }); this.offset = 0; this.inode = null;
    this.reader = new LineReader(onRecord, onError);
  }
  poll() {
    try {
      const stat = fs.statSync(this.file);
      if ((this.inode !== null && stat.ino !== this.inode) || stat.size < this.offset) { this.offset = 0; this.reader = new LineReader(this.onRecord, this.onError); }
      this.inode = stat.ino;
      if (stat.size === this.offset) return;
      const size = Math.min(stat.size - this.offset, 1024 * 1024);
      const fd = fs.openSync(this.file, 'r');
      try {
        const buffer = Buffer.alloc(size); const n = fs.readSync(fd, buffer, 0, size, this.offset);
        this.offset += n; this.reader.push(buffer.subarray(0, n));
      } finally { fs.closeSync(fd); }
    } catch (err) { if (err.code !== 'ENOENT') this.onError(err); }
  }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), 250); }
  stop() { clearInterval(this.timer); }
}
