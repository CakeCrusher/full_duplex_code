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
test('old spending limits are ignored while previous usage is preserved', t => {
  const b = ledger(t); const old = b.reserve(36000, 'previous session');
  b.update(old, 36000, { finalized: true });
  const previous = b.read().runs;
  fs.writeFileSync(b.file, JSON.stringify({ version: 1, limitUsd: 25, runs: previous }));
  b.reserve(1835, 'new full-length session');
  const resumed = new Budget(b.file);
  assert.deepEqual(resumed.summary().runs[0], previous[0]);
  assert.equal(resumed.summary().runs.length, 2);
  assert.equal(resumed.summary().committedUsd, 30 + 1835 * RATE_PER_SECOND);
  assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf8')).limitUsd, undefined);
});

test('open-ended sessions record cumulative reported usage without a maximum estimate', t => {
  const b = ledger(t); const id = b.reserve(null, 'open-ended');
  assert.equal(b.summary().committedUsd, 0);
  b.update(id, 2000);
  assert.equal(b.summary().committedUsd, 2000 * RATE_PER_SECOND);
  b.update(id, 1900);
  assert.equal(new Budget(b.file).summary().committedUsd, 2000 * RATE_PER_SECOND);
  b.update(id, 2400, { finalized: true });
  assert.equal(b.summary().committedUsd, 2400 * RATE_PER_SECOND);
});
