import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { startupHistory } from '../src/core/startup-history.ts';
import { Mediator } from '../src/core/mediator.ts';
import type { VoiceRequest } from '../src/core/adapter.ts';

type Append = { kind: string; content: string; delegationId?: string | null };
function fixture(t: TestContext, state = 'active', observer = new ClaudeObserver({ sessionId: 'test' })) {
  const live: any = new EventEmitter(); live.state = state; live.close = () => { live.state = 'closed'; };
  const appends: Append[] = []; live.append = async (kind: string, content: string, delegationId?: string | null) => { appends.push({ kind, content, delegationId }); };
  const deliveries: VoiceRequest[] = [];
  const mediator = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null });
  t.after(() => { mediator.stop(); observer.close(); });
  const hook = (event: Record<string, any>) => observer.hook({ session_id: 'test', ...event });
  return { live, observer, mediator, appends, deliveries, hook };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const unframe = (text: string) => text.replace(/^\[[^\n]+\]\n\[Claude [^\n]+\]\n/, '');
const content = (f: { appends: Append[] }, kind?: string) => f.appends.filter(e => !kind || e.kind === kind).map(e => e.kind === 'thinking' ? unframe(e.content) : e.content).join('');

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

test('voice startup and restart send only new observations; earlier work goes to bounded startup history', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const output = 'BEGIN\n' + 'File detail 世界\n'.repeat(25000) + 'END';
  observer.hook({ session_id: 'test', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: output } });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'old', index: 0, delta: 'Earlier answer.' });
  const history = startupHistory(claude, observer.observations);
  assert.match(history.text, /BEGIN/); assert.match(history.text, /END/); assert.match(history.text, /Earlier answer/);
  assert.ok(Buffer.byteLength(history.text) <= 7000, 'a large log cannot overflow the startup input');
  const f = fixture(t, 'connecting', observer);
  f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Typed during startup' });
  assert.equal(f.appends.length, 0);
  f.live.state = 'active'; f.live.emit('event', { type: 'session.started' });
  await flush();
  f.mediator.feed.flush(); await flush();
  assert.match(content(f), /Typed during startup/);
  assert.doesNotMatch(content(f), /BEGIN|Earlier answer/, 'earlier work is not replayed as appends');
  assert.equal(JSON.parse(observer.observations[0].text).tool_response.stdout, output);
  assert.ok(f.appends.every(e => e.kind === 'thinking'), 'old assistant messages do not get spoken again');
  f.mediator.stop();
  const restarted = fixture(t, 'active', observer);
  await flush();
  restarted.mediator.feed.flush(); await flush();
  assert.equal(restarted.appends.length, 0, 'restarting voice sends no backlog');
  restarted.hook({ hook_event_name: 'MessageDisplay', message_id: 'restart', index: 0, delta: 'Done after restart.' });
  await flush();
  assert.match(content(restarted), /Done after restart/);
});

test('a delegation sends ordinary user text once, without asking Claude to use companion tools', async t => {
  const f = fixture(t);
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'Make the button blue.', start_ms: 0, end_ms: 1000 });
  f.mediator.delegate('work', 1100);
  f.mediator.delegate('duplicate', 1100);
  await flush();
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].content, /^User request \(transcribed speech\): .+\n\nuser: Make the button blue\.$/);
  assert.doesNotMatch(f.deliveries[0].content, /acknowledge|reply|message_id|GPT Live/);
});

test('when voice ends, speech not yet passed on goes to the agent, tagged with why', async t => {
  const f = fixture(t);
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'Make the button blue.', start_ms: 0, end_ms: 1000 });
  f.mediator.delegate('work', 1100);
  f.live.emit('event', { type: 'session.output_transcript.delta', delta: 'Sure, passing that on.', start_ms: 1200, end_ms: 2000 });
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'And then make the header', start_ms: 5000, end_ms: 6000 });
  f.mediator.handOff('Microphone audio stream stopped');
  f.mediator.handOff('Microphone audio stream stopped');
  await flush();
  assert.equal(f.deliveries.length, 2, 'the delegated request, then one handoff');
  assert.match(f.deliveries[1].content, /^\[Voice session ended: Microphone audio stream stopped\] Sent because the voice session ended, not because the voice assistant passed it on\./);
  assert.match(f.deliveries[1].content, /\n\nvoice assistant: Sure, passing that on\.\nuser: And then make the header$/);
  assert.doesNotMatch(f.deliveries[1].content, /button blue/, 'speech already delegated is not sent again');
  assert.equal(f.deliveries[1].delegationId, null);
});

test('when voice ends with everything already passed on, nothing more is sent', async t => {
  const f = fixture(t);
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: 'Make the button blue.', start_ms: 0, end_ms: 1000 });
  f.mediator.delegate('work', 1100);
  f.live.emit('event', { type: 'session.output_transcript.delta', delta: 'Done.', start_ms: 1200, end_ms: 1600 });
  f.mediator.handOff('requested');
  await flush();
  assert.equal(f.deliveries.length, 1, 'the voice assistant speaking alone is not a request');
});

test('duplicate display hooks do not produce duplicate context; subagent hooks retain their content', async t => {
  const f = fixture(t);
  const display = { hook_event_name: 'MessageDisplay', message_id: 'same', index: 0, delta: 'One answer.' };
  f.hook(display); f.hook(display);
  f.hook({ hook_event_name: 'PostToolUseFailure', agent_id: 'child', tool_name: 'Bash', error: 'test failed', custom_field: { detail: 'kept' } });
  await flush();
  assert.equal(content(f, 'thinking').match(/One answer/g)!.length, 1);
  assert.match(content(f, 'thinking'), /child.*Bash.*test failed.*custom_field.*kept/);
  f.mediator.stop(); assert.equal(f.observer.listenerCount('observation'), 0);
});

test('a failed append surfaces a fault and ends stale voice instead of silently losing context', async t => {
  const f = fixture(t);
  const faults: any[] = []; f.mediator.publish = e => faults.push(e);
  f.live.append = async () => { throw new Error('rejected'); };
  f.hook({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'still retained' } });
  await flush();
  assert.equal(f.live.state, 'closed');
  assert.match(faults[0].message, /restart voice.*rejected/);
  assert.match(f.observer.observations[0].text, /still retained/);
});


test('a restart after a long session starts with no burst of appends', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  for (let i = 0; i < 200; i++) {
    observer.hook({ session_id: 'test', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: `Result ${i} `.repeat(400) } });
    observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: `m${i}`, index: 0, delta: `Answer ${i}. `.repeat(200) });
  }
  const f = fixture(t, 'active', observer);
  await flush(); f.mediator.feed.flush(); await flush();
  assert.equal(f.appends.length, 0);
  const history = startupHistory(claude, observer.observations);
  assert.match(history.text, /Answer 199/); assert.doesNotMatch(history.text, /Answer 0\./);
  assert.match(history.text, /earlier observations from this Claude session are omitted/);
  f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
  await flush();
  assert.match(content(f), /"prompt":"next"/);
  assert.ok(f.appends.every(e => e.kind === 'thinking'));
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
  f.hook({ hook_event_name: 'MessageDisplay', message_id: 'final', index: 0, delta: 'All work complete.' });
  f.hook({ hook_event_name: 'Stop', last_assistant_message: 'All work complete.' });
  await flush();
  for (let i = 0; i < 10; i++) { f.mediator.feed.flush(); await flush(); }
  t.mock.timers.tick(300000); await flush();
  assert.equal(f.observer.observations.length, 83, 'all original hooks survive locally');
  assert.match(content(f), /PermissionRequest/);
  assert.equal(content(f).match(/All work complete/g)?.length, 1, 'the displayed answer is sent; Stop, which repeats it, is not');
  for (let i = 0; i < 40; i++) {
    assert.ok(content(f).includes(`Detail ${i}.`));
    assert.ok(content(f).includes(`Result ${i}.`));
  }
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

test('agent updates wait while the operator talks: heard by the microphone, or by GPT Live\'s transcript', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t);
  f.mediator.hear({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008 });
  f.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_response: { content: 'alpha' } });
  assert.equal(f.appends.length, 0, 'the operator is talking');
  t.mock.timers.tick(2000);
  assert.equal(f.appends.length, 1, 'two seconds after the last sound');
  f.mediator.hear({ at: Date.now(), inputRms: 0, rawInputRms: .05, gateThreshold: .008 });
  f.mediator.hear({ at: Date.now(), inputRms: .001, rawInputRms: .002, gateThreshold: 0 });
  f.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'b.txt' }, tool_response: { content: 'beta' } });
  assert.equal(f.appends.length, 2, 'a closed gate or room noise is not speech');
  f.live.emit('event', { type: 'session.input_transcript.delta', delta: ' wait' });
  f.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'c.txt' }, tool_response: { content: 'gamma' } });
  assert.equal(f.appends.length, 2, 'the transcript of the operator also holds updates');
  t.mock.timers.tick(2000);
  assert.equal(f.appends.length, 3);
});
