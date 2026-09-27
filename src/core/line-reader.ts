import { StringDecoder } from 'node:string_decoder';

// Newline-delimited JSON from a stream, tolerating split UTF-8 bytes and partial lines.
export class LineReader {
  onLine: (value: any) => void;
  onError: (error: Error) => void;
  decoder = new StringDecoder('utf8');
  partial = '';
  constructor(onLine: (value: any) => void, onError: (error: Error) => void = () => {}) { this.onLine = onLine; this.onError = onError; }
  push(buffer: Buffer) {
    this.partial += this.decoder.write(buffer);
    let newline;
    while ((newline = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, newline); this.partial = this.partial.slice(newline + 1);
      if (!line.trim()) continue;
      try { this.onLine(JSON.parse(line)); } catch (err) { this.onError(err as Error); }
    }
    if (this.partial.length > 4 * 1024 * 1024) { this.partial = ''; this.onError(new Error('Oversized transcript line skipped')); }
  }
}
