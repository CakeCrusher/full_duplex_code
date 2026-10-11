import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Mediator } from '../src/core/mediator.ts';
import { WorkCatcher } from '../src/core/work-catcher.ts';
import type { VoiceRequest } from '../src/core/adapter.ts';

function fixture(t: TestContext, needsAgent: number) {
  if (!(t as any).timersOn) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); (t as any).timersOn = true; }
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => { live.state = 'closed'; };
  live.append = async () => {};
  const deliveries: VoiceRequest[] = [], judged: string[] = [];
  const catcher = { needsAgent: async (said: string) => { judged.push(said); return needsAgent; } } as unknown as WorkCatcher;
  const mediator = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, catcher });
  t.after(() => { mediator.stop(); observer.close(); });
  const say = (delta: string, start_ms: number) => live.emit('event', { type: 'session.input_transcript.delta', delta, start_ms, end_ms: start_ms + 800 });
  const settle = async (ms: number) => { t.mock.timers.tick(ms); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { live, mediator, deliveries, judged, say, settle };
}

test('work GPT Live answered without passing on goes to the agent when Jev judges it needs it', async t => {
  const f = fixture(t, .93);
  f.say('Oh, definitely. Just go ahead and merge it.', 0);
  await f.settle(7000); assert.equal(f.judged.length, 0, 'the operator may still be thinking');
  await f.settle(1500);
  assert.deepEqual(f.judged, ['Oh, definitely. Just go ahead and merge it.']);
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].content, /^\[Not passed on by the voice assistant\][\s\S]*user: Oh, definitely\. Just go ahead and merge it\./);
  await f.settle(9000); assert.equal(f.deliveries.length, 1, 'sent once');
});

test('a question Jev finds needs no agent stays answered; speech GPT Live passed on is not judged', async t => {
  const f = fixture(t, .2);
  f.say('What port is it on?', 0);
  await f.settle(8500);
  assert.equal(f.judged.length, 1); assert.equal(f.deliveries.length, 0);
  const g = fixture(t, .99);
  g.say('Add a test for the parser.', 0);
  g.live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 900 });
  await g.settle(9000);
  assert.equal(g.deliveries.length, 1, 'the ordinary request'); assert.doesNotMatch(g.deliveries[0].content, /Not passed on/);
  assert.equal(g.judged.length, 0);
});
