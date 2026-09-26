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
  constructor(file: string, onRecord: (record: any) => void, onError: (error: Error) => void = () => {}) {
    this.file = file; this.onRecord = onRecord; this.onError = onError;
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
  start() { this.poll(); this.timer = setInterval(() => this.poll(), 250); }
  stop() { clearInterval(this.timer); }
}
