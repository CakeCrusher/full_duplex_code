// The agent's error output reaches the terminal as the agent writes it, where
// its own screen can hide it. A copy of the latest part is kept, so that when
// the agent fails the launcher can repeat it, unchanged, once the agent has
// given the terminal back.
export class ErrorTail {
  chunks: Buffer[] = []; bytes = 0; limit: number;
  constructor(limit = 64 * 1024) { this.limit = limit; }
  push(chunk: Buffer) {
    this.chunks.push(chunk); this.bytes += chunk.length;
    while (this.bytes > this.limit && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.length;
  }
  get output() { return Buffer.concat(this.chunks); }
}

/** Bold red on a terminal: launcher failures must not go unnoticed. */
export const loud = (text: string, tty = Boolean(process.stderr.isTTY)) => tty ? `\x1b[1;31m${text}\x1b[0m` : text;

/** The launcher's line when the agent ended on its own, or nothing when it succeeded. */
export function failureNotice(name: string, code: number | null, signal: string | null, output: Buffer): string | undefined {
  if (code === 0 && !signal) return undefined;
  const how = signal ? `ended by ${signal}` : `exited with code ${code}`;
  return output.toString('utf8').trim() ? `fdc: ${name} ${how}. Its error output, unchanged:` : `fdc: ${name} ${how}. It wrote nothing to stderr; any message it showed is above.`;
}
