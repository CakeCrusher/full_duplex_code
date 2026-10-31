// The conversation as Jev reads it across voice connections: what was said in the connections before this one, by when it
// was said, and words carried over from a dropped or paused connection counted once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceHistory } from '../src/core/voice-history.ts';
import { fakeJev, harness, page, until } from './live-fake.ts';

test('the voice history keeps when each turn was said', () => {
  const h = new VoiceHistory();
  for (const [i, text] of ['Make the header', 'Sure.', 'blue.'].entries()) h.add({ type: i === 1 ? 'session.output_transcript.delta' : 'session.input_transcript.delta', delta: text, start_ms: i * 3000, end_ms: i * 3000 + 500 });
  assert.ok(h.turns().every(turn => typeof turn.at === 'number'));
});

test("Jev's history leaves out words carried over from the connection before (it has that conversation already), unless they are the latest", () => {
  const before = new VoiceHistory();
  before.add({ type: 'session.input_transcript.delta', delta: 'Kept from before.', start_ms: 0, end_ms: 500 });
  const now = new VoiceHistory();
  now.carry(before);
  now.add({ type: 'session.output_transcript.delta', delta: 'Back.', start_ms: 1000, end_ms: 1500 });
  now.add({ type: 'session.input_transcript.delta', delta: 'Go on.', start_ms: 5000, end_ms: 5500 });
  assert.deepEqual(now.spoken(Infinity, 0).map(s => s.text), ['Back.', 'Go on.'], 'read before, the carried words are in the earlier conversation Jev gets, not here again');
  const unread = now.spoken(Infinity, -1);
  assert.equal(unread.length, 1);
  assert.match(unread[0].text, /^Kept from before\. ?Go on\.$/, 'unread, they are among the latest');
});

test('after the voice connection ends and another starts, Jev still reads the earlier conversation', async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .1, ready: .9 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  Object.assign(h.voiceSessions.mediator!, { operatorQuietMs: 50, replyStartMs: 30, replyMs: 60 });
  h.live!.emit('event', { type: 'session.input_transcript.delta', delta: 'Keep the soft shapes one in mind for later.', start_ms: 0, end_ms: 900 });
  await until(() => moments.some(m => m.trigger === 'job'));
  await h.live!.close('operator ended voice');
  await h.startLive(undefined, page('p'), 'resume');
  Object.assign(h.voiceSessions.mediator!, { operatorQuietMs: 50, replyStartMs: 30, replyMs: 60 });
  const before = moments.length;
  h.live!.emit('event', { type: 'session.input_transcript.delta', delta: 'Go back to that one.', start_ms: 0, end_ms: 700 });
  await until(() => moments.slice(before).some(m => m.trigger === 'job'));
  const job = moments.slice(before).find(m => m.trigger === 'job')!;
  assert.equal(job.latest?.text, 'Go back to that one.');
  assert.match(job.history ?? '', /user: Keep the soft shapes one in mind for later\./, "the connection before this one's words are in Jev's history");
});
