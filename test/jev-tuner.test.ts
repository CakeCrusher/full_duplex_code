import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JevTuner } from '../src/core/jev-tuner.ts';
import { LearnedLog } from '../src/core/instruction-learner.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';

test('Jev picks a level per setting; a level that is not offered, or the current one, changes nothing', async () => {
  let sent: any;
  const fetch = async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers: { thinkMs: { choice: 'level_3000' }, compactTokens: { choice: 'level_1234' }, pauseMs: { choice: 'level_0' } } }) }; };
  const tuner = new JevTuner({ apiKey: 'k', log: () => {}, fetch });
  const { tuning, changes } = await tuner.choose({ instructions: ["I1: don't cut in while I'm thinking"], earlier: [], current: DEFAULT_TUNING });
  assert.deepEqual(changes, [{ name: 'thinkMs', from: 2000, to: 3000 }]);
  assert.equal(tuning.thinkMs, 3000); assert.equal(tuning.compactTokens, DEFAULT_TUNING.compactTokens);
  assert.match(sent.state.operator_instructions, /cut in/);
  assert.deepEqual(Object.keys(sent.questions.thinkMs.criteria), ['level_1000', 'level_2000', 'level_3000']);
});

test('earlier sessions\' instructions are those still in force elsewhere, newest last', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learned-')), 'learned.jsonl'), log = new LearnedLog(file);
  log.add({ session: 'a', id: 'I1', text: 'Be brief.', scope: 'session' });
  log.add({ session: 'a', id: 'I2', text: 'Never read paths.', scope: 'always' });
  log.remove({ session: 'a', id: 'I1' });
  log.add({ session: 'b', id: 'I1', text: 'Wait until I finish.', scope: 'session' });
  assert.deepEqual(log.earlier('b'), ['Never read paths.']);
  assert.deepEqual(log.earlier('c'), ['Never read paths.', '(for that session only) Wait until I finish.']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('settings the operator set by hand are left to them', async () => {
  let sent: any;
  const fetch = async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers: { thinkMs: { choice: 'level_3000' }, compactTokens: { choice: 'level_1000000' } } }) }; };
  const tuner = new JevTuner({ apiKey: 'k', log: () => {}, fetch });
  const { changes } = await tuner.choose({ instructions: ['I1: tell me everything'], earlier: [], current: DEFAULT_TUNING, pinned: ['compactTokens'] });
  assert.deepEqual(changes, [{ name: 'thinkMs', from: 2000, to: 3000 }]);
  assert.equal(sent.questions.compactTokens, undefined);
});

test('earlier instructions meant for their own session only are marked so for Jev', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learned-')), 'learned.jsonl'), log = new LearnedLog(file);
  log.add({ session: 'a', id: 'I1', text: 'Be brief.', scope: 'session' });
  log.add({ session: 'a', id: 'I2', text: 'Never read paths.', scope: 'always' });
  assert.deepEqual(log.earlier('b'), ['(for that session only) Be brief.', 'Never read paths.']);
});

test("after a request, Jev reads the operator's latest words and keeps the current levels unless they ask for a change", async () => {
  let sent: any;
  const fetch = async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers: { wakeThreshold: { choice: 'level_100' } } }) }; };
  const tuner = new JevTuner({ apiKey: 'k', log: () => {}, fetch });
  const { changes } = await tuner.choose({ instructions: [], earlier: [], current: DEFAULT_TUNING, latest: 'Stop waking up for every little thing.' });
  assert.deepEqual(changes, [{ name: 'wakeThreshold', from: 10, to: 100 }]);
  assert.equal(sent.state.operator_latest_words, 'Stop waking up for every little thing.');
  assert.match(sent.questions.standbyAfterMs.instructions, /Keep the current level unless/);
  assert.deepEqual(Object.keys(sent.questions.standbyAfterMs.criteria), ['level_0', 'level_20000', 'level_30000', 'level_60000', 'level_120000']);
});
