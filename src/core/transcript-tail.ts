import fs from 'node:fs';
import { LineReader } from './line-reader.ts';

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
