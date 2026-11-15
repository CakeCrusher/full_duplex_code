// Forks: a tangent the operator starts goes to a fork of the agent's session, in a terminal window of its own, and back
// to the main session once settled; delegation, hooks and the channel follow the session in focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { forkArgs } from '../src/adapters/claude/arguments.ts';
import { piForkArgs } from '../src/adapters/pi/arguments.ts';
import { pi } from '../src/adapters/pi/index.ts';
import { openWindow, writeScript } from '../src/core/window.ts';
import { Jev } from '../src/core/jev.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { codex } from '../src/adapters/codex/index.ts';
import { perceivedText } from '../src/core/perceived.ts';
import { routeActions } from '../src/core/turn.ts';
import { fakeJev, harness, page, until } from './live-fake.ts';

const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
// The hook command Claude runs for each event: what it complains about, if anything.
const relay = (url: string, token: string, event: Record<string, unknown>) => new Promise<string>(resolve => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/core/hook-relay.ts', import.meta.url)), url], { env: { ...process.env, FD_BRIDGE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  let complaint = ''; child.stderr.on('data', chunk => complaint += chunk);
  child.on('close', () => resolve(complaint));
  child.stdin.end(JSON.stringify(event));
});

test("a fork keeps the operator's options for how Claude works, not their choice of session or first prompt", () => {
  assert.deepEqual(forkArgs(['--dangerously-skip-permissions', '--resume', 'main', '--model', 'opus', '--add-dir', 'a', 'b', '-c', '--name', 'x', 'Explain this']),
    ['--dangerously-skip-permissions', '--model', 'opus', '--add-dir', 'a', 'b']);
  assert.deepEqual(forkArgs(['--resume=abc', '--fork-session', '--permission-mode', 'acceptEdits', '--session-id', 'u']), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(forkArgs(['--debug-file', '/run/debug.log', '--model', 'opus'], '/run/fork-1'), ['--debug-file', '/run/fork-1/debug.log', '--model', 'opus'], 'the fork logs to a file of its own');
});

test("a Pi fork: Pi's own --fork of the session, its extension on the fork's routes, with the operator's options but not their choice of session", async () => {
  assert.deepEqual(piForkArgs(['--model', 'x', '-c', '--session', 'abc', '--thinking', 'high', 'hello']), ['--model', 'x', '--thinking', 'high']);
  const adapter = pi.create({ root: '/r', runDir: '/tmp', cwd: '/tmp', observation: 'events', agentArgs: ['-c', '--model', 'x'], instructions: 'fdc', clean: String, log: () => {}, forkOf: 'abcd1234', prefix: '/fork' });
  const launch = await adapter.launch({ baseUrl: 'http://127.0.0.1:1', token: 't' });
  assert.deepEqual(launch.args.slice(2), ['--model', 'x', '--fork', 'abcd1234']);
  assert.equal(launch.env.FD_BRIDGE_PREFIX, '/fork');
  assert.ok(Object.hasOwn(adapter.sockets, '/fork/pi'));
  adapter.close();
});

test("the fork's window runs the agent by its full path, in the project, with fdc's variables; the operator's terminal app opens it", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fd-window-')), file = path.join(dir, 'fork.command');
  writeScript(file, { command: 'node', args: ['--version', "it's"], env: { FD_BRIDGE_TOKEN: 'secret' } }, '/tmp/my project');
  const script = fs.readFileSync(file, 'utf8');
  assert.match(script, /^#!\/bin\/sh\ncd '\/tmp\/my project' \|\| exit 1\nexport PATH=/);
  assert.match(script, /export FD_BRIDGE_TOKEN='secret'\nexec '\/[^']+\/node' '--version' 'it'\\''s'\n$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o700, 'owner-only: it holds the bridge token');
  const ran: string[][] = [], run = (command: string, args: string[]) => { ran.push([command, ...args]); return { status: 0 }; };
  if (process.platform === 'darwin') {
    assert.equal(openWindow(file, { TERM_PROGRAM: 'iTerm.app' }, run), 'iTerm');
    assert.equal(openWindow(file, { TERM_PROGRAM: 'vscode' }, run), 'Terminal', "an editor's terminal can't open a window: Terminal does");
    assert.deepEqual(ran[1], ['open', '-a', 'Terminal', file]);
    assert.throws(() => openWindow(file, {}, () => ({ status: 1, stderr: 'no such app' })), /Terminal did not open a window: no such app/);
  }
});

test('with forks on, the voice tool asks whether a tangent starts while the main session is in focus, and whether it is settled while a fork is', async () => {
  const bodies: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url: string, init: any) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { standby: { noul: .1 }, tangent: { noul: .9 }, settled: { noul: .2 } } }) }; } } as any);
  const main = await jev.read({ trigger: 'turn', latest: { role: 'operator', text: 'By the way, can you check why the build is slow?' }, fork: 'main' });
  assert.ok('tangent' in bodies[0].questions && !('settled' in bodies[0].questions));
  assert.equal(main.tangent, .9);
  await jev.read({ trigger: 'turn', latest: { role: 'operator', text: 'Okay, back to the chart.' }, fork: 'fork' });
  assert.ok('settled' in bodies[1].questions && !('tangent' in bodies[1].questions));
  await jev.read({ trigger: 'turn', latest: { role: 'operator', text: 'Okay.' } });
  assert.ok(!('tangent' in bodies[2].questions) && !('settled' in bodies[2].questions), 'without forks, neither');
});

test("a tangent opens a fork in a window of its own: Claude's fork of the session, with its hooks and channel on the fork's routes; requests and the voice follow the focus, and back again once settled", async t => {
  const { h, lives, sessionId } = await harness(t, { features: ['instructions'] });
  const scripts: string[] = []; h.forks.open = script => { scripts.push(script); return 'Terminal'; };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  const delivered: { at: string; id: string }[] = [];
  // The main session's channel, connected and ready.
  const connect = async (route: string, at: string) => {
    const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + route, { headers: { Authorization: `Bearer ${h.agentToken}` } });
    t.after(() => ws.terminate());
    await new Promise(resolve => ws.on('open', resolve));
    ws.on('message', raw => { const event = JSON.parse(raw.toString()); if (event.type === 'channel.deliver') { delivered.push({ at, id: event.id }); ws.send(JSON.stringify({ type: 'channel.sent', id: event.id })); } });
    ws.send(JSON.stringify({ type: 'channel.ready' })); await settle();
    return ws;
  };
  await connect('/channel', 'main');
  // The operator starts a tangent: the fork opens, continuing the main session.
  const told = await h.forks.start('By the way, can you check why the build is slow?');
  assert.match(told!, /goes to a fork of Claude Code's session, opening in a new Terminal window/);
  assert.equal(h.forks.focus, 'fork');
  const script = fs.readFileSync(scripts[0], 'utf8');
  assert.match(script, new RegExp(`'--resume' '${sessionId}' '--fork-session'`));
  const dir = path.dirname(scripts[0]), settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), mcp = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
  assert.ok(settings.hooks.Stop[0].hooks[0].args.at(-1).endsWith('/fork/hook'), "the fork's hooks have a route of their own");
  assert.ok(mcp.mcpServers.voice.env.FD_BRIDGE_URL.endsWith('/fork/channel'));
  assert.match(mcp.mcpServers.voice.env.FD_INSTRUCTIONS, /This session is a fork of the operator's main Claude session/);
  assert.equal(mediator.observer, h.forks.adapter!.observations, 'the voice hears the fork');
  // A request now goes to the fork: it waits until the fork's channel is up.
  h.deliver({ id: 'tangent', content: 'Check why the build is slow.', voiceSessionId: lives[0].id, said: 'Check why the build is slow.' });
  await settle();
  assert.deepEqual([h.outbox.get('tangent')!.target, h.outbox.get('tangent')!.state, delivered.length], ['fork', 'queued', 0]);
  await connect('/fork/channel', 'fork');
  await until(() => delivered.length === 1);
  assert.deepEqual(delivered[0], { at: 'fork', id: 'tangent' });
  assert.ok(lives[0].appended.some(([, text]) => text === 'The operator\'s words went to the fork of Claude Code\'s session: "Check why the build is slow."'));
  // The fork's hooks reach the fork's observer; the main session's work doesn't reach the voice meanwhile.
  const post = (route: string, event: Record<string, unknown>) => fetch(h.baseUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${h.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal(await relay(h.baseUrl + '/fork/hook', h.agentToken, { session_id: 'fork-session', hook_event_name: 'SessionStart' }), '', "Claude's hook command takes the fork's route");
  assert.equal((h.forks.adapter!.observations as any).sessionId, 'fork-session');
  const fed: string[] = [], add = mediator.feed.add.bind(mediator.feed);
  mediator.feed.add = ((observation: any) => { fed.push(observation.text); return add(observation); }) as typeof mediator.feed.add;
  assert.equal((await post('/hook', { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'main work' } })).status, 200);
  assert.equal((await post('/fork/hook', { session_id: 'fork-session', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'time npm run build' }, tool_response: { stdout: 'fork work' } })).status, 200);
  assert.equal(fed.length, 1, "the main session's work weighs nothing for the voice while the fork is in focus");
  assert.match(fed[0], /fork work/);
  // Settled: back to the main session.
  assert.match(h.forks.back('the tangent is settled')!, /^<fork ended> Back to the main session of Claude Code \(the tangent is settled\)/);
  assert.equal(mediator.observer, h.observer);
  h.deliver({ id: 'main-again', content: 'Now add the legend.', voiceSessionId: lives[0].id, said: 'Now add the legend.' });
  await until(() => delivered.length === 2);
  assert.deepEqual(delivered[1], { at: 'main', id: 'main-again' });
});

test("the voice tool's reading opens the fork before the turn's words are sent, so they go to it; an agent that can't fork never forks", async t => {
  const { h } = await harness(t, { features: ['instructions'] });
  const opened: string[] = []; h.forks.open = script => { opened.push(script); return 'Terminal'; };
  fakeJev(h, moment => moment.fork === 'main' ? { tangent: .9 } : {});
  const request = { utterances: [], through: 0, seqs: [0], fresh: 'Unrelated, but look into the flaky test.' };
  const actions = await routeActions(h, request, [{ role: 'operator', text: request.fresh, at: Date.now() }], 'turn');
  assert.equal(opened.length, 1);
  assert.match(actions.told!, /goes to a fork of Claude Code's session/);
  assert.equal(h.forks.focus, 'fork');
  const { h: other } = await harness(t, { agent: codex });
  const none: string[] = []; other.forks.open = script => { none.push(script); return 'Terminal'; };
  fakeJev(other, () => ({ tangent: .9 }));
  await routeActions(other, request, [{ role: 'operator', text: request.fresh, at: Date.now() }], 'turn');
  assert.equal(none.length, 0, 'Codex has no fork yet');
});

test('one record: the fork tags are in what the voice is given and Jev reads, and each session gets the record since its own last request', async t => {
  const { h } = await harness(t, { features: ['instructions'] });
  h.forks.open = () => 'Terminal';
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!, sent: { id: string; content: string; to: string }[] = [];
  h.deliver = ((request: any) => { sent.push({ id: request.id, content: request.content, to: h.forks.focus }); mediator.delivered(request.id); }) as any;
  let ms = 0;
  const say = async (role: 'operator' | 'intermediary', text: string) => { await settle(5); mediator.history.add({ type: role === 'operator' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta: text, start_ms: ms, end_ms: ms += 1000 }); ms += 3000; await settle(5); };
  await say('operator', 'Build the chart.'); mediator.send('r1', [], null);
  await say('intermediary', 'On it.'); await say('operator', 'By the way, why is the build slow?');
  await h.forks.start('By the way, why is the build slow?'); await settle(5);
  mediator.send('r2', [], null);
  await say('intermediary', 'Checking.'); await say('operator', 'Okay, that answers it. Back to the chart: add a legend.');
  h.forks.back('the tangent is settled'); await settle(5);
  mediator.send('r3', [], null);
  const [r1, r2, r3] = sent, lines = (c: string) => c.split('\n\n').slice(1).join('\n\n');
  assert.deepEqual(sent.map(s => s.to), ['main', 'fork', 'main']);
  assert.match(lines(r1.content), /user: Build the chart\./);
  assert.doesNotMatch(lines(r2.content), /Build the chart/, "the fork starts from the main session's place");
  assert.match(lines(r2.content), /user: By the way, why is the build slow\?[\s\S]*<fork started>/);
  for (const text of ['voice assistant: On it.', '<fork started>', 'By the way, why is the build slow?', 'voice assistant: Checking.', '<fork ended>', 'Back to the chart: add a legend.'])
    assert.ok(lines(r3.content).includes(text), `the main session catches up: ${text}`);
  assert.doesNotMatch(r3.content, /Full-Duplex|startup/i, "not the voice's startup input");
  // Jev reads the same record, tags included.
  const record = h.voiceSessions.run!.record;
  assert.match(perceivedText(record, mediator.history.spoken(), Date.now(), 14000), /<fork started>[\s\S]*<fork ended>/);
});
