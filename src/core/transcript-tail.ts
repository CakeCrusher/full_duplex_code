import fs from 'node:fs';
import { LineReader } from './line-reader.ts';

/**
 * The records at the end of a JSONL file, oldest first: whole lines within its last `maxBytes`. For restoring a resumed
 * session's recent work without reading its whole record, which grows without bound: a session's record of over 512 MB
 * is more than one string can hold, and reading it whole failed ("Cannot create a string longer than 0x1fffffe8
 * characters"), so voice started without the conversation.
 */
export function lastRecords(file: string, maxBytes: number): any[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes), buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) { const n = fs.readSync(fd, buffer, read, buffer.length - read, start + read); if (!n) break; read += n; }
    // The line cut at the start of the piece is dropped.
    const from = start ? buffer.indexOf(10) + 1 : 0;
    return buffer.subarray(from, read).toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { fs.closeSync(fd); }
}

// Follows a JSONL transcript file as the agent appends to it.
export class TranscriptTail {
  file: string;
  onRecord: (record: any) => void;
  onError: (error: Error) => void;
  offset = 0;
  inode: number | null = null;
  reader: LineReader;
  timer?: NodeJS.Timeout;
  intervalMs: number;
  constructor(file: string, onRecord: (record: any) => void, onError: (error: Error) => void = () => {}, { intervalMs = 250 } = {}) {
    this.file = file; this.onRecord = onRecord; this.onError = onError; this.intervalMs = intervalMs;
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
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(err as Error); }
  }
  /** Follows the file from its start, or only lines added from now on. */
  start({ fromEnd = false } = {}) {
    if (fromEnd) { try { const stat = fs.statSync(this.file); this.offset = stat.size; this.inode = stat.ino; } catch {} }
    this.poll(); this.timer = setInterval(() => this.poll(), this.intervalMs);
  }
  stop() { clearInterval(this.timer); }
}
