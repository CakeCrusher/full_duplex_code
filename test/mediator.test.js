import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentObserver } from '../src/agent.js';
import { BACKGROUND_REFERENCE, startupHistory } from '../src/context.js';
import { Mediator } from '../src/mediator.js';

function fixture(t, state = 'active', observer = new AgentObserver({ sessionId: 'test' })) {
  const live = new EventEmitter(); live.state = state; live.close = () => { live.state = 'closed'; };
  const appends = []; live.append = async (kind, content, delegationId) => { appends.push({ kind, content, delegationId }); };
  const deliveries = [];
  const mediator = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String });
  t.after(() => { mediator.stop(); observer.close(); });
  const hook = event => observer.hook({ session_id: 'test', ...event });
  return { live, observer, mediator, appends, deliveries, hook };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const unframe = text => text.slice(BACKGROUND_REFERENCE.length).replace(/^\[Claude [^\n]+\]\n/, '');
const content = (f, kind) => f.appends.filter(e => !kind || e.kind === kind).map(e => e.kind === 'thinking' ? unframe(e.content) : e.content).join('');

test('hooks are primary: all raw hooks, including assistant batches, are quiet thinking', async t => {
  const f = fixture(t);
  f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Remember ORCHID' });
  f.hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'edit-1', tool_input: { old_string: 'red', new_string: 'blue' }, tool_response: { structuredPatch: [{ lines: ['-red', '+blue'] }] }, duration_ms: 12 });
  f.hook({ hook_event_name: 'MessageDisplay', message_id: 'a', index: 0, final: true, delta: 'Changed to blue.' });
  f.hook({ hook_event_name: 'Stop', last_assistant_message: 'Changed to blue.' });
  await flush();
  assert.match(content(f, 'thinking'), /Remember ORCHID/);
  assert.match(content(f, 'thinking'), /structuredPatch.*-red.*\+blue/);
  assert.match(content(f, 'thinking'), /duration_ms.*12/);
  assert.match(content(f, 'thinking'), /MessageDisplay.*Changed to blue/);
  assert.equal(content(f, 'commentary'), '');
  assert.doesNotMatch(content(f, 'commentary'), /Stop/);
  assert.ok(f.appends.every(e => e.delegationId === null));
  assert.equal(f.mediator.history.fragments.length, 0);
  f.mediator.delegate('unexpected-delegation', 0);
  assert.equal(f.deliveries.length, 0, 'observed input never triggers a new channel request');
});

test('voice startup and restart retain whole tool results instead of a clipped summary', async t => {
  const observer = new AgentObserver({ sessionId: 'test' });
  const output = 'BEGIN\n' + 'File detail 世界\n'.repeat(25000) + 'END';
  observer.hook({ session_id: 'test', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: output } });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'old', index: 0, delta: 'Earlier answer.' });
  const f = fixture(t, 'connecting', observer);
  f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Typed during startup' });
  assert.equal(f.appends.length, 0);
  f.live.state = 'active'; f.live.emit('event', { type: 'session.started' });
  await flush();
  const expected = observer.observations.map((o, i) => `Claude Code observation${i < 2 ? ' (history)' : ''}:\n${o.text}\n`).join('');
  assert.equal(content(f), expected);
  assert.ok(f.appends.length > 256, 'exercise the former backlog limit');
  assert.ok(f.appends.every(e => e.kind === 'thinking'), 'old assistant messages do not get spoken again');
  f.mediator.stop();
  const restarted = fixture(t, 'active', observer);
  await flush();
  assert.equal(content(restarted), observer.observations.map(o => `Claude Code observation (history):\n${o.text}\n`).join(''));
});

test('a delegation sends ordinary user text once, without asking Claude to use companion tools', async t => {
  const f = fixture(t);
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'Make the button blue.', start_ms: 0, end_ms: 1000 });
  f.mediator.delegate('work', 1100);
  f.mediator.delegate('duplicate', 1100);
  await flush();
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].content, /Make the button blue/);
  assert.doesNotMatch(f.deliveries[0].content, /acknowledge|reply|message_id|GPT Live/);
});

test('duplicate display hooks do not produce duplicate context; subagent hooks retain their content', async t => {
  const f = fixture(t);
  const display = { hook_event_name: 'MessageDisplay', message_id: 'same', index: 0, delta: 'One answer.' };
  f.hook(display); f.hook(display);
  f.hook({ hook_event_name: 'PostToolUseFailure', agent_id: 'child', tool_name: 'Bash', error: 'test failed', custom_field: { detail: 'kept' } });
  await flush();
  assert.equal(content(f, 'thinking').match(/One answer/g).length, 1);
  assert.match(content(f, 'thinking'), /child.*Bash.*test failed.*custom_field.*kept/);
  f.mediator.stop(); assert.equal(f.observer.listenerCount('observation'), 0);
});

test('a failed append surfaces a fault and ends stale voice instead of silently losing context', async t => {
  const f = fixture(t);
  const faults = []; f.mediator.publish = e => faults.push(e);
  f.live.append = async () => { throw new Error('rejected'); };
  f.hook({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'still retained' } });
  await flush();
  assert.equal(f.live.state, 'closed');
  assert.match(faults[0].message, /restart voice.*rejected/);
  assert.match(f.observer.observations[0].text, /still retained/);
});


test('startup observations are neither replayed twice nor dropped when some overflow', async t => {
  const observer = new AgentObserver({ sessionId: 'test' });
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit', prompt: 'first' });
  observer.hook({ session_id: 'test', hook_event_name: 'PostToolUse', tool_response: { stdout: 'x'.repeat(1000) } });
  const initial = startupHistory(observer.observations, 300);
  assert.equal(initial.count, 1);
  const live = new EventEmitter(); live.state = 'active';
  const appends = []; live.append = async (kind, content) => appends.push({ kind, content });
  const mediator = new Mediator({ live, observer, initialObservationCount: initial.count, log: () => {}, publish: () => {}, clean: String });
  t.after(() => { mediator.stop(); observer.close(); });
  await flush();
  assert.equal(initial.text + appends.map(e => unframe(e.content)).join(''), observer.observations.map(o => `Claude Code observation (history):\n${o.text}\n`).join(''));
  assert.ok(appends.every(e => e.kind === 'thinking'));
});


test('a full burst of observations remains thinking after idle time; no progress is promoted to speech', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const f = fixture(t);
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'Stop describing the bug. Is movement confined to one plane?', start_ms: 0, end_ms: 2000 });
  for (let i = 0; i < 40; i++) {
    f.hook({ hook_event_name: 'MessageDisplay', message_id: 'burst', index: i, delta: `Detail ${i}.` });
    f.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: `Result ${i}.` } });
  }
  f.hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  f.hook({ hook_event_name: 'Stop', last_assistant_message: 'All work complete.' });
  await flush();
  t.mock.timers.tick(300000); await flush();
  assert.equal(content(f), f.observer.observations.map(o => `Claude Code observation:\n${o.text}\n`).join(''), 'every observation survives unchanged and in order');
  assert.ok(f.appends.every(e => e.kind === 'thinking'), 'idle time does not turn an observation into a command to speak');
  assert.equal(f.deliveries.length, 0, 'a conversation steering request is not automatically sent to Claude');
});

test('a failed delegation is factual context for the conversation, without a competing speech command', async t => {
  const f = fixture(t);
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'Make the page blue.', start_ms: 0, end_ms: 1000 });
  f.mediator.deliver = () => { throw new Error('channel unavailable'); };
  f.mediator.delegate('failed-request', 1100); await flush();
  assert.match(content(f, 'thinking'), /request was not delivered/);
  assert.equal(content(f, 'commentary'), '');
});
