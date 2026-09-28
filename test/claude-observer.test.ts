import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { redact } from '../src/core/redact.ts';

test('final display after Stop neither reopens work nor duplicates the final message', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' }); t.after(() => observer.close());
  const text: string[] = []; observer.on('text', e => text.push(e.text));
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit' });
  observer.hook({ session_id: 'test', hook_event_name: 'Stop', last_assistant_message: 'Done.' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'a', index: 0, final: true, delta: 'Done.' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(observer.state, 'idle'); assert.deepEqual(text, ['Done.']);
});
test('display before Stop also preserves state and text', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' }); t.after(() => observer.close());
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'b', index: 0, final: false, delta: 'Part one\n' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'b', index: 1, final: true, delta: 'Part two' });
  observer.hook({ session_id: 'test', hook_event_name: 'Stop', last_assistant_message: 'Part one\nPart two' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(observer.state, 'idle'); assert.equal(observer.text, 'Part one\nPart two');
});

test('terminal prompts and replies share ordered, redacted history even while voice is off', t => {
  const observer = new ClaudeObserver({ sessionId: 'test', clean: (text: string) => redact(text, ['private-test-secret']) });
  t.after(() => observer.close());
  const inputs: string[] = []; observer.on('input', e => inputs.push(e.text));
  const prompt = { session_id: 'test', hook_event_name: 'UserPromptSubmit', prompt: 'Remember private-test-secret' };
  observer.hook({ ...prompt, session_id: 'foreign' });
  observer.hook(prompt);
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'a', index: 0, delta: 'ACK' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'a', index: 1, delta: 'NOWLEDGED' });
  observer.hook(prompt);
  assert.deepEqual(inputs, ['Remember [redacted]', 'Remember [redacted]'], 'identical prompts on different submissions remain distinct');
  assert.deepEqual(JSON.parse(observer.conversationContext()), [
    { role: 'input', text: 'Remember [redacted]' }, { role: 'output', text: 'ACKNOWLEDGED' }, { role: 'input', text: 'Remember [redacted]' },
  ]);
});

function transcriptRecords() {
  return [
    { type: 'user', uuid: 'u1', message: { content: 'My codename is ORCHID' } },
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'thinking', thinking: 'not visible' }, { type: 'text', text: 'ACK' }] } },
    { type: 'user', uuid: 'tool', message: { content: [{ type: 'tool_result', content: 'private tool internals' }] } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { content: 'internal metadata' } },
    { type: 'user', uuid: 'foreign', sessionId: 'foreign', message: { content: 'another session' } },
    { type: 'assistant', isSidechain: true, message: { id: 'subagent', content: [{ type: 'text', text: 'another agent' }] } },
    { type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'My codename is ORCHID' }] } },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'ACK' }] } },
  ];
}
const savedConversation = [
  { role: 'input', text: 'My codename is ORCHID' }, { role: 'output', text: 'ACK' },
  { role: 'input', text: 'My codename is ORCHID' }, { role: 'output', text: 'ACK' },
];

test('resume restores both sides of the transcript without replaying events', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-history-')); const file = path.join(dir, 'test.jsonl');
  const observer = new ClaudeObserver({ sessionId: 'test' });
  t.after(() => { observer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(file, transcriptRecords().map(record => JSON.stringify(record)).join('\n') + '\n');
  observer.on('input', () => assert.fail('Saved prompts must not replay as new input'));
  observer.on('text', () => assert.fail('Saved replies must not replay as new output'));
  observer.attachTranscript(file);
  assert.deepEqual(JSON.parse(observer.conversationContext()), savedConversation);
  assert.ok(observer.observations.some(o => o.text.includes('private tool internals')));
  assert.ok(observer.observations.every(o => !o.text.includes('not visible')));
});

test('transcript adapter restores tool results as context without displaying them as assistant speech', t => {
  const observer = new ClaudeObserver({ sessionId: 'test', observation: 'transcript' }); t.after(() => observer.close());
  const inputs: string[] = []; observer.on('input', e => inputs.push(e.text));
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit', prompt: 'My codename is ORCHID' });
  const records = transcriptRecords();
  for (const record of [...records, ...records]) observer.record(record);
  assert.deepEqual(JSON.parse(observer.conversationContext()), savedConversation);
  assert.equal(inputs.length, 2);
});

test('conversation and tool context are retained without the old character or entry clipping', t => {
  const observer = new ClaudeObserver({ sessionId: 'test' }); t.after(() => observer.close());
  const prompt = 'x'.repeat(50000);
  observer.input(prompt); observer.textDelta('Reply');
  for (let i = 0; i < 250; i++) observer.input('hello');
  assert.equal(observer.conversation.length, 252);
  assert.equal(JSON.parse(observer.conversationContext())[0].text, prompt);
  const tool = { session_id: 'test', hook_event_name: 'PostToolUse', tool_response: { stdout: 'y'.repeat(150000) } };
  observer.hook(tool);
  assert.deepEqual(JSON.parse(observer.observations[0].text), tool);
});

test('channel-delivered prompts remain part of resumed history even though Claude marks them as metadata', t => {
  const observer = new ClaudeObserver({ sessionId: 'test' }); t.after(() => observer.close());
  observer.record({ type: 'user', uuid: 'voice', isMeta: true, origin: { kind: 'channel', server: 'voice' }, message: { content: '<channel source="voice">Build a clock</channel>' } }, { emit: false });
  assert.deepEqual(JSON.parse(observer.conversationContext()), [{ role: 'input', text: '<channel source="voice">Build a clock</channel>' }]);
});

test('without a session ID, the first hook names the session and later foreign hooks are refused', t => {
  const observer = new ClaudeObserver({}); t.after(() => observer.close());
  const named: string[] = []; observer.on('session', id => named.push(id));
  assert.equal(observer.hook({ session_id: 'picked', hook_event_name: 'SessionStart' }), true);
  assert.equal(observer.hook({ session_id: 'other', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), false);
  assert.deepEqual(named, ['picked']); assert.equal(observer.sessionId, 'picked'); assert.equal(observer.state, 'idle');
});

test('a SessionStart for another session moves to it, as when a resume completes after a provisional ID', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-switch-')), resumed = path.join(dir, 'resumed.jsonl');
  const log: any[] = [];
  const observer = new ClaudeObserver({ log: event => log.push(event) });
  t.after(() => { observer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(resumed, [
    { type: 'user', sessionId: 'resumed', uuid: 'u1', message: { role: 'user', content: 'Plan the launch' } },
    { type: 'assistant', sessionId: 'resumed', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Here is the plan.' }] } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const named: string[] = []; observer.on('session', id => named.push(id));
  // Claude loads its instructions under a provisional ID, then resumes the picked session.
  observer.hook({ session_id: 'provisional', hook_event_name: 'InstructionsLoaded', transcript_path: path.join(dir, 'provisional.jsonl') });
  observer.hook({ session_id: 'resumed', hook_event_name: 'SessionStart', source: 'resume', transcript_path: resumed });
  assert.deepEqual(named, ['provisional', 'resumed']); assert.equal(observer.sessionId, 'resumed');
  assert.deepEqual(JSON.parse(observer.conversationContext()), [{ role: 'input', text: 'Plan the launch' }, { role: 'output', text: 'Here is the plan.' }], 'the resumed conversation is history');
  assert.equal(observer.hook({ session_id: 'resumed', hook_event_name: 'UserPromptSubmit', prompt: 'Continue' }), true);
  assert.equal(observer.hook({ session_id: 'provisional', hook_event_name: 'Stop' }), false, 'the provisional session is left behind');
  assert.equal(observer.hook({ session_id: 'resumed', agent_id: 'child', hook_event_name: 'SessionStart' }), true);
  assert.equal(observer.hook({ session_id: 'other', agent_id: 'child', hook_event_name: 'SessionStart' }), false, 'a subagent never moves the session');
  assert.deepEqual(log.filter(e => e.type === 'agent.hook_refused').map(e => [e.name, e.session_id, e.sessionId]), [['Stop', 'provisional', 'resumed'], ['SessionStart', 'other', 'resumed']]);
});
