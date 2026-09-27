import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexObserver } from '../src/adapters/codex/observer.ts';

const session = '01a0db8b-d93d-73c2-bb82-741daa81fb6a';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A rollout transcript as Codex writes it: completed items as event messages.
const item = (type: string, text: string, turn = 't1') => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: session, turn_id: turn, item: type === 'AgentMessage'
  ? { type, id: `m-${text}`, content: [{ type: 'Text', text }], phase: 'commentary' } : { type, id: `u-${text}`, content: [{ type: 'text', text, text_elements: [] }] } } });
function fixture(t: TestContext, lines: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-codex-observer-')), transcript = path.join(dir, `rollout-${session}.jsonl`);
  fs.writeFileSync(transcript, lines.map(line => line + '\n').join(''));
  const observer = new CodexObserver({});
  t.after(() => { observer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const hook = (name: string, data: Record<string, any> = {}) => observer.hook({ session_id: session, transcript_path: transcript, hook_event_name: name, ...data });
  const append = (...more: string[]) => fs.appendFileSync(transcript, more.map(line => line + '\n').join(''));
  return { observer, hook, append, transcript };
}

test('the first hook names the session; hooks become observations, turn state and status', t => {
  const { observer, hook } = fixture(t);
  const named: string[] = []; observer.on('session', id => named.push(id));
  const inputs: string[] = []; observer.on('input', e => inputs.push(e.text));
  hook('SessionStart', { source: 'startup' });
  assert.deepEqual(named, [session]); assert.equal(observer.state, 'idle');
  assert.equal(observer.hook({ session_id: 'other', hook_event_name: 'Stop' }), false, 'another session is refused');
  hook('UserPromptSubmit', { turn_id: 't1', prompt: 'Build a clock' });
  assert.equal(observer.activeTurn, 't1'); assert.deepEqual(inputs, ['Build a clock']);
  hook('PreToolUse', { turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(observer.state, 'working');
  hook('SubagentStop', { turn_id: 't1', agent_id: 'child', agent_type: 'worker', last_assistant_message: 'child done' });
  assert.equal(observer.activeTurn, 't1', 'a subagent never ends the main turn');
  hook('PermissionRequest', { turn_id: 't1', tool_name: 'Bash' });
  assert.equal(observer.state, 'needs_attention');
  hook('Stop', { turn_id: 't1', last_assistant_message: 'Clock built.' });
  assert.equal(observer.activeTurn, null); assert.equal(observer.state, 'idle');
  hook('SessionEnd', { reason: 'other' });
  assert.equal(observer.state, 'exited');
  const byName = Object.fromEntries(observer.observations.map(o => [o.name, [o.kind, o.state, o.child]]));
  assert.deepEqual(byName, {
    SessionStart: ['event', 'unknown', false], UserPromptSubmit: ['prompt', 'working', false], PreToolUse: ['tool', 'working', false],
    SubagentStop: ['event', 'working', true], PermissionRequest: ['attention', 'needs_operator', false], Stop: ['turn_end', 'turn_finished', false], SessionEnd: ['session_end', 'exited', false],
  });
});

test('a session Codex announced before any hook takes that session\'s hooks, and no other', t => {
  const { observer, hook } = fixture(t);
  const named: string[] = []; observer.on('session', id => named.push(id));
  observer.adopt(session); observer.adopt('other');
  assert.deepEqual(named, [session]);
  hook('SessionStart', { source: 'startup' });
  assert.deepEqual(named, [session], 'the first hook does not name it again');
  assert.equal(observer.hook({ session_id: 'other', hook_event_name: 'Stop' }), false, 'another session is refused');
  assert.equal(observer.observations.length, 1);
});

test('assistant messages and steered input come from the transcript; typed prompts are not repeated', async t => {
  const { observer, hook, append } = fixture(t);
  const inputs: string[] = [], texts: string[] = [];
  observer.on('input', e => inputs.push(e.text)); observer.on('text', e => texts.push(e.text));
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { turn_id: 't1', prompt: 'Build a clock' });
  append(item('UserMessage', 'Build a clock'), item('AgentMessage', 'Starting the clock.'), item('UserMessage', '[Voice request 1]\nAlso add seconds.'), item('AgentMessage', 'Adding seconds.'));
  await wait(400);
  assert.deepEqual(inputs, ['Build a clock', '[Voice request 1]\nAlso add seconds.']);
  assert.deepEqual(texts, ['Starting the clock.', 'Adding seconds.']);
  assert.deepEqual(observer.observations.map(o => [o.name, o.kind]), [['SessionStart', 'event'], ['UserPromptSubmit', 'prompt'], ['AgentMessage', 'text'], ['UserMessage', 'prompt'], ['AgentMessage', 'text']]);
});

test('the final message is observed once, whether the transcript or the Stop hook brings it first', async t => {
  const first = fixture(t);
  first.hook('SessionStart', { source: 'startup' });
  first.append(item('AgentMessage', 'All done.')); await wait(300);
  first.hook('Stop', { turn_id: 't1', last_assistant_message: 'All done.' }); await wait(400);
  const stop = JSON.parse(first.observer.observations.find(o => o.name === 'Stop')!.text);
  assert.equal(stop.last_assistant_message, '(the assistant message above)');
  assert.equal(first.observer.observations.filter(o => o.text.includes('All done.')).length, 1);
  assert.equal(first.observer.text, 'All done.');
  const second = fixture(t);
  second.hook('SessionStart', { source: 'startup' });
  second.hook('Stop', { turn_id: 't1', last_assistant_message: 'All done.' });
  second.append(item('AgentMessage', 'All done.')); await wait(400);
  assert.equal(JSON.parse(second.observer.observations.find(o => o.name === 'Stop')!.text).last_assistant_message, 'All done.');
  assert.equal(second.observer.observations.filter(o => o.text.includes('All done.')).length, 1, 'the later transcript copy is not observed again');
  assert.equal(second.observer.text, 'All done.');
});

test('a resumed session restores its conversation without replaying it, then follows new messages', async t => {
  const { observer, hook, append } = fixture(t, [item('UserMessage', 'My codename is ORCHID'), item('AgentMessage', 'Noted.')]);
  const live: string[] = []; observer.on('text', e => live.push(e.text)); observer.on('input', e => live.push(e.text));
  hook('SessionStart', { source: 'resume' });
  assert.deepEqual(JSON.parse(observer.conversationContext()), [{ role: 'input', text: 'My codename is ORCHID' }, { role: 'output', text: 'Noted.' }]);
  assert.deepEqual(live, [], 'history is not emitted as new activity');
  append(item('AgentMessage', 'Welcome back.')); await wait(400);
  assert.deepEqual(live, ['Welcome back.']);
});
