import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentObserver } from '../src/agent.js';
import { redact } from '../src/context.js';

test('final display after Stop neither reopens work nor duplicates the final message', async t => {
  const observer = new AgentObserver({ sessionId: 'test' }); t.after(() => observer.close());
  const text = []; observer.on('text', e => text.push(e.text));
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit' });
  observer.hook({ session_id: 'test', hook_event_name: 'Stop', last_assistant_message: 'Done.' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'a', index: 0, final: true, delta: 'Done.' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(observer.state, 'idle'); assert.deepEqual(text, ['Done.']);
});
test('display before Stop also preserves state and text', async t => {
  const observer = new AgentObserver({ sessionId: 'test' }); t.after(() => observer.close());
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'b', index: 0, final: false, delta: 'Part one\n' });
  observer.hook({ session_id: 'test', hook_event_name: 'MessageDisplay', message_id: 'b', index: 1, final: true, delta: 'Part two' });
  observer.hook({ session_id: 'test', hook_event_name: 'Stop', last_assistant_message: 'Part one\nPart two' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(observer.state, 'idle'); assert.equal(observer.text, 'Part one\nPart two');
});

test('terminal prompts and replies share ordered, redacted history even while voice is off', t => {
  const observer = new AgentObserver({ sessionId: 'test', clean: text => redact(text, ['private-test-secret']) });
  t.after(() => observer.close());
  const inputs = []; observer.on('input', e => inputs.push(e.text));
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
  const observer = new AgentObserver({ sessionId: 'test' });
  t.after(() => { observer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(file, transcriptRecords().map(JSON.stringify).join('\n') + '\n');
  observer.on('input', () => assert.fail('Saved prompts must not replay as new input'));
  observer.on('text', () => assert.fail('Saved replies must not replay as new output'));
  observer.attachTranscript(file);
  assert.deepEqual(JSON.parse(observer.conversationContext()), savedConversation);
  assert.ok(observer.observations.some(o => o.text.includes('private tool internals')));
  assert.ok(observer.observations.every(o => !o.text.includes('not visible')));
});

test('transcript adapter restores tool results as context without displaying them as assistant speech', t => {
  const observer = new AgentObserver({ sessionId: 'test', observation: 'transcript' }); t.after(() => observer.close());
  const inputs = []; observer.on('input', e => inputs.push(e.text));
  observer.hook({ session_id: 'test', hook_event_name: 'UserPromptSubmit', prompt: 'My codename is ORCHID' });
  const records = transcriptRecords();
  for (const record of [...records, ...records]) observer.record(record);
  assert.deepEqual(JSON.parse(observer.conversationContext()), savedConversation);
  assert.equal(inputs.length, 2);
});

test('conversation and tool context are retained without the old character or entry clipping', t => {
  const observer = new AgentObserver({ sessionId: 'test' }); t.after(() => observer.close());
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
  const observer = new AgentObserver({ sessionId: 'test' }); t.after(() => observer.close());
  observer.record({ type: 'user', uuid: 'voice', isMeta: true, origin: { kind: 'channel', server: 'voice' }, message: { content: '<channel source="voice">Build a clock</channel>' } }, { emit: false });
  assert.deepEqual(JSON.parse(observer.conversationContext()), [{ role: 'input', text: '<channel source="voice">Build a clock</channel>' }]);
});
