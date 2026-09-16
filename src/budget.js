import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RATE_PER_SECOND = 0.05 / 60;

// Track usage without a spending or duration cap. Unfinished runs retain
// their latest reported cost (or a caller's larger estimate) until finalized.
export class Budget {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, runs: [] };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.runs) || data.runs.some(r => !Number.isFinite(r.reservedUsd) || (r.finalized && !Number.isFinite(r.costUsd)))) throw new Error('Invalid usage ledger');
    delete data.limitUsd; // Old ledgers retain their history, but no longer impose a limit.
    return data;
  }
  mutate(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch { throw new Error('Usage ledger locked by another process; no API connection opened.'); }
    try {
      const data = this.read();
      const result = fn(data);
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return result;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  summary() {
    const data = this.read();
    const committedUsd = data.runs.reduce((n, r) => n + (r.finalized ? r.costUsd : r.reservedUsd), 0);
    return { committedUsd, runs: data.runs };
  }
  reserve(maxSeconds, label) {
    if (maxSeconds !== null && (!Number.isFinite(maxSeconds) || maxSeconds <= 0)) throw new Error('Invalid duration');
    return this.mutate(data => {
      const reservedUsd = maxSeconds * RATE_PER_SECOND;
      const run = { id: randomUUID(), label, createdAt: new Date().toISOString(), maxSeconds, reservedUsd, observedSeconds: 0, finalized: false };
      data.runs.push(run);
      return run.id;
    });
  }
  update(id, seconds, { finalized = false, sessionId, reason } = {}) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid usage seconds');
    return this.mutate(data => {
      const run = data.runs.find(r => r.id === id);
      if (!run) throw new Error('Unknown budget reservation');
      run.observedSeconds = Math.max(run.observedSeconds, seconds);
      run.costUsd = run.observedSeconds * RATE_PER_SECOND;
      run.reservedUsd = Math.max(run.reservedUsd, run.costUsd);
      if (sessionId) run.sessionId = sessionId;
      if (reason) run.reason = reason;
      if (finalized) { run.finalized = true; run.closedAt = new Date().toISOString(); }
      return run;
    });
  }
}
