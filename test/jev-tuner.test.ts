import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tunerQuestions, tuningFrom } from '../src/core/jev-tuner.ts';
import { Jev } from '../src/core/jev.ts';
import { LearnedLog } from '../src/core/instruction-learner.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';

test('Jev picks a level per setting; a level that is not offered, or the current one, changes nothing', () => {
  const { tuning, changes } = tuningFrom({ thinkMs: { choice: 'level_3000' }, compactTokens: { choice: 'level_1234' }, pauseMs: { choice: 'level_0' } }, DEFAULT_TUNING);
  assert.deepEqual(changes, [{ name: 'thinkMs', from: 2000, to: 3000 }]);
  assert.equal(tuning.thinkMs, 3000); assert.equal(tuning.compactTokens, DEFAULT_TUNING.compactTokens);
  assert.deepEqual(Object.keys(tunerQuestions(DEFAULT_TUNING).thinkMs.criteria), ['level_1000', 'level_2000', 'level_3000']);
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

test('settings the operator set by hand are left to them', () => {
  assert.equal(tunerQuestions(DEFAULT_TUNING, ['compactTokens']).compactTokens, undefined);
  assert.deepEqual(tuningFrom({ thinkMs: { choice: 'level_3000' }, compactTokens: { choice: 'level_1000000' } }, DEFAULT_TUNING, ['compactTokens']).changes, [{ name: 'thinkMs', from: 2000, to: 3000 }]);
});

test('earlier instructions meant for their own session only are marked so for Jev', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learned-')), 'learned.jsonl'), log = new LearnedLog(file);
  log.add({ session: 'a', id: 'I1', text: 'Be brief.', scope: 'session' });
  log.add({ session: 'a', id: 'I2', text: 'Never read paths.', scope: 'always' });
  assert.deepEqual(log.earlier('b'), ['(for that session only) Be brief.', 'Never read paths.']);
});

test("with the operator's words, Jev reads them in the same call and keeps the current levels unless they ask for a change", async () => {
  let sent: any;
  const fetch = async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: .1 }, wakeThreshold: { choice: 'level_100' } } }) }; };
  const reading = await new Jev({ apiKey: 'k', log: () => {}, fetch }).read({ trigger: 'delegation', lines: [{ role: 'operator', text: 'Stop waking up for every little thing.' }], tune: { instructions: ["I1: don't cut in while I'm thinking"], earlier: [], current: DEFAULT_TUNING, pinned: [] } });
  assert.deepEqual(tuningFrom(reading.tuning, DEFAULT_TUNING).changes, [{ name: 'wakeThreshold', from: 50, to: 100 }]);
  assert.equal(sent.state.latest, 'operator: Stop waking up for every little thing.');
  assert.match(sent.state.operator_instructions, /cut in/);
  assert.ok(sent.questions.needs_agent && sent.questions.standbyAfterMs, "the gate's questions and the tuner's, in one call");
  assert.match(sent.questions.standbyAfterMs.instructions, /Keep the current level unless/);
  assert.deepEqual(Object.keys(sent.questions.standbyAfterMs.criteria), ['level_0', 'level_10000', 'level_15000', 'level_20000', 'level_30000', 'level_60000', 'level_120000']);
  // Every Standby setting is Jev's to choose, each level with what it was measured to cost and buy.
  for (const name of ['speechPrice', 'liveSpeechPrice', 'toolPrice', 'promptPrice', 'messagePrice', 'turnEndPrice', 'failurePrice', 'approvalPrice', 'requestPrice']) assert.ok(sent.questions[name], name);
  assert.match(sent.questions.wakeThreshold.instructions, /Choose higher when the operator says it wakes up for nothing/);
  // When the instructions change, with no words: the default unless they ask otherwise.
  await new Jev({ apiKey: 'k', log: () => {}, fetch }).read({ trigger: 'settings', lines: [], tune: { instructions: [], earlier: [], current: DEFAULT_TUNING, pinned: [] } });
  assert.match(sent.questions.standbyAfterMs.instructions, /Choose the default unless/);
  assert.equal(sent.questions.needs_agent, undefined);
});

test('a setting changes only when Jev clearly prefers another level to the current one', () => {
  const flip = { holdFirstMs: { choice: 'level_2000', probabilities: { level_500: .01, level_1000: .47, level_2000: .52 } } };
  assert.deepEqual(tuningFrom(flip, DEFAULT_TUNING).changes, [], 'a near coin toss keeps the current level');
  const asked = { standbyAfterMs: { choice: 'level_60000', probabilities: { level_15000: .09, level_60000: .65, level_30000: .2 } } };
  assert.deepEqual(tuningFrom(asked, DEFAULT_TUNING).changes, [{ name: 'standbyAfterMs', from: 15000, to: 60000 }]);
});
