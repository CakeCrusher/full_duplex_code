import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RATE_PER_SECOND = 0.05 / 60;
export const BUDGET_USD = 25;

// Reservations survive crashes. An unfinished run continues to occupy its entire
// allowance until a final usage event or an explicit accounting reconciliation.
export class Budget {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, limitUsd: BUDGET_USD, runs: [] };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.runs) || !Number.isFinite(data.limitUsd) || data.limitUsd < 0 || data.runs.some(r => !Number.isFinite(r.reservedUsd) || (r.finalized && !Number.isFinite(r.costUsd)))) throw new Error('Invalid budget ledger');
    return data;
  }
  mutate(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch { throw new Error('Budget ledger locked by another process; no API connection opened.'); }
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
    const limitUsd = Math.min(BUDGET_USD, data.limitUsd);
    const committedUsd = data.runs.reduce((n, r) => n + (r.finalized ? r.costUsd : r.reservedUsd), 0);
    return { limitUsd, committedUsd, remainingUsd: Math.max(0, limitUsd - committedUsd), runs: data.runs };
  }
  reserve(maxSeconds, label) {
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error('Invalid duration');
    return this.mutate(data => {
      const reservedUsd = maxSeconds * RATE_PER_SECOND;
      const occupied = data.runs.reduce((n, r) => n + (r.finalized ? r.costUsd : r.reservedUsd), 0);
      if (occupied + reservedUsd > Math.min(BUDGET_USD, data.limitUsd)) throw new Error('OpenAI voice budget would be exceeded');
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
      if (sessionId) run.sessionId = sessionId;
      if (reason) run.reason = reason;
      if (finalized) { run.finalized = true; run.closedAt = new Date().toISOString(); }
      return run;
    });
  }
}
