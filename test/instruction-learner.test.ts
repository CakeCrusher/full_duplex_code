import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { InstructionLearner, type LearnedInstruction } from '../src/core/instruction-learner.ts';
import { Harness } from '../src/core/bridge.ts';
import { Mediator } from '../src/core/mediator.ts';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { until } from '../scripts/test-support.ts';

// Jev's answer to one call, as the API returns it.
const jev = (behave: number, design: number, lasting: string) => {
  const calls: any[] = [];
  const fetch = async (url: string, init: RequestInit) => { calls.push({ url, init, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, json: async () => ({ answers: { behave: { noul: behave }, design_talk: { noul: design }, lasting: { choice: lasting } } }) }; };
  return { calls, fetch };
};

test('Jev is asked about what the operator said, with the turn before as context; a lasting instruction is learned', async () => {
  const { calls, fetch } = jev(.8, .2, 'always'), learned: LearnedInstruction[] = [];
  const learner = new InstructionLearner({ apiKey: 'key', fetch, log: () => {}, onLearn: i => learned.push(i) });
  const instruction = await learner.consider({ utterance: "  Don't read out file paths,\n just tell me what you need. ", previous: 'What did it change?', companion: 'It edited src/core/feed.ts.' });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer key');
  assert.deepEqual([calls[0].body.state.utterance, calls[0].body.state.previous_operator_utterance, calls[0].body.state.companion_before], ["Don't read out file paths, just tell me what you need.", 'What did it change?', 'It edited src/core/feed.ts.']);
  assert.deepEqual(Object.keys(calls[0].body.questions), ['behave', 'design_talk', 'lasting']);
  assert.deepEqual(learned, [instruction]);
  assert.deepEqual(instruction, { text: "Don't read out file paths, just tell me what you need.", scope: 'always', behave: .8, design: .2, lasting: 'always' });
});

test('nothing is learned from design talk, a one-off cue, low confidence, or a few words', async () => {
  for (const [behave, design, lasting] of [[.8, .7, 'always'], [.8, .2, 'this_moment'], [.55, .1, 'this_session']] as const) {
    const { fetch } = jev(behave, design, lasting), learned: LearnedInstruction[] = [];
    const learner = new InstructionLearner({ apiKey: 'key', fetch, log: () => {}, onLearn: i => learned.push(i) });
    assert.equal(await learner.consider({ utterance: 'Please stop narrating every step from now on.' }), undefined);
    assert.equal(learned.length, 0);
  }
  const { calls, fetch } = jev(.9, .1, 'always');
  await new InstructionLearner({ apiKey: 'key', fetch, log: () => {}, onLearn: () => {} }).consider({ utterance: 'Stop.' });
  assert.equal(calls.length, 0, 'too short to be a standing instruction');
});

test('a learned instruction joins this companion at once under an ID; removing it tells a running session to disregard it and leaves it out of later ones; both are logged', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-learn-'));
  const harness = await new Harness({ agent: claude, root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused', jevKey: 'jev-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const published: any[] = [], publish = harness.publish; harness.publish = (event, page) => { published.push(event); publish(event, page); };
  harness.learner!.fetch = jev(.9, .1, 'this_session').fetch;
  // Before voice starts, it waits for the next voice session.
  await harness.learner!.consider({ utterance: 'Never read file paths out loud to me.' });
  await until(() => harness.voiceSessions.additionalInstructions.length === 1);
  assert.deepEqual(harness.voiceSessions.additionalInstructions.map(i => [i.learned, i.text, i.state]), [['I1', 'I1: Never read file paths out loud to me.', 'next_session']]);
  assert.match(harness.voiceSessions.instructions(), /I1: Never read file paths out loud to me\./);
  // During voice, it goes into the running session at once.
  const appended: [string, string][] = [];
  harness.voiceSessions.live = { state: 'active', id: 'live_test', append: async (kind: string, text: string) => { appended.push([kind, text]); } } as any;
  await harness.learner!.consider({ utterance: 'From now on, keep every answer to one sentence.' });
  await until(() => published.filter(e => e.type === 'instruction_learned').length === 2);
  assert.deepEqual(appended[0], ['instructions', 'I2: From now on, keep every answer to one sentence.']);
  assert.deepEqual(published.filter(e => e.type === 'instruction_learned').map(e => e.id), ['I1', 'I2']);
  // Removing: the running session is told to disregard it; later sessions leave it out.
  await harness.removeInstruction('I2');
  assert.deepEqual(appended[1], ['instructions', 'Disregard instruction I2 ("From now on, keep every answer to one sentence."): the operator removed it, so it no longer applies.']);
  assert.deepEqual(harness.voiceSessions.additionalInstructions.map(i => i.learned), ['I1']);
  assert.doesNotMatch(harness.voiceSessions.instructions(), /I2/);
  assert.ok(published.some(e => e.type === 'instruction_removed' && e.id === 'I2'));
  await harness.removeInstruction('I9'); await harness.removeInstruction(undefined);
  assert.equal(appended.length, 2, 'an unknown ID changes nothing');
  harness.voiceSessions.live = undefined;
  const log = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8');
  assert.match(log, /"type":"instruction\.learned","id":"I1","text":"Never read file paths out loud to me\.","scope":"session","behave":0\.9/);
  assert.match(log, /"type":"instruction\.removed","id":"I2"/);
  assert.doesNotMatch(log, /jev-key/, 'the key never reaches the log');
});

test('once the operator pauses, the mediator asks Jev about what they said, with what the companion said before', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const live: any = new EventEmitter(); live.state = 'active'; live.close = () => {}; live.append = async () => {};
  const observer = new ClaudeObserver({ sessionId: 'test' }), considered: any[] = [];
  const learner = { consider: async (u: any) => { considered.push(u); return undefined; } } as unknown as InstructionLearner;
  const mediator = new Mediator({ live, observer, deliver: () => {}, log: () => {}, publish: () => {}, clean: String, hold: null, learner });
  t.after(() => { mediator.stop(); observer.close(); });
  live.emit('event', { type: 'session.output_transcript.delta', delta: 'Claude finished the edit.', start_ms: 0, end_ms: 900 });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'From now on, ', start_ms: 1000, end_ms: 1500 });
  t.mock.timers.tick(2000);
  live.emit('event', { type: 'session.input_transcript.delta', delta: "don't read paths out loud.", start_ms: 1500, end_ms: 2500 });
  t.mock.timers.tick(2499); assert.equal(considered.length, 0, 'still within the pause');
  t.mock.timers.tick(1);
  assert.deepEqual(considered, [{ utterance: "From now on, don't read paths out loud.", previous: '', companion: 'Claude finished the edit.' }]);
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'And keep answers short.', start_ms: 5000, end_ms: 6000 });
  t.mock.timers.tick(2500);
  assert.equal(considered[1].utterance, 'And keep answers short.');
  assert.equal(considered[1].previous, "From now on, don't read paths out loud.");
});
