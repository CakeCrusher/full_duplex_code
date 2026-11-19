import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/core/bridge.ts';
import { voiceRequest } from '../src/core/prompts.ts';
import { agy, AgyAdapter } from '../src/adapters/agy/index.ts';
import { agyForkArgs, readAgyArgs } from '../src/adapters/agy/arguments.ts';
import { AgyObserver, forkPoint, toolOf } from '../src/adapters/agy/observer.ts';
import { AgyDelivery } from '../src/adapters/agy/delivery.ts';
import { AgyServer, logEvent } from '../src/adapters/agy/server.ts';
import { GREETING, receivedRequest, turnText, WAKE } from '../src/adapters/agy/message.ts';
import { PLUGIN, projectFolder } from '../src/adapters/agy/launch.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const until = async <T>(check: () => T, label = 'condition') => {
  for (let i = 0; i < 500; i++) { const result = check(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const tmp = (t: TestContext, prefix = 'fd-agy-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const step = (index: number, fields: Record<string, unknown>, at = new Date()) => JSON.stringify({ step_index: index, status: 'DONE', created_at: at.toISOString(), ...fields }) + '\n';
const user = (text: string) => `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-19T02:34:12-05:00.\n</ADDITIONAL_METADATA>`;

test("agy's arguments: subcommands and help run it directly; print mode and remote agents are refused; a whole conversation ID names the session", () => {
  for (const args of [['models'], ['mcp', 'list'], ['plugin', 'list'], ['acp'], ['--help'], ['-h'], ['--version']]) assert.equal(readAgyArgs(args).direct, true, args.join(' '));
  for (const args of [['-p', 'hi'], ['--print'], ['--prompt=hi'], ['--output-format', 'json'], ['-input-format=stream-json']]) assert.throws(() => readAgyArgs(args), /no session to talk to/, args.join(' '));
  assert.throws(() => readAgyArgs(['--remote-agent']), /another machine/);
  const id = randomUUID();
  assert.deepEqual(readAgyArgs(['--conversation', id, '--model', 'gemini-3.8-flash-high']), { direct: false, resume: true, sessionId: id, assignSession: false });
  assert.deepEqual(readAgyArgs([`--conversation=${id.slice(0, 8)}`]), { direct: false, resume: true, sessionId: undefined, assignSession: false }, 'the start of an ID is for agy to resolve');
  assert.equal(readAgyArgs(['-c']).resume, true);
  assert.deepEqual(readAgyArgs(['--mode', 'accept-edits', '-i', '-p']), { direct: false, resume: false, sessionId: undefined, assignSession: false }, 'an option value is never read as an option');
  assert.deepEqual(agyForkArgs(['--conversation', id, '-c', '--model', 'm', '-i', 'first', '--log-file', '/x.log', '--project', 'p', '--effort=high', '--dangerously-skip-permissions', '--add-dir', '/d', '--remote-control']),
    ['--model', 'm', '--effort=high', '--dangerously-skip-permissions', '--add-dir', '/d'], "a fork keeps what shapes the agent's work, not the session, its first message, log or project");
});

test('a voice request is labeled for Antigravity and recognized inside the user message it records', () => {
  const id = randomUUID(), content = voiceRequest([{ role: 'operator', text: 'Make “世界” blue.' }]);
  assert.deepEqual(receivedRequest(user(turnText({ id, content }))), { id, content });
  assert.deepEqual(receivedRequest(turnText({ id, content })), { id, content });
  assert.equal(receivedRequest(user('Make it blue')), undefined, 'typed input is not a voice request');
  assert.deepEqual(agy.wire({ id, content }), { userMessage: turnText({ id, content }) });
});

test("agy's log says where its server listens, which conversation its terminal shows, when a tool waits for approval, and when it exits", () => {
  assert.deepEqual(logEvent('I1119 02:17:30.441389      56 server.go:1328] Language server listening on random port at 52125 for HTTP'), { type: 'port', port: 52125 });
  assert.equal(logEvent('I1119 02:17:30.441184      56 server.go:1320] Language server listening on random port at 52124 for HTTPS (gRPC)'), undefined);
  assert.deepEqual(logEvent('I1119 02:34:12.182498    1097 conversation_manager.go:1082] Streaming conversation 72c20832-dcc4-4e3b-a32d-5541604c279c'), { type: 'conversation', id: '72c20832-dcc4-4e3b-a32d-5541604c279c' });
  assert.equal(logEvent('I1119 02:34:12.182417    1097 server.go:3537] GetConversationDetail: found conversation 72c20832-dcc4-4e3b-a32d-5541604c279c (active=true)'), undefined);
  assert.deepEqual(logEvent('I1119 02:32:32.084355    1095 tool_confirmation_manager.go:237] Surfacing tool confirmation: "ReadFile" at step 2'), { type: 'confirmation', tool: 'ReadFile', step: 2 });
  assert.deepEqual(logEvent('I1119 02:33:35.404302      77 input_loop.go:805] Responding to tool confirmation: convID=2627dd5a-ac0a-440a-a7d2-dd71bcfaafad, stepIdx=2, approved=false, sandboxOverride=false, scope=PERMISSION_SCOPE_U'),
    { type: 'confirmed', conversation: '2627dd5a-ac0a-440a-a7d2-dd71bcfaafad', step: 2, approved: false });
  assert.deepEqual(logEvent('I1119 02:33:38.422016       1 common.go:558] CLI program exited, shutting down'), { type: 'exit' });
  assert.deepEqual(logEvent('I1119 03:06:51.841652     103 experiment_manager.go:70] Experiments refreshed after login'), { type: 'settled' });
  assert.deepEqual(logEvent('I1119 03:06:51.841691     107 manager.go:1736] SetCycleMode called: auto'), { type: 'settled' });
});

test('the observer follows the conversation the first hook names: requests, replies, tools by their result, approvals and turn ends; history stays history', async t => {
  const dir = tmp(t), id = randomUUID(), file = path.join(dir, 'transcript_full.jsonl');
  const old = new Date(Date.now() - 3600_000);
  fs.writeFileSync(file, step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: user('An earlier question') }, old) + step(1, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'An earlier answer' }, old));
  const observer = new AgyObserver({ home: dir }), emitted: string[] = [], sessions: string[] = [];
  observer.opening = GREETING;
  observer.on('observation', observation => emitted.push(observation.name)); observer.on('session', id => sessions.push(id));
  t.after(() => observer.close());
  const hook = (event: Record<string, unknown>) => observer.hook({ conversationId: id, transcriptPath: file, workspacePaths: [dir], cwd: dir, ...event });
  assert.equal(hook({ hookEventName: 'SessionStart' }), true);
  assert.deepEqual(sessions, [id]);
  assert.deepEqual(observer.conversation, [{ role: 'input', text: 'An earlier question' }, { role: 'output', text: 'An earlier answer' }], 'what the transcript held seeds the conversation');
  assert.equal(emitted.length, 0, '…and is never news');
  hook({ hookEventName: 'PreInvocation', invocationNum: 0 });
  assert.equal(observer.state, 'working');
  const request = { id: randomUUID(), content: 'Open the report.' };
  fs.appendFileSync(file, step(2, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: user(GREETING) }));
  await until(() => emitted.includes('OPENING'), "fdc's greeting");
  assert.equal(observer.conversation.length, 2, "fdc's greeting is not the operator's words");
  emitted.length = 0;
  fs.appendFileSync(file, step(12, { source: 'SYSTEM_SDK', type: 'USER_INPUT', content: user(turnText(request)) })
    + step(3, { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] sender=system content=${WAKE}\n</SYSTEM_MESSAGE>` })
    + step(4, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: `${PLUGIN}_open-claude-in-chrome`, ToolName: 'tabs_create_mcp', Arguments: { url: 'http://127.0.0.1:8765/r.html' } } }] })
    + step(5, { source: 'MODEL', type: 'GENERIC', content: 'Created At: 2026-11-19T02:34:20-05:00\nCompleted At: 2026-11-19T02:34:20-05:00\nCreated tab. Tab ID: 77' })
    + step(6, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'The report is open.' }));
  await until(() => emitted.includes('PLANNER_RESPONSE'), 'the reply');
  assert.deepEqual(emitted, ['USER_INPUT', 'TOOL_RESULT', 'PLANNER_RESPONSE'], "fdc's own wake is not news; a reply that only calls tools is told by their results");
  assert.deepEqual(observer.agent.receivedRequest(observer.observations.find(o => o.name === 'USER_INPUT' && o.raw.source === 'SYSTEM_SDK')!.raw.text), request);
  const result = observer.observations.find(o => o.name === 'TOOL_RESULT')!;
  assert.deepEqual(observer.toolUse(result), { tool: `mcp__${PLUGIN}_open-claude-in-chrome__tabs_create_mcp`, input: { url: 'http://127.0.0.1:8765/r.html' }, response: 'Created tab. Tab ID: 77' }, 'an MCP call reaches the stage under the name Claude would give it, with its answer');
  assert.equal(agy.toolCall!('TOOL_RESULT', result.raw), `mcp__${PLUGIN}_open-claude-in-chrome__tabs_create_mcp`);
  // A tool waiting for approval (agy's log), then approved.
  fs.appendFileSync(file, step(7, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'rm -rf build' } }] }));
  await until(() => observer.calls.length === 1, 'the call announced');
  observer.logged({ type: 'confirmation', tool: 'RunCommand', step: 8 });
  assert.equal(observer.state, 'needs_attention');
  assert.deepEqual(observer.observations.at(-1)!.raw, { event: 'ToolConfirmation', tool: 'run_command', args: { CommandLine: 'rm -rf build' } });
  observer.logged({ type: 'confirmed', conversation: id, step: 8, approved: true });
  assert.equal(observer.state, 'working');
  fs.appendFileSync(file, step(8, { source: 'MODEL', type: 'GENERIC', status: 'ERROR', error: 'exit status 1', content: 'Encountered error in step execution: exit status 1' }));
  await until(() => observer.observations.at(-1)!.kind === 'tool_failure', 'the failed tool');
  // Another conversation's hook (a subagent, a side question) is refused.
  assert.equal(observer.hook({ hookEventName: 'PreInvocation', conversationId: randomUUID() }), false);
  hook({ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: false, error: '' });
  assert.deepEqual([observer.state, observer.running, observer.observations.at(-1)!.kind, observer.observations.at(-1)!.raw.background !== undefined], ['idle', false, 'turn_end', true]);
  hook({ hookEventName: 'Stop', terminationReason: 'ERROR', error: 'quota exceeded' });
  assert.deepEqual([observer.state, observer.observations.at(-1)!.kind], ['failed', 'turn_failed']);
  // The terminal switches conversation (/resume): fdc follows it.
  const next = randomUUID();
  observer.logged({ type: 'conversation', id: next });
  assert.deepEqual([observer.sessionId, sessions.at(-1)], [next, next]);
  assert.equal(observer.hook({ hookEventName: 'PreInvocation', conversationId: id }), false, 'the old conversation is no longer followed');
});

test('a fork starts at the end of the last finished reply', t => {
  const file = path.join(tmp(t), 't.jsonl');
  fs.writeFileSync(file, step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' }) + step(1, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Hello' })
    + step(2, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'work' }) + step(3, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'On it', tool_calls: [{ name: 'run_command', args: {} }] }));
  assert.equal(forkPoint(file), 1);
  fs.writeFileSync(file, step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' }));
  assert.throws(() => forkPoint(file), /nothing to fork/);
  assert.deepEqual(toolOf({ name: 'read_file', args: { Path: '/a' } }), { tool: 'read_file', args: { Path: '/a' } });
});

function delivery(t: TestContext) {
  const server = new AgyServer(), observer = new AgyObserver({ home: tmp(t) }), log: Record<string, unknown>[] = [], sent: [string, string][] = [];
  server.send = async (conversation, text) => { sent.push([conversation, text]); };
  const d = new AgyDelivery({ server, observer, log: event => log.push(event) });
  t.after(() => { d.close(); observer.close(); });
  return { d, server, observer, sent, log };
}

test('requests wait for the next model call while a turn runs; a conversation at rest is woken; a turn that ends with one waiting is woken after its Stop hook', async t => {
  const { d, server, observer, sent } = delivery(t), id = randomUUID();
  const request = { id: randomUUID(), content: 'Add a test.' };
  assert.equal((await d.deliver(request)).state, 'uncertain', 'nothing to reach before the server listens and a conversation is open');
  assert.equal(d.queue.length, 0);
  server.port = 1234; observer.adopt(id);
  assert.equal(d.ready, false, 'a turn woken before agy has settled runs without its hooks');
  // Opened with fdc's first message: its turn's first model call takes what waits, with no wake.
  d.opening = true;
  assert.equal(d.ready, true);
  const first = { id: randomUUID(), content: 'Start with the README.' };
  assert.deepEqual(await d.deliver(first), { state: 'sent' });
  assert.deepEqual(sent, []);
  assert.deepEqual(d.answer({ hookEventName: 'PreInvocation', invocationNum: 0 }), { injectSteps: [{ userMessage: turnText(first) }] });
  assert.equal(d.opening, false);
  server.settled = true;
  assert.equal(d.ready, true);
  // A running turn: the next model call takes it, as the operator's message.
  observer.running = true;
  assert.deepEqual(await d.deliver(request), { state: 'sent' });
  assert.deepEqual(sent, [], 'no wake while a turn runs');
  assert.deepEqual(d.answer({ hookEventName: 'PreInvocation', invocationNum: 3 }), { injectSteps: [{ userMessage: turnText(request) }] });
  assert.equal(d.answer({ hookEventName: 'PreInvocation', invocationNum: 4 }), undefined, 'taken once');
  // At rest: woken through the language server, then taken at the first model call.
  observer.running = false;
  const second = { id: randomUUID(), content: 'Now run it.' };
  assert.deepEqual(await d.deliver(second), { state: 'sent' });
  assert.deepEqual(sent, [[id, WAKE]]);
  assert.deepEqual(d.answer({ hookEventName: 'PreInvocation', invocationNum: 0 }), { injectSteps: [{ userMessage: turnText(second) }] });
  // A turn that ends with a request waiting is woken once its Stop hook is past.
  AgyDelivery.SETTLE_MS = 50;
  observer.running = true;
  const third = { id: randomUUID(), content: 'And commit.' };
  await d.deliver(third);
  observer.running = false; observer.stoppedAt = Date.now();
  assert.equal(d.answer({ hookEventName: 'Stop' }), undefined);
  assert.equal(sent.length, 1, 'not inside the Stop hook');
  await until(() => sent.length === 2, 'the wake after Stop');
  // A wake no model call answers (agy ran the turn without its hooks) is tried once more, then reported.
  d.answer({ hookEventName: 'PreInvocation', invocationNum: 0 });
  AgyDelivery.UNANSWERED_MS = 50;
  const faults: Error[] = []; d.on('fault', error => faults.push(error));
  const lost = { id: randomUUID(), content: 'Tag it.' };
  await d.deliver(lost);
  await until(() => sent.length === 4, 'woken again');
  await until(() => faults.length === 1, 'then reported');
  assert.match(faults[0].message, /are its hooks running/);
  // A wake agy refuses leaves nothing waiting, and says so.
  d.queue.length = 0;
  server.send = async () => { throw new Error('trajectory not found'); };
  const fourth = { id: randomUUID(), content: 'Push it.' };
  const result = await d.deliver(fourth);
  assert.equal(result.state, 'uncertain');
  assert.equal(d.queue.length, 0);
});

test("the launch: agy with fdc's plugin in the project's folder under the temporary one (hooks, never PreToolUse; fdc's instructions as rules), emptied as fdc stops; its log in the run; a greeting for a new conversation", async t => {
  const runDir = tmp(t), cwd = tmp(t), instructions = `fdc instructions ${randomUUID()}`;
  const folder = projectFolder(cwd);
  t.after(() => { for (const dir of [folder, ...extraFolders]) { try { fs.chmodSync(dir, 0o700); for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) fs.chmodSync(path.join(e.parentPath, e.name), 0o700); fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });
  const extraFolders: string[] = [];
  const create = (agentArgs: string[], extra: Record<string, unknown> = {}) => new AgyAdapter({ root, runDir, cwd, observation: '', agentArgs, instructions, clean: String, log: () => {}, ...extra });
  const adapter = create(['--model', 'gemini-3.8-flash-high']);
  const launch = await adapter.launch({ baseUrl: 'http://127.0.0.1:9', token: 'secret' });
  const plugin = adapter.plugin!;
  assert.deepEqual([plugin.workspace, plugin.shared], [folder, true], "the project's own folder, where a conversation made now finds it again when resumed");
  assert.ok(folder.startsWith(os.tmpdir()) && !folder.startsWith(cwd), 'outside the project, where it sorts after it');
  assert.deepEqual(launch.args, ['--add-dir', folder, '--log-file', path.join(runDir, 'agy.log'), '-i', GREETING, '--model', 'gemini-3.8-flash-high']);
  assert.deepEqual([adapter.delivery.opening, adapter.observations.opening], [true, GREETING], "its turn takes what waits, and is not the operator's");
  assert.equal(launch.command, 'agy');
  assert.equal(launch.env.FD_BRIDGE_TOKEN, 'secret');
  assert.match(launch.env.ANTIGRAVITY_SERVER_CSRF_TOKEN, /^[0-9a-f]{48}$/);
  const hooks = JSON.parse(fs.readFileSync(launch.files.hooks, 'utf8'))[PLUGIN];
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop']);
  assert.equal(hooks.PostToolUse[0].matcher, '*');
  assert.match(hooks.Stop[0].command, /hook-relay\.ts' 'http:\/\/127\.0\.0\.1:9\/hook'$/);
  const rules = fs.readFileSync(launch.files.rules, 'utf8');
  assert.ok(rules.startsWith(instructions) && rules.includes(`not part of the user's project, which is ${cwd}`));
  assert.throws(() => fs.writeFileSync(path.join(folder, 'note.txt'), 'x'), /EACCES/, 'read-only');
  // Another fdc already in the project keeps the folder: this session gets its own, removed as it stops.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']); t.after(() => other.kill());
  fs.chmodSync(folder, 0o700); fs.chmodSync(path.join(folder, '.owner'), 0o600); fs.writeFileSync(path.join(folder, '.owner'), String(other.pid));
  const second = create([]), secondLaunch = await second.launch({ baseUrl: 'http://127.0.0.1:10', token: 't' });
  extraFolders.push(second.plugin!.workspace);
  assert.equal(second.plugin!.shared, false);
  assert.equal(secondLaunch.args[1], second.plugin!.workspace);
  assert.match(JSON.parse(fs.readFileSync(launch.files.hooks, 'utf8'))[PLUGIN].Stop[0].command, /:9\/hook'$/, "the other session's hooks are left as they were");
  await second.close();
  assert.equal(fs.existsSync(second.plugin!.workspace), false);
  other.kill(); fs.writeFileSync(path.join(folder, '.owner'), String(process.pid)); fs.chmodSync(folder, 0o555);
  // As fdc stops: no hooks and no rules, so agy without fdc on a conversation made here runs none of it.
  await adapter.close();
  assert.deepEqual([fs.readFileSync(launch.files.hooks, 'utf8').trim(), fs.readFileSync(launch.files.rules, 'utf8')], ['{}', '']);
  // The next session rewrites it, with its own bridge.
  const next = create([]), nextLaunch = await next.launch({ baseUrl: 'http://127.0.0.1:11', token: 't' });
  assert.match(JSON.parse(fs.readFileSync(nextLaunch.files.hooks, 'utf8'))[PLUGIN].Stop[0].command, /:11\/hook'$/);
  await next.close();
  // A resumed conversation, or one the operator opens with their own first message: no greeting; their own log is followed.
  for (const args of [['--conversation', randomUUID()], ['-c'], ['-i', 'Fix the build']]) {
    const resumed = create(args), launched = await resumed.launch({ baseUrl: 'http://127.0.0.1:9', token: 't' });
    assert.ok(!launched.args.includes(GREETING), args.join(' '));
    await resumed.close();
  }
  const logged = create(['--log-file', path.join(runDir, 'mine.log')]), launched = await logged.launch({ baseUrl: 'http://127.0.0.1:9', token: 't' });
  assert.equal(launched.args.filter(arg => arg === '--log-file').length, 1);
  await logged.close();
  // A fork is made by the session it forks, and has no plugin of its own (it runs that session's).
  const fork = create([], { prefix: '/fork/2', forkOf: randomUUID() });
  await assert.rejects(fork.launch({ baseUrl: 'http://127.0.0.1:9', token: 't' }), /can't be reached to fork it/);
  assert.equal(fork.plugin, undefined);
  await fork.close();
});

test('through the bridge: agy\'s log and first hook connect it; a request sent mid-turn comes back as the answer to its next model call\'s hook, and is observed as the operator\'s message', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-agy-')), runDir = path.join(dir, 'run'), transcript = path.join(dir, 'transcript_full.jsonl');
  const harness = await new Harness({ agent: agy, root, runDir, cwd: dir, apiKey: 'unused-test-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const conversation = randomUUID();
  const relay = async (event: Record<string, unknown>) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/core/hook-relay.ts', import.meta.url)), `${harness.baseUrl}/hook`], { env: { ...process.env, FD_BRIDGE_TOKEN: harness.agentToken }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    const done = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ conversationId: conversation, transcriptPath: transcript, workspacePaths: [dir], cwd: dir, ...event }));
    await done; return JSON.parse(stdout);
  };
  fs.appendFileSync(path.join(runDir, 'agy.log'), 'I1119 02:17:30.441389      56 server.go:1328] Language server listening on random port at 4321 for HTTP\nI1119 02:17:31.841652     103 experiment_manager.go:70] Experiments refreshed after login\n');
  await until(() => (harness.adapter as AgyAdapter).server.port === 4321, 'the port from the log');
  assert.deepEqual(await relay({ hookEventName: 'SessionStart' }), {});
  await until(() => harness.agentReady, 'connected');
  assert.equal(harness.sessionId, conversation);
  assert.deepEqual(await relay({ hookEventName: 'PreInvocation', invocationNum: 0 }), {}, 'nothing waits yet');
  const request = { id: randomUUID(), content: voiceRequest([{ role: 'operator', text: 'Add a dark mode.' }]) };
  harness.deliver(request);
  const entry = harness.outbox.get(request.id)!;
  await until(() => entry.state === 'sent', 'sent');
  assert.deepEqual(await relay({ hookEventName: 'PreInvocation', invocationNum: 1 }), { injectSteps: [{ userMessage: turnText(request) }] });
  assert.deepEqual(await relay({ hookEventName: 'PreInvocation', invocationNum: 2 }), {}, 'once');
  fs.appendFileSync(transcript, step(0, { source: 'SYSTEM_SDK', type: 'USER_INPUT', content: user(turnText(request)) }));
  await until(() => harness.timeline.requests.get(request.id)?.state === 'observed', 'the request observed');
  assert.equal(harness.timeline.requests.get(request.id)!.contentMatches, true);
  assert.deepEqual(await relay({ hookEventName: 'PreInvocation', conversationId: randomUUID() }), {}, "another conversation's hook gets nothing");
  // A fork keeps the workspace of the conversation it forks, so its hooks come on the main session's route: its own adapter answers them.
  const fork = agy.create({ root, runDir: path.join(runDir, 'fork-1'), cwd: dir, observation: '', agentArgs: [], instructions: 'i', clean: String, log: () => {} }) as AgyAdapter;
  t.after(() => fork.close());
  const forked = randomUUID(), aside = { id: randomUUID(), content: 'What is in the README?' };
  fork.observations.adopt(forked, path.join(dir, 'fork-transcript.jsonl'));
  fork.delivery.queue.push(aside);
  harness.forks.adapter = fork;
  assert.deepEqual(await relay({ hookEventName: 'PreInvocation', conversationId: forked, invocationNum: 0 }), { injectSteps: [{ userMessage: turnText(aside) }] });
  assert.equal(fork.observations.state, 'working');
  assert.equal(harness.observer.state === 'working' && harness.sessionId, conversation, 'the main session is untouched');
  harness.forks.adapter = undefined;
});
