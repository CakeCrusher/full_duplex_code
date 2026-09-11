import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentObserver } from '../src/agent.js';
import { Mediator } from '../src/mediator.js';

function fixture(t, state = 'active') {
  const live = new EventEmitter(); live.state = state;
  const appends = []; live.append = async (kind, content, delegationId) => { appends.push({ kind, content, delegationId }); };
  const observer = new AgentObserver({ sessionId: 'test' }); const deliveries = [];
  const mediator = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String });
  t.after(() => { mediator.stop(); observer.close(); });
  return { live, observer, mediator, appends, deliveries };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('terminal input and output enter Live context without becoming voice requests', async t => {
  const f = fixture(t);
  f.observer.input('Remember ORCHID'); f.observer.textDelta('ACKNOWLEDGED');
  await flush();
  assert.equal(f.appends.length, 2);
  assert.match(f.appends[0].content, /Claude Code input.*already submitted.*\nRemember ORCHID/s);
  assert.match(f.appends[1].content, /Claude Code output:\nACKNOWLEDGED/);
  assert.ok(f.appends.every(e => e.kind === 'thinking' && e.delegationId === null));
  assert.equal(f.mediator.history.fragments.length, 0);
  f.mediator.delegate('unexpected-delegation', 0);
  assert.equal(f.deliveries.length, 0, 'an observed terminal prompt cannot itself be delegated');
  f.mediator.stop();
  assert.equal(f.observer.listenerCount('input'), 0);
});

test('a previous channel reply does not suppress completion of a new terminal prompt', async t => {
  const f = fixture(t);
  f.mediator.channelEvent({ type: 'channel.reply', id: 'older', status: 'completed', text: 'Earlier voice task finished' });
  f.observer.input('New terminal task');
  f.observer.emit('complete', { text: 'Terminal task finished' });
  await flush();
  assert.ok(f.appends.some(e => e.kind === 'commentary' && e.content.includes('Terminal task finished')));
});

test('observations received during Live startup flush when the session becomes active', async t => {
  const f = fixture(t, 'connecting');
  f.observer.input('Typed during startup'); f.observer.textDelta('Reply during startup');
  assert.equal(f.appends.length, 0);
  f.live.state = 'active'; f.live.emit('event', { type: 'session.started' });
  await flush();
  assert.equal(f.appends.length, 2);
  assert.match(f.appends[0].content, /Typed during startup/); assert.match(f.appends[1].content, /Reply during startup/);
});
