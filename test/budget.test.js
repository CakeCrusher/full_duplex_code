import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Budget, RATE_PER_SECOND } from '../src/budget.js';

function ledger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Budget(path.join(dir, 'budget.json'));
}
test('reserves before work and preserves unresolved charges across process restarts', t => {
  const b = ledger(t);
  b.reserve(60, 'crashed session');
  const resumed = new Budget(b.file);
  assert.equal(resumed.summary().committedUsd, 0.05);
  assert.equal(resumed.summary().runs[0].finalized, false);
});
test('usage snapshots are cumulative and finalization releases the unused reservation', t => {
  const b = ledger(t); const id = b.reserve(120, 'test');
  b.update(id, 10); b.update(id, 20); b.update(id, 15);
  assert.equal(b.summary().committedUsd, 0.1);
  b.update(id, 30, { finalized: true });
  assert.equal(b.summary().committedUsd, 30 * RATE_PER_SECOND);
});
test('cannot exceed the total authorization by running simultaneous reservations', t => {
  const b = ledger(t); b.reserve(29990, 'almost all budget');
  assert.throws(() => b.reserve(20, 'overrun'), /budget would be exceeded/);
  assert.equal(b.summary().runs.length, 1);
});
