// Speech carried from one voice connection to its replacement is never lost, even when the replacement fails to start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, Live, page, settle, until } from './live-fake.ts';

const words = 'Rename the options parser to argv.';

test('speech a dropped connection carried still reaches the agent when its replacement fails to start', async t => {
  const { h, lives } = await harness(t, { store: false });
  const delivered: any[] = [];
  h.deliver = (request: any) => { delivered.push(request); };
  const p = page('p');
  await h.voiceSessions.start('sdp', p, 'fresh');
  lives[0].say('operator', words, 0);
  lives[0].drop();
  await settle();
  assert.ok(h.voiceSessions.carried, 'carried after the drop');
  Live.deferStart.add('1');
  const starting = h.voiceSessions.start('sdp2', p, 'resume', true).catch(error => error);
  await until(() => lives[1]);
  lives[1].abort('network unreachable');
  const result = await starting;
  await settle(50);
  assert.ok(delivered.some(d => d.content.includes('argv')), 'the operator words reached the agent');
});

test("speech carried to a page whose fork is refused goes with the seeded session's requests", async t => {
  const { h, lives } = await harness(t);
  const delivered: any[] = [];
  h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  lives[0].say('operator', words, 0);
  Live.deferStart.add('1');
  const starting = h.voiceSessions.start('sdp2', page('q'), 'fresh').catch(error => error);
  await until(() => lives[1]);
  lives[1].abort('fork refused');
  await starting;
  await until(() => lives[2]?.state === 'active');
  lives[2].say('operator', 'Go ahead.', 1000);
  lives[2].emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 2000 });
  await settle(1200);
  await h.live!.close('operator ended voice');
  await settle(100);
  assert.ok(delivered.some(d => d.content.includes('argv')), 'the operator words reached the agent');
});

test("speech carried to a fork that never starts reaches the agent when the page doesn't start over", async t => {
  const { h, lives, published } = await harness(t);
  const delivered: any[] = [];
  h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  lives[0].say('operator', words, 0);
  // Voice moves to another page: the conversation goes on there as a fork, which OpenAI answers but never starts.
  Live.deferStart.add('1');
  const starting = h.voiceSessions.start('sdp2', page('q'), 'fresh').catch(error => error);
  await until(() => lives[1]);
  assert.ok(lives[1].options.fork, 'a fork');
  lives[1].answered = true;
  h.voiceSessions.carryMs = 100;
  lives[1].abort('session startup timed out');
  await starting;
  assert.ok(published.some(({ event, page }) => event.type === 'voice_closed' && event.reconnect && page === 'q'), 'the page is told to start over');
  await settle(300);
  assert.ok(delivered.some(d => d.content.includes('argv')), 'it does not: the operator words reached the agent');
});
