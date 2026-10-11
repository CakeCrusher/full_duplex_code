import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { InstructionLearner, KeptInstructions, type Suggestion } from '../src/core/instruction-learner.ts';
import { Harness } from '../src/core/bridge.ts';
import { Mediator } from '../src/core/mediator.ts';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { claude } from '../src/adapters/claude/index.ts';

// Jev's answer to one call, as the API returns it.
const jev = (behave: number, design: number, lasting: string) => {
  const calls: any[] = [];
  const fetch = async (url: string, init: RequestInit) => { calls.push({ url, init, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, json: async () => ({ answers: { behave: { noul: behave }, design_talk: { noul: design }, lasting: { choice: lasting } } }) }; };
  return { calls, fetch };
};

test('Jev is asked about what the operator said, with the turn before as context; a lasting instruction becomes a suggestion', async () => {
  const { calls, fetch } = jev(.8, .2, 'always'), suggested: Suggestion[] = [];
  const learner = new InstructionLearner({ apiKey: 'key', fetch, log: () => {}, onSuggest: s => suggested.push(s) });
  const suggestion = await learner.consider({ utterance: "  Don't read out file paths,\n just tell me what you need. ", previous: 'What did it change?', companion: 'It edited src/core/feed.ts.' });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer key');
  assert.deepEqual([calls[0].body.state.utterance, calls[0].body.state.previous_operator_utterance, calls[0].body.state.companion_before], ["Don't read out file paths, just tell me what you need.", 'What did it change?', 'It edited src/core/feed.ts.']);
  assert.deepEqual(Object.keys(calls[0].body.questions), ['behave', 'design_talk', 'lasting']);
  assert.deepEqual(suggested, [suggestion]);
  assert.equal(suggestion!.scope, 'always');
  assert.equal(learner.pending.get(suggestion!.id), suggestion);
});

test('no suggestion for design talk, a one-off cue, low confidence, or a few words', async () => {
  for (const [behave, design, lasting] of [[.8, .7, 'always'], [.8, .2, 'this_moment'], [.55, .1, 'this_session']] as const) {
    const { fetch } = jev(behave, design, lasting), suggested: Suggestion[] = [];
    const learner = new InstructionLearner({ apiKey: 'key', fetch, log: () => {}, onSuggest: s => suggested.push(s) });
    assert.equal(await learner.consider({ utterance: 'Please stop narrating every step from now on.' }), undefined);
    assert.equal(suggested.length, 0);
  }
  const { calls, fetch } = jev(.9, .1, 'always');
  await new InstructionLearner({ apiKey: 'key', fetch, log: () => {}, onSuggest: () => {} }).consider({ utterance: 'Stop.' });
  assert.equal(calls.length, 0, 'too short to be a standing instruction');
});

test('kept instructions are stored in the run folder, once each', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-kept-')), kept = new KeptInstructions(root);
  assert.deepEqual(kept.read(), []);
  kept.add('Keep it short.'); kept.add('No file paths.'); kept.add('Keep it short.');
  assert.deepEqual(kept.read(), ['No file paths.', 'Keep it short.']);
  assert.ok(fs.existsSync(path.join(root, '.runs', 'kept-instructions.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the operator answers a suggestion: kept always joins every later companion, kept for the session only this one, dismissed nothing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-learn-'));
  const harness = await new Harness({ agent: claude, root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused', jevKey: 'jev-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const published: any[] = [], publish = harness.publish; harness.publish = (event, page) => { published.push(event); publish(event, page); };
  harness.learner!.fetch = jev(.9, .1, 'always').fetch;
  const always = await harness.learner!.consider({ utterance: 'Never read file paths out loud to me.' });
  const session = await harness.learner!.consider({ utterance: 'For this task, only tell me when it is done.' });
  const dismissed = await harness.learner!.consider({ utterance: 'From now on, keep every answer to one sentence.' });
  assert.equal(published.filter(e => e.type === 'instruction_suggestion').length, 3);
  await harness.answerSuggestion(always!.id, 'always');
  await harness.answerSuggestion(session!.id, 'session');
  await harness.answerSuggestion(dismissed!.id, false);
  await harness.answerSuggestion('unknown', 'always');
  assert.deepEqual(harness.voiceSessions.additionalInstructions.map(i => i.text), ['Never read file paths out loud to me.', 'For this task, only tell me when it is done.']);
  assert.deepEqual(harness.kept.read(), ['Never read file paths out loud to me.']);
  assert.equal(published.filter(e => e.type === 'instruction_suggestion_done').length, 3);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8'), /jev-key/, 'the key never reaches the log');
  // A later companion in the same folder starts with what was kept always.
  const next = await new Harness({ agent: claude, root, runDir: path.join(root, 'run2'), cwd: root, sessionId: randomUUID(), apiKey: 'unused' }).start();
  try {
    assert.deepEqual(next.voiceSessions.additionalInstructions.map(i => [i.text, i.state]), [['Never read file paths out loud to me.', 'next_session']]);
    assert.match(next.voiceSessions.instructions(), /Never read file paths out loud to me\./);
  } finally { await next.close(); }
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
