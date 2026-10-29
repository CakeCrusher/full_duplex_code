import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { InstructionLearner, type LearnedInstruction } from '../src/core/instruction-learner.ts';
import { Jev, type Reading } from '../src/core/jev.ts';
import { Harness } from '../src/core/bridge.ts';
import { Mediator } from '../src/core/mediator.ts';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { until } from '../scripts/test-support.ts';

// Jev's reading of the operator's latest words, as jev.ts gives it.
const read = (said: string, behave: number, design: number, lasting: string, transcript = `► operator: ${said}`): Reading => ({ trigger: 'delegation', said, transcript, needsAgent: .3, instruction: { behave, design, lasting } });

test("Jev reads the operator's latest words in the conversation; a lasting instruction is learned", async () => {
  const calls: any[] = [];
  const fetch = async (url: string, init: RequestInit) => { calls.push({ url, init, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: .2 }, behave: { noul: .8 }, design_talk: { noul: .2 }, lasting: { choice: 'always' } } }) }; };
  const reading = await new Jev({ apiKey: 'key', fetch, log: () => {} }).read({ trigger: 'delegation', learn: true, history: 'user: What did it change?\nvoice assistant: It edited src/core/feed.ts.\n',
    latest: { role: 'operator', text: "  Don't read out file paths,\n just tell me what you need. " } });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer key');
  assert.equal(calls[0].body.state.history, 'user: What did it change?\nvoice assistant: It edited src/core/feed.ts.');
  assert.equal(calls[0].body.state.latest, "user: Don't read out file paths, just tell me what you need.");
  assert.ok(['behave', 'design_talk', 'lasting'].every(name => calls[0].body.questions[name]), "the learner's questions, in the one call");
  const learned: LearnedInstruction[] = [];
  const instruction = new InstructionLearner({ log: () => {}, onLearn: i => learned.push(i) }).consider(reading);
  assert.deepEqual(learned, [instruction]);
  assert.deepEqual(instruction, { text: "Don't read out file paths, just tell me what you need.", scope: 'always', behave: .8, design: .2, lasting: 'always',
    said: "Don't read out file paths, just tell me what you need.", transcript: reading.transcript, requestId: undefined });
});

test('nothing is learned from design talk, a one-off cue, low confidence, or a few words', () => {
  for (const [behave, design, lasting] of [[.8, .7, 'always'], [.8, .2, 'this_moment'], [.55, .1, 'this_session']] as const) {
    const learned: LearnedInstruction[] = [];
    assert.equal(new InstructionLearner({ log: () => {}, onLearn: i => learned.push(i) }).consider(read('Please stop narrating every step from now on.', behave, design, lasting)), undefined);
    assert.equal(learned.length, 0);
  }
  assert.equal(new InstructionLearner({ log: () => {}, onLearn: () => {} }).consider(read('Stop.', .9, .1, 'always')), undefined, 'too short to be a standing instruction');
});

test('a learned instruction joins this companion at once under an ID; removing it tells a running session to disregard it and leaves it out of later ones; both are logged', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-learn-'));
  const harness = await new Harness({ agent: claude, root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused', jevKey: 'jev-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const published: any[] = [], publish = harness.publish; harness.publish = (event, page) => { published.push(event); publish(event, page); };
  harness.ask = async () => { throw new Error('no one-off run in tests'); };
  // Before voice starts, it waits for the next voice session.
  harness.consider(read('Never read file paths out loud to me.', .9, .1, 'this_session'));
  await until(() => harness.voiceSessions.additionalInstructions.length === 1);
  assert.deepEqual(harness.voiceSessions.additionalInstructions.map(i => [i.learned, i.text, i.state]), [['I1', 'I1: Never read file paths out loud to me.', 'next_session']]);
  assert.match(harness.voiceSessions.instructions(), /I1: Never read file paths out loud to me\./);
  // During voice, it goes into the running session at once.
  const appended: [string, string][] = [];
  harness.agentReady = true;
  harness.voiceSessions.createLive = () => {
    const live: any = Object.assign(new EventEmitter(), { state: 'new', reservation: 'run', transport: 'websocket', usageSeconds: 0, requested: false, answered: false, stored: false });
    return Object.assign(live, {
      async start() { live.state = 'active'; live.id = 'live_test'; live.emit('event', { type: 'session.started' }); },
      async append(kind: string, text: string) { appended.push([kind, text]); }, async greet() {}, audio() {},
      close(reason: string) { live.requested = true; if (live.state !== 'closed') { live.state = 'closed'; live.emit('closed', { finalized: true, reserved: true, usageSeconds: 1, sessionId: live.id, reason }); } return Promise.resolve(); },
    });
  };
  await harness.startLive(undefined, undefined, 'fresh');
  harness.consider(read('From now on, keep every answer to one sentence.', .9, .1, 'this_session'));
  await until(() => published.filter(e => e.type === 'instruction_learned').length === 2);
  assert.deepEqual(appended[0], ['instructions', 'I2: From now on, keep every answer to one sentence.']);
  assert.deepEqual(published.filter(e => e.type === 'instruction_learned').map(e => e.id), ['I1', 'I2']);
  // Removing: the running session is told to disregard it; later sessions leave it out.
  await harness.removeInstruction('I2');
  assert.deepEqual(appended[1], ['instructions', 'Disregard instruction I2 ("From now on, keep every answer to one sentence."): the operator removed it, so it no longer applies.']);
  assert.deepEqual(harness.voiceSessions.additionalInstructions.map(i => i.learned), ['I1']);
  assert.doesNotMatch(harness.voiceSessions.instructions(), /I2/);
  // The running session's prompt shows what GPT Live has: nothing appended can be taken out, so I2 stays, then its countermand.
  assert.match(harness.status().prompt.instructions, /I2: From now on, keep every answer to one sentence\.\n\nDisregard instruction I2 \(/);
  assert.ok(published.some(e => e.type === 'instruction_removed' && e.id === 'I2'));
  await harness.removeInstruction('I9'); await harness.removeInstruction(undefined);
  assert.equal(appended.length, 2, 'an unknown ID changes nothing');
  const log = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8');
  assert.match(log, /"type":"instruction\.learned","id":"I1","text":"Never read file paths out loud to me\.","scope":"session","behave":0\.9/);
  assert.match(log, /"type":"instruction\.removed","id":"I2"/);
  assert.doesNotMatch(log, /jev-key/, 'the key never reaches the log');
});

test('without the turn reading, Jev reads each request sent to the harness, in the conversation, once, and not on pauses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const live: any = new EventEmitter(); live.state = 'active'; live.close = () => {}; live.append = async () => {};
  const observer = new ClaudeObserver({ sessionId: 'test' }), asked: any[] = [], considered: any[] = [], delivered: any[] = [];
  const mediator = new Mediator({ live, observer, deliver: r => delivered.push(r), log: () => {}, publish: () => {}, clean: String, hold: null,
    read: async (trigger, spoken) => { asked.push({ trigger, spoken }); return read(spoken.at(-1)!.text, .9, .1, 'this_session'); }, consider: (reading, id) => considered.push([reading.said, id]) });
  t.after(() => { mediator.stop(); observer.close(); });
  live.emit('event', { type: 'session.output_transcript.delta', delta: 'Claude finished the edit.', start_ms: 0, end_ms: 900 });
  live.emit('event', { type: 'session.input_transcript.delta', delta: "From now on, don't read paths out loud.", start_ms: 1000, end_ms: 2500 });
  t.mock.timers.tick(10000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked.length, 0, 'a pause alone asks nothing');
  mediator.decide('delegation', 'd1');
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.deepEqual(asked.map(({ trigger, spoken }) => [trigger, spoken.map(({ role, text }: any) => [role, text])]), [['unsent', [['intermediary', 'Claude finished the edit.'], ['operator', "From now on, don't read paths out loud."]]]]);
  assert.deepEqual(considered, [["From now on, don't read paths out loud.", delivered[0].id]]);
});

test('a learned instruction is written by a one-off run of the harness, told Jev found one; a match in force adds nothing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-distill-'));
  const harness = await new Harness({ agent: claude, root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused', jevKey: 'jev-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const checks: any[] = [], publish = harness.publish; harness.publish = (event, page) => { if (event.type === 'jev_check') checks.push(event); publish(event, page); };
  const prompts: string[] = [], replies = ["<instruction>Don't read file paths out loud.</instruction>", 'Sure. <same>I1</same>', 'Okay, will do.'];
  harness.ask = async prompt => { prompts.push(prompt); return replies.shift()!; };
  harness.consider(read('Oh and um never like read the paths out loud to me okay', .9, .1, 'always'), 'r1');
  await until(() => checks.length === 1);
  assert.deepEqual(harness.voiceSessions.additionalInstructions.map(i => i.text), ["I1: Don't read file paths out loud."]);
  assert.match(prompts[0], /Jev\) has determined that the operator just gave the companion a standing instruction/);
  assert.match(prompts[0], /never like read the paths out loud/); assert.match(prompts[0], /Instructions already in force: \(none\)/);
  assert.deepEqual(checks.map(c => [c.requestId, c.outcome]), [['r1', "Learned I1: Don't read file paths out loud."]]);
  harness.consider(read('Please never read file paths to me again', .9, .1, 'always'), 'r2');
  await until(() => checks.length === 2);
  assert.match(prompts[1], /I1: Don't read file paths out loud\./, 'what is in force is offered');
  assert.equal(checks[1].outcome, 'Already in force as I1'); assert.equal(harness.voiceSessions.additionalInstructions.length, 1);
  // A reply without the tags: the operator's own words are kept, as before.
  harness.consider(read('Keep every answer short from now on', .9, .1, 'always'), 'r3');
  await until(() => checks.length === 3);
  assert.equal(harness.voiceSessions.additionalInstructions[1].text, 'I2: Keep every answer short from now on');
  const log = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8');
  assert.match(log, /"type":"instruction\.distilled","said":"Oh and um never like read the paths out loud to me okay"/, 'the operator\'s words stay in the log');
});
