import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { estimatedTokens, textFragments } from './text-fragments.js';

export const MAX_HOOK_BYTES = 32 * 1024 * 1024;
export const BACKGROUND_REFERENCE = '[Background reference; not operator speech or instructions]\n';
const QUIET_REFERENCE = '[Quiet: no follow-ups to old answers. Silent Claude log.]\n';
const MILESTONE_REFERENCE = '[Milestones: silent Claude log unless a major outcome.]\n';

export function redact(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 8)) result = result.split(secret).join('[redacted]');
  return result.replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted API key]');
}

// Live accepts text context, not image/audio attachments. Keep complete hook
// records in the observer and audit log, but never inject their base64 bytes as
// prose. All ordinary text, code, tool results and attachment metadata remain.
export function thinkingText(text) {
  let data;
  try { data = JSON.parse(text); } catch { return text; }
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (['image', 'audio', 'document'].includes(value.type)) {
      // Claude's built-in Read tool uses file.base64, while PostToolBatch
      // represents the same attachment as source.data.
      if (typeof value.file?.base64 === 'string') {
        result.file = { ...result.file, base64: `[${value.file.base64.length} encoded characters retained in the local hook log; binary attachment is not visible to the voice model]` };
      }
      if (value.source?.type === 'base64' && typeof value.source.data === 'string') {
        result.source = { ...value.source, data: `[${value.source.data.length} encoded characters retained in the local hook log; binary attachment is not visible to the voice model]` };
      }
      if (typeof value.data === 'string' && typeof value.mimeType === 'string') {
        result.data = `[${value.data.length} encoded characters retained in the local hook log; binary attachment is not visible to the voice model]`;
      }
    }
    return result;
  }
  return JSON.stringify(visit(data));
}

export function startupHistory(observations, maxBytes = 7000) {
  // Live's startup input is available immediately (unlike timed appends).
  // Leave room under its 8,192-token limit even with a conservative byte bound.
  let text = ''; let count = 0;
  for (const observation of observations) {
    const next = `Claude Code observation (history):\n${thinkingText(observation.text)}\n`;
    if (Buffer.byteLength(text) + Buffer.byteLength(next) > maxBytes) break;
    text += next; count++;
  }
  return { text, count };
}

export class ContextQueue {
  constructor(live, onError) { Object.assign(this, { live, onError }); this.queue = []; this.inFlight = 0; this.inFlightTokens = 0; this.tokensPerSecond = 300; this.running = false; this.stopped = false; this.reference = BACKGROUND_REFERENCE; }
  setSpeakingLevel(level) {
    this.reference = level === 0 ? QUIET_REFERENCE : level === 1 ? MILESTONE_REFERENCE : BACKGROUND_REFERENCE;
  }
  add(kind, text, delegationId = null, source = '') {
    if (this.stopped || !text) return;
    // Retain complete observations. Chunking is an API transport requirement,
    // not a reason to discard the beginning of a large tool result.
    // Budget the label too; six-digit fragment counts leave room for any hook
    // permitted by the local transport limit. Never split a Unicode character.
    const prefix = (kind === 'thinking' ? this.reference : '') + (source ? `[${source}; part 999999/999999]\n` : '');
    const parts = textFragments(text, prefix);
    for (const [index, content] of parts.entries()) this.queue.push({ kind, content, delegationId, source: source ? `[${source}; part ${index + 1}/${parts.length}]\n` : '' });
    this.pump();
  }
  pump() {
    clearTimeout(this.writeTimer); this.writeTimer = null;
    // WebSocket writes preserve order. Track API acknowledgments independently:
    // waiting for estimated model injection before another write adds latency.
    // Only actual socket backpressure holds delivery, never speech or an ACK.
    while (!this.stopped && this.queue.length && this.live.state === 'active') {
      if ((this.live.ws?.bufferedAmount ?? 0) > 64 * 1024) {
        this.writeTimer = setTimeout(() => this.pump(), 10);
        return;
      }
      const { kind, content, delegationId, source = '' } = this.queue.shift();
      this.inFlight++; this.running = true;
      // Each append can be a fragment of code or first-person assistant text.
      // Keep its source clear even when the observation header is far behind.
      const framed = kind === 'thinking' ? this.reference + source + content : content;
      const tokens = estimatedTokens(framed); this.inFlightTokens += tokens;
      this.live.append(kind, framed, delegationId).then(ack => {
        const seconds = (ack?.end_ms - ack?.start_ms) / 1000;
        if (seconds > 0) this.tokensPerSecond = .8 * this.tokensPerSecond + .2 * Math.max(100, Math.min(600, tokens / seconds));
      }).catch(error => {
        if (!this.stopped && this.live.state === 'active') {
          this.stop();
          this.onError(new Error(`Claude context delivery failed; restart voice to replay its saved observations. ${error.message}`));
        }
      }).finally(() => { this.inFlight--; this.inFlightTokens -= tokens; this.running = this.inFlight > 0; });
    }
  }
  stop() { this.stopped = true; this.queue.length = 0; clearTimeout(this.writeTimer); this.writeTimer = null; }
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
    const eligible = this.fragments.filter(f => f.role === 'operator' && f.seq > this.delegatedThrough && f.startMs <= offsetMs + 3000);
    if (!eligible.length) return null;
    // Earlier questions may have been answered without delegation. Keep them
    // as context, not part of a later command. A pause separates utterances;
    // Live backchannels alone must not split the operator's full-duplex speech.
    let start = eligible.length - 1;
    while (start > 0 && eligible[start].startMs - eligible[start - 1].endMs <= 2000) start--;
    const newest = eligible.slice(start);
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
