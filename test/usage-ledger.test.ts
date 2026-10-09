import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { UsageLedger, RATE_PER_SECOND } from '../src/core/usage-ledger.ts';

function ledger(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new UsageLedger(path.join(dir, 'budget.json'));
}
test('reserves before work and preserves unresolved charges across process restarts', t => {
  const b = ledger(t);
  b.reserve(60, 'crashed session');
  const resumed = new UsageLedger(b.file);
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
  const resumed = new UsageLedger(b.file);
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
  assert.equal(new UsageLedger(b.file).summary().committedUsd, 2000 * RATE_PER_SECOND);
  b.update(id, 2400, { finalized: true });
  assert.equal(b.summary().committedUsd, 2400 * RATE_PER_SECOND);
});

test('a companion running beside another waits for the shared ledger lock instead of failing', t => {
  const shared = ledger(t);
  fs.mkdirSync(path.dirname(shared.file), { recursive: true }); fs.writeFileSync(`${shared.file}.lock`, '');
  spawn('sh', ['-c', `sleep 0.2; rm '${shared.file}.lock'`]);
  assert.ok(shared.reserve(null, 'second companion'), 'the lock was released within the wait');
  fs.writeFileSync(`${shared.file}.lock`, ''); shared.lockWaitMs = 100;
  assert.throws(() => shared.reserve(null, 'third'), /Usage ledger locked by another process/);
});
