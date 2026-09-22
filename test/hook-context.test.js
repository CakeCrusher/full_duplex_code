import test from 'node:test';
import assert from 'node:assert/strict';
import { HookContext, HookFeed } from '../src/hook-context.js';
import { estimatedTokens } from '../src/text-fragments.js';

const observation = (name, data = {}) => ({ name, text: JSON.stringify({ hook_event_name: name, ...data }) });

test('nested, wide and Unicode hook payloads have a total bound; raw observations survive', () => {
  const fixtures = [
    { tool_response: { stdout: 'BEGIN\n' + '世界 😄 useful detail\n'.repeat(6000) + 'test failed: missing dependency\nEND' } },
    { tool_response: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), 'value'.repeat(200)])) },
    { tool_response: { lines: Array.from({ length: 10000 }, (_, i) => `line ${i}`) }, error: 'fatal: permission denied' },
  ];
  for (const data of fixtures) for (const budget of [80, 240, 600]) {
    const hook = observation('PostToolUseFailure', data), original = hook.text;
    const result = new HookContext().project(hook, { budget });
    assert.ok(estimatedTokens(result.text) <= budget);
    assert.equal(hook.text, original);
    assert.equal(JSON.parse(result.text).partial, true);
    if (data.error) assert.match(result.text, /permission denied/);
  }
});

test('repeated code becomes a reference while the distinct tool result remains', () => {
  const projector = new HookContext(), command = 'build\n' + 'source code\n'.repeat(1000);
  const first = projector.project(observation('PreToolUse', { tool_input: { command } }));
  const second = projector.project(observation('PostToolUse', { tool_input: { command }, tool_response: { exitCode: 1, stderr: 'missing dependency' } }));
  assert.match(first.text, /source code/);
  assert.match(second.text, /Repeated content/);
  assert.match(second.text, /missing dependency/);
  assert.match(second.text, /exitCode.*1/);
});

test('child Stop cannot end the main turn; main Stop and later display agree', () => {
  const p = new HookContext(), state = (name, data) => JSON.parse(p.project(observation(name, data)).text).claude_turn_state;
  assert.equal(state('PreToolUse'), 'working');
  assert.equal(state('Stop', { agent_id: 'child' }), 'working');
  assert.equal(state('Stop', { background_tasks: ['still running'] }), 'working');
  assert.equal(state('Stop'), 'turn_finished');
  assert.equal(state('MessageDisplay', { delta: 'Final sentence.' }), 'turn_finished');
  assert.equal(state('UserPromptSubmit'), 'working');
  assert.equal(state('PermissionRequest'), 'needs_operator');
});

function fixture(t) {
  const logs = [], sent = [], context = { inFlightTokens: 1000, tokensPerSecond: 300, queue: [], add: (...args) => sent.push(args) };
  const feed = new HookFeed(context, e => logs.push(e));
  t.after(() => feed.stop());
  return { feed, context, logs, sent };
}

test('overload stays bounded and preserves Stop, errors and source provenance in causal order', t => {
  const f = fixture(t);
  f.feed.add(observation('PreToolUse'));
  for (let i = 0; i < 60; i++) f.feed.add(observation('MessageDisplay', { delta: `Step ${i}: ` + 'detail '.repeat(100) }));
  f.feed.add(observation('PostToolUseFailure', { error: 'build failed' }));
  f.feed.add(observation('Stop', { last_assistant_message: 'The file exists but the build failed.' }));
  assert.equal(f.sent.length, 0, 'do not load a saturated API with more data');
  assert.equal(f.feed.pending.length, 32);
  f.context.inFlightTokens = 0; f.feed.flush();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /build failed/);
  assert.match(f.sent[0][1], /turn_finished/);
  assert.equal(f.sent[0][0], 'thinking');
  const prepared = f.logs.find(e => e.type === 'context.prepared');
  assert.equal(prepared.sources.at(-1).name, 'Stop');
  assert.ok(prepared.sources.every(s => /^[a-f0-9]{64}$/.test(s.sourceHash)));
  assert.equal(f.logs.filter(e => e.type === 'context.coalesced').length + prepared.sources.length, 63);
  assert.ok(estimatedTokens(f.sent[0][1]) < 1300, 'framed batch remains a few seconds of context');
  for (const line of prepared.content.split('\n')) {
    const item = JSON.parse(line);
    if (item.hook === 'MessageDisplay') assert.equal(item.claude_turn_state, 'working', 'coalescing PreToolUse must not lose its lifecycle transition');
  }
});

test('ordinary hooks wait at most the collection window; urgent hooks flush without that wait', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.context.inFlightTokens = 0;
  f.feed.add(observation('PreToolUse', { tool_name: 'Read' }));
  t.mock.timers.tick(3999); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1); assert.equal(f.sent.length, 1);
  f.feed.add(observation('Stop', { last_assistant_message: 'Ready.' }));
  assert.equal(f.sent.length, 2);
});

test('historical compressed views remain marked historical even with very wide objects', () => {
  const result = new HookContext().project(observation('PostToolUse', { tool_response: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [i, 'data'.repeat(200)])) }), { budget: 80, historical: true });
  assert.equal(JSON.parse(result.text).historical, true);
});

test('Stop replaces only repeated display text from the same agent and records its source', t => {
  const f = fixture(t);
  f.feed.add(observation('MessageDisplay', { delta: 'Earlier error: missing file.' }));
  f.feed.add(observation('MessageDisplay', { delta: 'File ready.' }));
  f.feed.add(observation('MessageDisplay', { agent_id: 'child', delta: 'File ready.' }));
  f.feed.add(observation('Stop', { last_assistant_message: 'File ready. Open it locally.' }));
  f.context.inFlightTokens = 0; f.feed.flush();
  const prepared = f.logs.find(e => e.type === 'context.prepared');
  const combined = f.logs.filter(e => e.type === 'context.coalesced');
  assert.equal(combined.length, 1);
  assert.equal(combined[0].replacementSourceHash, prepared.sources.at(-1).sourceHash);
  assert.equal(prepared.sources.length, 3);
  assert.match(prepared.content, /Earlier error: missing file/);
  assert.match(prepared.content, /child/);
  assert.match(prepared.content, /Open it locally/);
});
