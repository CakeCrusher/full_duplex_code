import test from 'node:test';
import assert from 'node:assert/strict';
import { CueTracker } from '../web/cues.ts';

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
