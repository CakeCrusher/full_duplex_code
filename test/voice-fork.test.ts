// A fork OpenAI answers but never starts is not tried again: the page starts over, and Resume rebuilds the conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, Live, until } from './live-fake.ts';

test('a fork that never starts falls back to rebuilding the conversation, at once and on later resumes', async t => {
  const { h, lives, published } = await harness(t);
  const page = { id: 'p1', ws: { readyState: 1, send() {}, bufferedAmount: 0 } } as any;
  await h.startLive(undefined, page, 'fresh');
  lives[0].say('operator', 'Rename the parser.', 0); lives[0].say('intermediary', 'Sent.', 1500);
  await h.live!.close('operator ended voice');
  await until(() => h.voiceSessions.resumeStatus().fork);
  Live.deferStart.add('1');
  const starting = h.startLive(undefined, page, 'resume');
  await until(() => lives[1]);
  assert.equal(lives[1].options.fork, 'voice-0');
  lives[1].answered = true; lives[1].abort('session startup timed out');
  await starting;
  const closed = published.map(p => p.event).filter(e => e.type === 'voice_closed').at(-1);
  assert.equal(closed.reconnect, true, 'the page starts again by itself');
  assert.equal(h.voiceSessions.resumeStatus().plan, 'seed');
  await h.startLive(undefined, page, 'resume', true);
  assert.equal(lives[2].options.fork, undefined);
  assert.ok(lives[2].options.input.some((item: any) => /Rename the parser/.test(item.content[0].text)));
});
