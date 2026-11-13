// What Jev learned and changed can be taken back: an instruction by voice (Jev removes it, as the page's Remove does) and a
// setting change on the page (Revert), and the companion's status lists both for the page's table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev, REMOVE, type Reading } from '../src/core/jev.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { liveInstructions } from '../src/core/prompts.ts';
import { CueTracker } from '../web/cues.ts';
import { disregarded, harness, learn, page, settle, until } from './live-fake.ts';

test('Jev is asked whether the operator wants one of the instructions it learned to go, only while there are some', async () => {
  const bodies: any[] = [];
  const answers = { standby: { noul: .01 }, goal: { choice: 'keep', probabilities: { keep: 1 } }, behave: { noul: .2 }, design_talk: { noul: .1 }, lasting: { choice: 'this_moment' }, remove: { choice: 'I2', probabilities: { none: .1, I1: .05, I2: .85 } } };
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers }) }; } });
  const latest = { role: 'operator' as const, text: 'You can forget the thing about short answers.' };
  const removable = [{ id: 'I1', text: 'Say who is talking.' }, { id: 'I2', text: 'Keep answers under two sentences.' }];
  const reading = await jev.read({ trigger: 'turn', latest, learn: true, removable });
  assert.deepEqual(Object.keys(bodies[0].questions.remove.criteria), ['none', 'I1', 'I2']);
  assert.match(bodies[0].questions.remove.criteria.I2, /^They ask to drop I2 \("Keep answers under two sentences\."\)/);
  assert.deepEqual(reading.remove, { id: 'I2', p: .85 });
  await jev.read({ trigger: 'turn', latest, learn: true, removable: [] });
  await jev.read({ trigger: 'job', latest, learn: true, removable });
  assert.ok(!('remove' in bodies[1].questions) && !('remove' in bodies[2].questions), 'nothing to remove, or not the voice tool\'s own reading: not asked');
});

test('asked by voice to drop an instruction, the harness that writes instructions removes it, the voice says so, and nothing is learned from those words', async t => {
  const { h, lives } = await harness(t, { jevKey: 'jev-key' });
  const checks: any[] = [], publish = h.publish; h.publish = (event, page) => { if (event.type === 'jev_check') checks.push(event); publish(event, page); };
  const prompts: string[] = [], replies: string[] = [];
  h.ask = async prompt => { prompts.push(prompt); return replies.shift()!; };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  await learn(h, 'Keep answers under two sentences.');
  await learn(h, 'Say who is talking.');
  const reading = (said: string, behave: number, remove?: { id: string; p: number }): Reading => ({ trigger: 'turn', said, transcript: `► user: ${said}`, needsAgent: null, instruction: { behave, design: .1, lasting: 'this_session' }, ...remove && { remove } });
  // Not about how the companion behaves, and Jev isn't sure an instruction is to go: nothing happens.
  h.consider(reading('Maybe drop that one, I am not sure.', .2, { id: 'I2', p: REMOVE - .1 }), 'r1');
  await settle();
  assert.deepEqual([prompts.length, h.voiceSessions.additionalInstructions.length], [0, 2]);
  // Jev finds they ask for I2 to go, though the words alone don't read as an instruction: the harness is asked, and told which.
  replies.push('<remove>I2</remove>');
  h.consider(reading('Forget the thing about saying who is talking.', .2, { id: 'I2', p: .9 }), 'r2');
  await until(() => checks.some(c => c.requestId === 'r2' && /Removed/.test(c.outcome)));
  assert.match(prompts[0], /or asked it to drop one of the instructions in force \(the judge thinks I2\)/);
  assert.match(prompts[0], /<remove>IDs<\/remove>  \(only if they ask to drop instructions already in force and give no new one/);
  assert.deepEqual(h.voiceSessions.additionalInstructions.map(item => item.learned), ['I1'], 'removed as the page\'s Remove does it, and nothing new is learned');
  assert.ok(disregarded(lives[0], 'I2'), 'the running voice session is told to disregard it');
  await until(() => lives[0].appended.some(([kind]) => kind === 'commentary'));
  assert.deepEqual(lives[0].appended.filter(([kind, text]) => kind === 'commentary' && /removed/.test(text)).map(([, text]) => text),
    ['The operator asked for one of their instructions to go, and the voice tool removed I2 ("Say who is talking."): it no longer applies. Tell them so in a few words.']);
  assert.equal(checks.at(-1).outcome, 'Removed I2');
  assert.deepEqual(h.status().learned.map((item: any) => [item.id, Boolean(item.removed)]), [['I1', false], ['I2', true]], 'the page lists both, one as removed');
  // One that isn't in force: nothing to remove.
  replies.push('<remove>I7</remove>');
  h.consider(reading('And drop instruction seven.', .7), 'r3');
  await until(() => checks.some(c => c.requestId === 'r3'));
  assert.equal(checks.at(-1).outcome, 'Asked to remove an instruction that is not in force');
  assert.equal(h.voiceSessions.additionalInstructions.length, 1);
  // The harness can find Jev wrong: then nothing changes.
  replies.push('<none></none>');
  h.consider(reading('Can you undo that last change Claude made', .7), 'r4');
  await until(() => checks.some(c => c.requestId === 'r4'));
  assert.equal(checks.at(-1).outcome, 'Nothing to change in the instructions');
  assert.equal(h.voiceSessions.additionalInstructions.length, 1);
  assert.match(liveInstructions(claude, { jev: true }), /Their instructions to you can be withdrawn: one you are told to disregard no longer applies\./);
});

test('a change Jev made to the settings can be reverted: the setting goes back, stays the operator\'s, and the page hears no sound for it', async t => {
  const { h } = await harness(t);
  h.setTuning({ ...h.tuning, standbyAfterMs: 30000, wakeThreshold: 80 }, [{ name: 'standbyAfterMs', from: 60000, to: 30000 }, { name: 'wakeThreshold', from: 50, to: 80 }]);
  const change = h.status().tuningHistory.at(-1)!;
  assert.deepEqual([change.by, typeof change.id, change.reverted], ['Jev', 'string', undefined]);
  h.revertTuning(change.id);
  assert.deepEqual([h.tuning.standbyAfterMs, h.tuning.wakeThreshold], [60000, 50]);
  assert.deepEqual(h.pinned, ['standbyAfterMs', 'wakeThreshold'], 'Jev leaves a setting the operator set alone');
  const [first, second] = h.status().tuningHistory.slice(-2);
  assert.ok(first.reverted, 'the change is marked reverted');
  assert.deepEqual([second.by, second.changes], ['you (reverted)', [{ name: 'standbyAfterMs', from: 30000, to: 60000 }, { name: 'wakeThreshold', from: 80, to: 50 }]]);
  h.revertTuning(change.id); h.revertTuning('no such change');
  assert.equal(h.status().tuningHistory.length, 2, 'reverted once');
  const cues = new CueTracker();
  assert.equal(cues.cue({ type: 'tuning', id: 'a', by: 'Jev', changes: change.changes }), 'learned');
  assert.equal(cues.cue({ type: 'tuning', id: 'b', by: 'you (reverted)', changes: second.changes }), null, "the operator's own revert is not learned behavior");
});
