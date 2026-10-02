import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextRule, TurnState } from '../src/core/adapter.ts';
import { ObservationProjector, ObservationFeed, type ContextTarget } from '../src/core/observation-feed.ts';
import { contextData, truncate } from '../src/core/context-rules.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { codex } from '../src/adapters/codex/index.ts';
import { pi } from '../src/adapters/pi/index.ts';
import { nextTurnState, observationKind } from '../src/adapters/claude/observer.ts';
import * as codexEvents from '../src/adapters/codex/observer.ts';

// Hooks as each adapter observes them. A new projector or feed starts from an
// unknown turn, as each one did when it tracked the turn itself.
let turn: TurnState = 'unknown';
const observation = (name: string, data: Record<string, any> = {}) => {
  const raw = { hook_event_name: name, ...data };
  turn = nextTurnState(turn, raw);
  return { kind: observationKind(raw), name, text: JSON.stringify(raw), state: turn };
};
const codexObservation = (name: string, data: Record<string, any> = {}) => {
  const raw = { hook_event_name: name, ...data };
  turn = codexEvents.nextTurnState(turn, raw);
  return { kind: codexEvents.observationKind(raw), name, text: JSON.stringify(raw), state: turn };
};
const transcript = (data: Record<string, any>) => ({ kind: observationKind(data), name: 'transcript', text: JSON.stringify(data), state: turn });
const newProjector = (agent = claude) => { turn = 'unknown'; return new ObservationProjector(agent); };
const view = (projector: ObservationProjector, o: Parameters<ObservationProjector['project']>[0]) => JSON.parse(projector.project(o)!.text);
const EXCERPT = / … \[omitted: [\d,]+ chars\] … /;

test('the core applies any table: remove or truncate an event or a key, matched on the event as it arrived', () => {
  const context: ContextRule[] = [
    { event: 'Noise', remove: true },
    { where: { tool_name: 'Big' }, key: 'tool_name', remove: true },
    { where: { tool_name: 'Big' }, key: 'tool_response.body', truncate: 10 },
    { where: { tool_name: 'Big' }, key: 'tool_response.missing.deep', truncate: 0 },
    { event: 'Whole', truncate: 20 },
  ];
  const agent = { ...claude, context };
  assert.equal(contextData(agent, { name: 'Noise', text: '{"detail":"x"}' }), undefined);
  assert.deepEqual(contextData(agent, { name: 'PostToolUse', text: JSON.stringify({ tool_name: 'Big', tool_response: { body: 'abcdefghijklmnopqrstuvwxyz' } }) }),
    { tool_response: { body: 'abcde … [omitted: 16 chars] … vwxyz' } }, 'a removed field still matches later rows; a missing path is ignored');
  assert.equal(contextData(agent, { name: 'Whole', text: JSON.stringify({ a: 'x'.repeat(100) }) }), '{"a":"xxxx … [omitted: 88 chars] … xxxxxxxx"}');
  assert.deepEqual(contextData(agent, { name: 'Other', text: JSON.stringify({ tool_name: 'Small', a: 1 }) }), { tool_name: 'Small', a: 1 }, 'anything no row names is sent as it is');
  assert.equal(truncate('😄'.repeat(30), 10), '😄😄😄😄😄 … [omitted: 20 chars] … 😄😄😄😄😄', 'a cut never splits a character');
  assert.equal(truncate({ a: 1 }, 0), '[omitted: 7 chars]');
  assert.deepEqual(truncate({ a: 1 }, 100), { a: 1 }, 'a value that fits keeps its shape');
});

test('a row reaches into every item of a list, and can match a nested field', () => {
  const context: ContextRule[] = [
    { where: { 'message.role': 'user' }, remove: true },
    { key: ['message.content.signature', 'message.content.args.content'], remove: true },
    { key: 'message.content.text', truncate: 10 },
  ];
  const agent = { ...claude, context };
  const event = (role: string) => ({ name: 'message_end', text: JSON.stringify({ message: { role, content: [
    { type: 'text', text: 'abcdefghijklmnopqrstuvwxyz', signature: 's1' }, { type: 'call', args: { content: 'file', path: 'a' } }, 'plain' ] } }) });
  assert.equal(contextData(agent, event('user')), undefined, 'matched by a field one level down');
  assert.deepEqual(contextData(agent, event('assistant')), { message: { role: 'assistant', content: [
    { type: 'text', text: 'abcde … [omitted: 16 chars] … vwxyz' }, { type: 'call', args: { path: 'a' } }, 'plain' ] } });
  assert.deepEqual(contextData(agent, { name: 'x', text: JSON.stringify({ message: { role: 'user' }, other: 1 }) }), undefined);
  assert.notEqual(contextData({ ...claude, context: [{ where: { 'message.content.type': 'text' }, remove: true }] }, event('assistant')), undefined, 'a condition never steps into a list');
});

test('only the table trims: an unlisted large result goes whole, with a short note first; prose never gets one', () => {
  const output = 'BEGIN\n' + '世界 😄 useful detail\n'.repeat(3000) + 'END';
  const large = view(newProjector(), observation('PostToolUse', { tool_name: 'Grep', tool_response: { content: output } }));
  assert.equal(Object.keys(large)[0], 'note');
  assert.equal(large.note, 'large result, shown untrimmed');
  assert.equal(large.data.tool_response.content, output);
  assert.equal(view(newProjector(), observation('PostToolUse', { tool_name: 'Grep', tool_response: { content: 'one match' } })).note, undefined);
  const prose = view(newProjector(), observation('MessageDisplay', { delta: output }));
  assert.equal(prose.note, undefined, 'long assistant text is expected');
  assert.equal(prose.data.delta, output);
});

test('repeated code becomes a reference while the distinct tool result remains', () => {
  const projector = newProjector(), command = 'build\n' + 'source code\n'.repeat(1000);
  const first = view(projector, observation('PreToolUse', { tool_name: 'Bash', tool_input: { command } }));
  const second = view(projector, observation('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { exitCode: 1, stderr: 'missing dependency' } }));
  assert.equal(first.data.tool_input.command, command, 'a command is always whole');
  assert.deepEqual(second.data.tool_input.command, { same_as: 'hook 1 data.tool_input.command' });
  assert.deepEqual(second.data.tool_response, { exitCode: 1, stderr: 'missing dependency' });
});

test('a removed Stop still moves the turn state later records carry; a child Stop cannot end the main turn', () => {
  const p = newProjector(), state = (name: string, data?: Record<string, any>) => view(p, observation(name, data)).claude_turn_state;
  assert.equal(state('PreToolUse'), 'working');
  assert.equal(p.project(observation('Stop', { agent_id: 'child' })), null);
  assert.equal(state('MessageDisplay', { delta: 'Still going.' }), 'working');
  assert.equal(p.project(observation('Stop', { background_tasks: ['still running'] })), null);
  assert.equal(state('MessageDisplay', { delta: 'Waiting on a task.' }), 'working');
  assert.equal(p.project(observation('Stop', { last_assistant_message: 'Done.' })), null, 'Stop is never sent');
  assert.equal(state('MessageDisplay', { delta: 'Final sentence.' }), 'turn_finished');
  assert.equal(state('UserPromptSubmit'), 'working');
  assert.equal(state('PermissionRequest'), 'needs_operator');
});

test("Claude's table: whole files and command output become excerpts; commands, errors and edits stay whole", () => {
  const written = 'line of the file\n'.repeat(500), before = 'old line of the file\n'.repeat(500), p = newProjector();
  const write = { tool_name: 'Write', tool_input: { file_path: '/w/a.ts', content: written } };
  const pre = view(p, observation('PreToolUse', write));
  const post = view(p, observation('PostToolUse', { ...write, tool_response: { type: 'create', filePath: '/w/a.ts', content: written } }));
  assert.match(pre.data.tool_input.content, /^line of the file\n[\s\S]* … \[omitted: 7,300 chars\] … [\s\S]*line of the file\n$/);
  assert.equal(Array.from(pre.data.tool_input.content.replace(EXCERPT, '')).length, 1200, 'the first and last 600 characters');
  assert.deepEqual(post.data.tool_input.content, { same_as: 'hook 1 data.tool_input.content' }, 'Pre and Post share a rule, so the repeat is a reference');
  assert.deepEqual(post.data.tool_response.content, { same_as: 'hook 1 data.tool_input.content' });
  const edit = view(p, observation('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/w/b.ts', old_string: 'red', new_string: 'blue' },
    tool_response: { filePath: '/w/b.ts', originalFile: before, structuredPatch: [{ lines: ['-red', '+blue'] }] } }));
  assert.match(edit.data.tool_response.originalFile, EXCERPT);
  assert.deepEqual(edit.data.tool_response.structuredPatch, [{ lines: ['-red', '+blue'] }]);
  assert.deepEqual(edit.data.tool_input, { file_path: '/w/b.ts', old_string: 'red', new_string: 'blue' });
  const read = view(p, observation('PostToolUse', { tool_name: 'Read', tool_response: { type: 'text', file: { filePath: '/w/c.md', content: 'note text\n'.repeat(300), numLines: 300 } } }));
  assert.match(read.data.tool_response.file.content, EXCERPT);
  assert.equal(read.data.tool_response.file.numLines, 300);
  const pdf = view(p, observation('PostToolUse', { tool_name: 'Read', tool_response: { type: 'parts', file: { filePath: '/w/d.pdf', count: 2 }, pages: [{ base64: 'iVBOR', mediaType: 'image/jpeg' }, { base64: 'iVBOR', mediaType: 'image/jpeg' }] } }));
  assert.match(pdf.data.tool_response.pages, /^\[omitted: \d+ chars\]$/);
  const stderr = 'Error: 2 tests failed\n'.repeat(100);
  const bash = view(p, observation('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'compiling module\n'.repeat(400), stderr, interrupted: false } }));
  assert.match(bash.data.tool_response.stdout, EXCERPT);
  assert.equal(bash.data.tool_response.stderr, stderr, 'stderr is never truncated');
  assert.equal(bash.data.tool_input.command, 'npm test');
  assert.equal(p.project(observation('PostToolBatch', { tool_calls: [write] })), null, 'PostToolBatch is never sent');
  assert.deepEqual(view(p, observation('MessageDisplay', { session_id: 's', cwd: '/w', prompt_id: 'p', message_id: 'm', index: 0, final: true, delta: 'Done.' })).data, { delta: 'Done.' }, 'transport fields are removed');
});

test("Codex's table: patches and command output become excerpts; the command and Stop stay", () => {
  const c = newProjector(codex), patch = '*** Begin Patch\n*** Add File: web/index.html\n' + '+<p>hello</p>\n'.repeat(400) + '*** End Patch';
  const pre = view(c, codexObservation('PreToolUse', { tool_name: 'apply_patch', turn_id: 't', model: 'gpt', tool_input: { command: patch } }));
  const post = view(c, codexObservation('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success. Updated the following files:\nA web/index.html' }));
  assert.match(pre.data.tool_input.command, /^\*\*\* Begin Patch[\s\S]* … \[omitted: [\d,]+ chars\] … [\s\S]*\*\*\* End Patch$/);
  assert.deepEqual(Object.keys(pre.data), ['tool_name', 'tool_input'], 'transport fields are removed');
  assert.deepEqual(post.data.tool_input.command, { same_as: 'hook 1 data.tool_input.command' });
  assert.match(post.data.tool_response, /Updated the following files/);
  const bash = view(c, codexObservation('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'ok\n'.repeat(1000) + 'Error: failed' }));
  assert.match(bash.data.tool_response, /Error: failed$/, 'the end of the output, where errors land, is kept');
  assert.equal(bash.data.tool_input.command, 'npm test');
  const stop = view(c, codexObservation('Stop', { turn_id: 't', last_assistant_message: 'All done.' }));
  assert.deepEqual(stop.data, { last_assistant_message: 'All done.' });
  assert.equal(stop.codex_turn_state, 'turn_finished');
});

test('a voice request echoed as the prompt becomes a short frame for either agent; typed prompts go whole', () => {
  const id = '3f1e2d4c-5b6a-4978-8a9b-0c1d2e3f4a5b', content = 'User request (transcribed speech): …\n\nuser: Make the button blue.';
  const p = newProjector();
  assert.equal(view(p, observation('UserPromptSubmit', { prompt: `<channel source="voice" message_id="${id}" source_kind="voice_operator">\n${content}\n</channel>` })).data.prompt,
    '[voice request 3f1e2d4c: the voice command you already have; Claude has received it]');
  assert.equal(view(p, observation('UserPromptSubmit', { prompt: 'Make the button red.' })).data.prompt, 'Make the button red.');
  const c = newProjector(codex), label = `[Voice request ${id}]\n${content}`;
  assert.equal(view(c, codexObservation('UserPromptSubmit', { prompt: label })).data.prompt, '[voice request 3f1e2d4c: the voice command you already have; Codex has received it]');
  assert.equal(view(c, { kind: 'prompt', name: 'UserMessage', text: JSON.stringify({ source: 'transcript', type: 'UserMessage', text: label }), state: turn }).data.text,
    '[voice request 3f1e2d4c: the voice command you already have; Codex has received it]', 'steered input, seen only in the transcript');
});

test('complete prose retains the middle of long answers, repeated requests and restored messages', () => {
  const message = 'Beginning. ' + 'A relevant middle detail 世界 😄. '.repeat(600) + 'Final instruction.';
  for (const [name, key] of [['MessageDisplay', 'delta'], ['UserPromptSubmit', 'prompt']]) {
    const p = newProjector();
    for (let i = 0; i < 2; i++) assert.equal(view(p, observation(name, { [key]: message })).data[key], message);
  }
  for (const role of ['user', 'assistant']) {
    assert.equal(view(newProjector(), transcript({ source: 'transcript', role, block: { type: 'text', text: message } })).data.block.text, message);
  }
});

test('tool result fields resembling transport metadata retain their domain meaning', () => {
  const data = view(newProjector(), observation('PostToolUse', { session_id: 'omit', tool_response: { index: 7, message_id: 'application-message', cwd: '/task/output' } })).data;
  assert.equal(data.session_id, undefined);
  assert.deepEqual(data.tool_response, { index: 7, message_id: 'application-message', cwd: '/task/output' });
});

function fixture(t: TestContext) {
  const logs: any[] = [], sent: any[][] = [], context: ContextTarget = { add: (...args: any[]) => sent.push(args) };
  turn = 'unknown';
  const feed = new ObservationFeed(context, e => logs.push(e), { agent: claude });
  t.after(() => feed.stop());
  return { feed, context, logs, sent };
}

test('pending acknowledgments do not discard assistant paragraphs or delay new hook delivery', t => {
  const f = fixture(t);
  f.feed.add(observation('PreToolUse'));
  for (let i = 0; i < 60; i++) f.feed.add(observation('MessageDisplay', { delta: `Step ${i}: ` + 'detail '.repeat(100) }));
  f.feed.add(observation('PostToolUseFailure', { error: 'build failed' }));
  f.feed.add(observation('Stop', { last_assistant_message: 'The file exists but the build failed.' }));
  const deliveries = f.sent.map(s => s[1]).join('\n');
  for (let i = 0; i < 60; i++) assert.ok(deliveries.includes(`Step ${i}: ` + 'detail '.repeat(100)));
  assert.match(deliveries, /build failed/);
  assert.doesNotMatch(deliveries, /The file exists/, 'Stop is not sent');
  assert.ok(f.sent.every(s => s[0] === 'thinking'));
  const prepared = f.logs.filter(e => e.type === 'context.prepared');
  assert.equal(prepared.at(-1).sources.at(-1).name, 'PostToolUseFailure');
  assert.equal(prepared.reduce((n, e) => n + e.sources.length, 0), 62);
  for (const line of deliveries.split('\n')) {
    const item = JSON.parse(line);
    if (item.hook === 'MessageDisplay') assert.equal(item.claude_turn_state, 'working', 'coalescing PreToolUse must not lose its lifecycle transition');
  }
});

test('ordinary hooks wait at most the collection window; urgent hooks flush without that wait', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.feed.add(observation('PreToolUse', { tool_name: 'Read' }));
  t.mock.timers.tick(249); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1); assert.equal(f.sent.length, 1);
  f.feed.add(observation('PermissionRequest', { tool_name: 'Bash' }));
  assert.equal(f.sent.length, 2);
  f.feed.add(observation('Stop', { last_assistant_message: 'Ready.' }));
  assert.equal(f.sent.length, 2, 'a removed event sends nothing');
});

test('displayed answers are sent in full, from the main agent and subagents alike', t => {
  const f = fixture(t);
  f.feed.add(observation('MessageDisplay', { delta: 'Earlier error: missing file.' }));
  f.feed.add(observation('MessageDisplay', { delta: 'File ready.' }));
  f.feed.add(observation('MessageDisplay', { agent_id: 'child', delta: 'File ready.' }));
  f.feed.add(observation('Stop', { last_assistant_message: 'File ready. Open it locally.' }));
  f.feed.flush();
  const prepared = f.logs.find(e => e.type === 'context.prepared');
  assert.equal(prepared.sources.length, 3);
  assert.match(prepared.content, /Earlier error: missing file/);
  assert.match(prepared.content, /child/);
  assert.doesNotMatch(prepared.content, /Open it locally/);
});

test("Pi's table: a reply keeps its text, repeats and signatures go, and bulky tool output becomes excerpts", () => {
  turn = 'unknown';
  const p = new ObservationProjector(pi), sid = 'a0fafa', see = (data: Record<string, any>) => p.project({ kind: 'event', name: data.type, text: JSON.stringify({ ...data, session_id: sid }), state: 'working' });
  const data = (data: Record<string, any>) => JSON.parse(see(data)!.text).data;
  // Shapes from a live capture of Pi 1.0 (gpt-5.5) and a saved Pi session.
  assert.equal(see({ type: 'message_end', message: { role: 'system', content: '', sections: { preamble: 'x'.repeat(12000) } } }), null);
  assert.equal(see({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'List the files' }] } }), null, 'the input event carried it');
  assert.equal(see({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'README.md' }], isError: false } }), null, 'tool_execution_end carried it');
  const reply = data({ type: 'message_end', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'private', thinkingSignature: 'e'.repeat(1951) },
    { type: 'toolCall', id: 'call_3Sso6xrGoowlftx3bad4n4e5|fc_0a44', name: 'bash', arguments: { command: 'ls', timeout: 10 } },
    { type: 'text', text: 'This folder is a capture.', textSignature: '{"v":1,"id":"msg_0a44","phase":"final_answer"}' }],
    api: 'openai-responses', provider: 'openai', model: 'gpt-5.5', usage: { input: 3171, output: 37, cost: { total: 0.016965 } },
    stopReason: 'stop', timestamp: 1790918813371, responseId: 'resp_0a44', rawStopReason: 'completed', thinkingLevel: 'medium' } });
  assert.deepEqual(reply, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'toolCall', name: 'bash' }, { type: 'text', text: 'This folder is a capture.' }], stopReason: 'stop' } });
  const start = data({ type: 'tool_execution_start', toolCallId: 'call_3', parentToolCallId: 'call_2', toolName: 'bash', args: { command: 'npm test', timeout: 10 } });
  assert.deepEqual(start, { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test', timeout: 10 } }, 'the command is always whole');
  const output = 'ok\n'.repeat(1000) + 'Error: failed';
  const bash = data({ type: 'tool_execution_end', toolCallId: 'call_3', toolName: 'bash', isError: true,
    result: { content: [{ type: 'text', text: output }], structuredContent: { output, truncated: false, exit_code: 1, wall_time_seconds: 0 } } });
  assert.match(bash.result.content[0].text, EXCERPT); assert.match(bash.result.content[0].text, /Error: failed$/, 'the end, where errors land, is kept');
  assert.deepEqual(bash.result.structuredContent, { truncated: false, exit_code: 1, wall_time_seconds: 0 }, 'the second copy of the output goes');
  // A long search, as Pi reported one: its output cut, with a copy of what it kept in details.
  const search = 'src/core/startup-history.ts:    const data = contextData(agent, observations[i]);\n'.repeat(700);
  const cut = data({ type: 'tool_execution_end', toolCallId: 'call_9', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: search + '\n\n[Showing lines 1-700 of 4100]' }],
    details: { truncation: { content: search, truncated: true, truncatedBy: 'bytes', totalLines: 4100, outputLines: 700 }, fullOutputPath: '/tmp/pi-bash-1.log' } } });
  assert.ok(JSON.stringify(cut).length < 2000, 'one result stays one short record');
  assert.deepEqual(cut.result.details, { truncation: { truncated: true, truncatedBy: 'bytes', totalLines: 4100, outputLines: 700 }, fullOutputPath: '/tmp/pi-bash-1.log' });
  const screenshot = '{"content":[{"type":"text","text":"Successfully captured screenshot"},{"type":"image","data":"' + '/9j/4AAQSkZJRgABAQAAAQABAAD'.repeat(1500) + '"}]}';
  const script = data({ type: 'tool_execution_end', toolCallId: 'call_4', toolName: 'codemode', isError: false,
    result: { content: [{ type: 'text', text: 'Script completed\nWall time 3.4 seconds\nOutput:\n' }, { type: 'text', text: screenshot }],
      details: { calls: [{ name: 'mcp__open_claude_in_chrome__computer', args: '{"action":"screenshot"}' }] }, nestedCalls: { calls: [], complete: true } } });
  assert.ok(JSON.stringify(script).length < 2000, 'a screenshot inside a script output is excerpted');
  assert.deepEqual(Object.keys(script.result), ['content']);
  const write = data({ type: 'tool_execution_start', toolCallId: 'c5', toolName: 'write', args: { path: 'index.html', content: '<p>hello</p>\n'.repeat(400) } });
  assert.match(write.args.content, EXCERPT); assert.equal(write.args.path, 'index.html');
  const read = data({ type: 'tool_execution_end', toolCallId: 'c6', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'const value = 1;\n'.repeat(400) }] } });
  assert.match(read.result.content[0].text, EXCERPT);
  const edit = data({ type: 'tool_execution_end', toolCallId: 'c7', toolName: 'edit', isError: false, result: { content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.ts.' }], details: { diff: '-a\n+b', patch: '--- a.ts\n+++ a.ts\n-a\n+b', firstChangedLine: 3 } } });
  assert.deepEqual(edit.result.details, { diff: '-a\n+b', firstChangedLine: 3 });
  const model = data({ type: 'model_select', source: 'set', model: { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', cost: { input: 5 }, contextWindow: 400000, compat: { a: 'x'.repeat(500) } } });
  assert.match(model.model, /^\{"id":"gpt-5\.5","name":"GPT-5\.5"/);
  assert.equal(see({ type: 'agent_settled' })!.text.includes(sid), false, 'the session ID is transport, not context');
});
