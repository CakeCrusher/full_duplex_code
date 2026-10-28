import test from 'node:test';
import assert from 'node:assert/strict';
import { CueTracker } from '../web/cues.ts';
import { harness } from './live-fake.ts';

test('voice start and end each cue once per session, whatever ended it', () => {
  const cues = new CueTracker();
  assert.equal(cues.cue({ type: 'voice_started', sessionId: 'a' }), 'start');
  assert.equal(cues.cue({ type: 'voice_started', sessionId: 'a' }), null, 'a repeated start is not a new session');
  assert.equal(cues.cue({ type: 'voice_closed', finalized: false }), 'end');
  assert.equal(cues.cue({ type: 'voice_closed', finalized: true }), null, 'no second end cue');
  assert.equal(cues.end(), null, 'losing the bridge after the end is silent');
  assert.equal(cues.cue({ type: 'voice_closed' }), null, 'a close without a started session is silent');
});

test('losing the bridge mid-session plays the end cue', () => {
  const cues = new CueTracker();
  cues.cue({ type: 'voice_started', sessionId: 'b' });
  assert.equal(cues.end(), 'end');
});

test('each delegated request cues once, and restored history stays silent', () => {
  const cues = new CueTracker();
  assert.equal(cues.cue({ type: 'task', id: 'old', state: 'sent' }, { replaying: true }), null);
  assert.equal(cues.cue({ type: 'task', id: 'old', state: 'sent' }), null, 'a replayed request never cues later');
  assert.equal(cues.cue({ type: 'task', id: 'new', state: 'queued' }), 'delegate');
  assert.equal(cues.cue({ type: 'task', id: 'new', state: 'dispatching' }), null);
  assert.equal(cues.cue({ type: 'task', id: 'new', state: 'sent' }), null);
  assert.equal(cues.cue({ type: 'voice_started', sessionId: 'c' }, { replaying: true }), null);
});

test('an instruction Jev added cues once, with its own sound, and restored history stays silent', () => {
  const cues = new CueTracker();
  assert.equal(cues.cue({ type: 'instruction_learned', id: 'I1', text: 'Keep it short.' }, { replaying: true }), null);
  assert.equal(cues.cue({ type: 'instruction_learned', id: 'I2', text: 'Keep it short.' }), 'learned');
  assert.equal(cues.cue({ type: 'instruction_learned', id: 'I2', text: 'Keep it short.' }), null);
});

test('a change Jev makes to the settings is learned behavior, as an instruction is: the same sound, once each', () => {
  const cues = new CueTracker(), change = (from: number, to: number) => [{ name: 'standbyAfterMs', from, to }];
  assert.equal(cues.cue({ type: 'tuning', id: 'old', changes: change(60000, 30000) }, { replaying: true }), null);
  assert.equal(cues.cue({ type: 'tuning', id: 'old', changes: change(60000, 30000) }), null, 'a change from restored history never sounds later');
  assert.equal(cues.cue({ type: 'tuning', id: 'a', changes: change(60000, 30000) }), 'learned');
  assert.equal(cues.cue({ type: 'tuning', id: 'a', changes: change(60000, 30000) }), null, 'delivered twice, it sounds once');
  assert.equal(cues.cue({ type: 'tuning', id: 'b', changes: change(30000, 60000) }), 'learned', 'another change to the same setting sounds too');
  assert.equal(cues.cue({ type: 'tuning', id: 'c', changes: [] }), null, 'no change, no sound');
  assert.equal(cues.cue({ type: 'tuning', changes: change(60000, 30000) }), null, "an older fdc's change has no ID: silent, as before");
  assert.equal(cues.cue({ type: 'instruction_learned', id: 'I1', text: 'Keep it short.' }), 'learned', 'instructions still sound');
});

test('an applied change to the settings is published with an ID; the status it comes with has none', async t => {
  const { h, published } = await harness(t);
  h.setTuning({ ...h.tuning, standbyAfterMs: 30000 }, [{ name: 'standbyAfterMs', from: 60000, to: 30000 }]);
  h.setTuning({ ...h.tuning });
  const changes = published.map(p => p.event).filter(e => e.type === 'tuning');
  assert.equal(changes.length, 2);
  assert.match(changes[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(changes[1].id, undefined, 'nothing changed: nothing to confirm');
});
