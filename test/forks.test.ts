// Forks: while the main session works, a question the operator turns aside to ask goes to a fork of the agent's session,
// in a terminal window of its own, and back to the main session after it; delegation, hooks and the channel follow the
// session in focus, and the fork is left behind on the way back.
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
import { fakeJev, harness, page, turn, until } from './live-fake.ts';

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
  const adapter = pi.create({ root: '/r', runDir: '/tmp', cwd: '/tmp', observation: 'events', agentArgs: ['-c', '--model', 'x'], instructions: 'fdc', clean: String, log: () => {}, forkOf: 'abcd1234', prefix: '/fork/1' });
  const launch = await adapter.launch({ baseUrl: 'http://127.0.0.1:1', token: 't' });
  assert.deepEqual(launch.args.slice(2), ['--model', 'x', '--fork', 'abcd1234']);
  assert.equal(launch.env.FD_BRIDGE_PREFIX, '/fork/1');
  assert.ok(Object.hasOwn(adapter.sockets, '/fork/1/pi'));
  adapter.close();
});

test("the fork's window runs the agent by its full path, in the project, with fdc's variables; the operator's terminal app opens it", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fd-window-')), file = path.join(dir, 'fork.command');
  writeScript(file, { command: 'node', args: ['--version', "it's"], env: { FD_BRIDGE_TOKEN: 'secret' } }, '/tmp/my project');
  const script = fs.readFileSync(file, 'utf8');
  assert.match(script, /^#!\/bin\/sh\ncd '\/tmp\/my project' \|\| exit 1\nexport PATH=/);
  assert.match(script, /export FD_BRIDGE_TOKEN='secret'\nexec '\/[^']+\/node' '--version' 'it'\\''s'\n$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o700, 'owner-only: it holds the bridge token');
  // An agent that waits for Enter on a prompt as it starts: in a window the operator is not at, fdc answers it.
  const asking = path.join(dir, 'asking.command'), expect = path.join(dir, 'expect'); fs.writeFileSync(expect, '');
  writeScript(asking, { command: 'node', args: ['--resume', 'a b'], env: {}, confirm: 'I am using this for local development' }, '/tmp/my project', process.env, expect);
  assert.match(fs.readFileSync(asking, 'utf8'), new RegExp(`\\nexec '${expect}' '-f' '${asking}\\.exp' '--' 'I am using this for local development' '/[^']+/node' '--resume' 'a b'\\n$`), "the agent runs under expect, the prompt's words first");
  const program = fs.readFileSync(`${asking}.exp`, 'utf8');
  assert.match(program, /interact \{\n  -o -nobuffer -re \$pattern \{ if \{\$answered < 3 && \[clock seconds\] - \$started < 90\} \{ incr answered; after 400; send "\\r" \} \}/, 'Enter once the words appear, early on only; the rest passes through');
  assert.match(program, /trap \{[^}]*stty rows/, "and the agent's terminal keeps the window's size");
  writeScript(asking, { command: 'node', args: [], env: {}, confirm: 'I am using this for local development' }, '/tmp/my project', process.env, path.join(dir, 'no-expect-here'));
  assert.match(fs.readFileSync(asking, 'utf8'), /\nexec '\/[^']+\/node'\n$/, 'without expect the agent runs as before, and the operator answers');
  const ran: string[][] = [], run = (command: string, args: string[]) => { ran.push([command, ...args]); return { status: 0 }; };
  if (process.platform === 'darwin') {
    assert.equal(openWindow(file, { TERM_PROGRAM: 'iTerm.app' }, run), 'iTerm');
    assert.equal(openWindow(file, { TERM_PROGRAM: 'vscode' }, run), 'Terminal', "an editor's terminal can't open a window: Terminal does");
    assert.deepEqual(ran[1], ['open', '-a', 'Terminal', file]);
    assert.throws(() => openWindow(file, {}, () => ({ status: 1, stderr: 'no such app' })), /Terminal did not open a window: no such app/);
  }
});

test('Jev is asked whether the words are a question asked aside where they are sent from the main session, and, with a fork in focus, also whether the operator has left its matter', async () => {
  const bodies: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url: string, init: any) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { standby: { noul: .1 }, needs_agent: { noul: .9 }, tangent: { noul: .9 }, settled: { noul: .2 } } }) }; } } as any);
  const asked = () => Object.keys(bodies.at(-1).questions).filter(name => name === 'tangent' || name === 'settled');
  const latest = { role: 'operator' as const, text: 'By the way, what does CNS mean?' };
  // The main session in focus and at work: asked by the reading that sends the words.
  assert.equal((await jev.read({ trigger: 'job', latest, working: 5000, fork: 'main' })).tangent, .9);
  assert.deepEqual(asked(), ['tangent'], "the job delegation's reading");
  await jev.read({ trigger: 'turn', latest, fork: 'main' });
  assert.deepEqual(asked(), [], "not at the turn's end: nothing is sent by that reading");
  // A fork in focus: every reading of the turn.
  const inFork = await jev.read({ trigger: 'turn', latest: { role: 'operator', text: 'Okay, got it.' }, fork: 'fork' });
  assert.deepEqual(asked(), ['settled', 'tangent']);
  assert.deepEqual([inFork.settled, inFork.tangent], [.2, .9]);
  await jev.read({ trigger: 'job', latest, fork: 'fork' });
  assert.deepEqual(asked(), ['tangent']);
  await jev.read({ trigger: 'job', latest });
  assert.deepEqual(asked(), [], 'no fork can open (the agent is between turns, or can\'t fork): neither');
});

test("a fork opens in a window of its own: Claude's fork of the session, with its hooks and channel on routes of its own; requests and the voice follow the focus; on the way back the fork is left behind", async t => {
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
  // The operator turns aside to ask something: the fork opens, continuing the main session.
  const told = await h.forks.start('By the way, can you check why the build is slow?');
  assert.match(told!, /goes to a fork of Claude Code's session, opening in a new Terminal window/);
  assert.equal(h.forks.focus, 'fork');
  const script = fs.readFileSync(scripts[0], 'utf8');
  assert.match(script, new RegExp(`'--resume' '${sessionId}' '--fork-session'`));
  const dir = path.dirname(scripts[0]), settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), mcp = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
  assert.ok(settings.hooks.Stop[0].hooks[0].args.at(-1).endsWith('/fork/1/hook'), "the fork's hooks have a route of their own");
  assert.ok(mcp.mcpServers.voice.env.FD_BRIDGE_URL.endsWith('/fork/1/channel'));
  assert.match(mcp.mcpServers.voice.env.FD_INSTRUCTIONS, /This session is a fork of the operator's main Claude session/);
  assert.equal(mediator.observer, h.forks.adapter!.observations, 'the voice hears the fork');
  // A request now goes to the fork: it waits until the fork's channel is up.
  h.deliver({ id: 'tangent', content: 'Check why the build is slow.', voiceSessionId: lives[0].id, said: 'Check why the build is slow.' });
  await settle();
  assert.deepEqual([h.outbox.get('tangent')!.target, h.outbox.get('tangent')!.state, delivered.length], ['fork', 'queued', 0]);
  assert.equal(h.forks.busy, true, "the fork's answer is on the way");
  const forkChannel = await connect('/fork/1/channel', 'fork');
  await until(() => delivered.length === 1);
  assert.deepEqual(delivered[0], { at: 'fork', id: 'tangent' });
  assert.ok(lives[0].appended.some(([, text]) => text === 'The operator\'s words went to the fork of Claude Code\'s session: "Check why the build is slow."'));
  // The fork's hooks reach the fork's observer; the main session's work doesn't reach the voice meanwhile.
  const post = (route: string, event: Record<string, unknown>) => fetch(h.baseUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${h.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal(await relay(h.baseUrl + '/fork/1/hook', h.agentToken, { session_id: 'fork-session', hook_event_name: 'SessionStart' }), '', "Claude's hook command takes the fork's route");
  assert.equal((h.forks.adapter!.observations as any).sessionId, 'fork-session');
  const fed: string[] = [], add = mediator.feed.add.bind(mediator.feed);
  mediator.feed.add = ((observation: any) => { fed.push(observation.text); return add(observation); }) as typeof mediator.feed.add;
  assert.equal((await post('/hook', { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'main work' } })).status, 200);
  assert.equal((await post('/fork/1/hook', { session_id: 'fork-session', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'time npm run build' }, tool_response: { stdout: 'fork work' } })).status, 200);
  assert.equal(fed.length, 1, "the main session's work weighs nothing for the voice while the fork is in focus");
  assert.match(fed[0], /fork work/);
  // Its turn ends: it has answered.
  await post('/fork/1/hook', { session_id: 'fork-session', hook_event_name: 'UserPromptSubmit', prompt: 'Check why the build is slow.' });
  await post('/fork/1/hook', { session_id: 'fork-session', hook_event_name: 'Stop' });
  await until(() => !h.forks.busy);
  // Back to the main session: the fork is left behind, and what it does reaches fdc no more.
  assert.match(h.forks.back('the operator moved on')!, /^<fork ended> Back to the main session of Claude Code \(the operator moved on\)/);
  assert.equal(mediator.observer, h.observer);
  assert.equal(h.forks.adapter, undefined, 'fdc follows the fork no more');
  assert.equal((await post('/fork/1/hook', { session_id: 'fork-session', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'late' } })).status, 409);
  h.deliver({ id: 'main-again', content: 'Now add the legend.', voiceSessionId: lives[0].id, said: 'Now add the legend.' });
  await until(() => delivered.length === 2);
  assert.deepEqual(delivered[1], { at: 'main', id: 'main-again' });
  // The next question aside opens a new fork, on a route of its own: the one left behind, its window still open, can't take its place.
  await h.forks.start('And what does CNS mean?');
  assert.equal(h.forks.route, '/fork/2');
  assert.equal(scripts.length, 2);
  await new Promise<void>(resolve => { const stale = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/fork/1/channel', { headers: { Authorization: `Bearer ${h.agentToken}` } }); stale.on('error', () => resolve()); stale.on('open', () => { stale.terminate(); assert.fail("the first fork's channel was taken again"); }); });
  // A request the fork hasn't taken when the focus moves back goes to the main session, cut from its own place in the record: never nowhere.
  mediator.history.add({ type: 'session.input_transcript.delta', delta: 'And what does CNS mean?', start_ms: 0, end_ms: 1000 });
  await settle();
  mediator.send('unanswered', [], null);
  await settle();
  assert.deepEqual([h.outbox.get('unanswered')!.target, h.outbox.get('unanswered')!.state], ['fork', 'queued']);
  assert.equal(h.forks.busy, true);
  h.forks.back('the fork did not start');
  await until(() => delivered.length === 3);
  assert.equal(delivered[2].at, 'main');
  assert.equal(h.outbox.get('unanswered')!.state, 'uncertain');
  const again = [...h.outbox.values()].at(-1)!;
  assert.equal(again.target, 'main');
  assert.match(again.content, /<fork started>[\s\S]*user: And what does CNS mean\?[\s\S]*<fork ended> Back to the main session of Claude Code \(the fork did not start\)/);
  forkChannel.terminate();
});

test('while the main session works, a question that is sent opens a fork and goes to it; nothing sent, a main session between turns, or an agent that can\'t fork: no fork', async t => {
  const { h } = await harness(t, { features: ['instructions'] });
  const opened: string[] = []; h.forks.open = script => { opened.push(script); return 'Terminal'; };
  const sent: string[] = []; h.deliver = ((request: any) => { sent.push(h.forks.focus); }) as any;
  const moments = fakeJev(h, moment => ({ tangent: .9, needsAgent: moment.latest?.text.includes('CNS') ? .9 : .1, ready: .9 }));
  // The main session between turns: the question goes to it, and Jev isn't asked.
  let decision = await turn(h, 'What does CNS mean?');
  assert.deepEqual([decision.send, opened.length, moments.some(m => m.fork)], [true, 0, false]);
  // At work, words that stay with the voice: no fork, whatever they read as.
  h.workingSince = Date.now();
  decision = await turn(h, 'Mm, interesting.');
  assert.deepEqual([decision.send, opened.length, h.forks.focus], [false, 0, 'main']);
  // At work, a question that is sent: the fork opens as it goes, and the voice is told.
  decision = await turn(h, 'By the way, what does CNS mean?');
  assert.deepEqual([decision.send, decision.later, opened.length, h.forks.focus], [true, false, 1, 'fork']);
  assert.match(decision.told!, /^<fork started> The operator turned aside to ask something: it goes to a fork of Claude Code's session/);
  // The voice tool's own reading opens nothing, whichever signal ended the turn: a fork opens as words are sent.
  const { h: asked } = await harness(t, { features: ['instructions'] });
  const windows: string[] = []; asked.forks.open = script => { windows.push(script); return 'Terminal'; };
  fakeJev(asked, () => ({ tangent: .9 })); asked.workingSince = Date.now();
  const request = { utterances: [], through: 0, seqs: [0], fresh: 'What does CNS mean?' }, spoken = [{ role: 'operator' as const, text: request.fresh, at: Date.now() }];
  assert.equal((await routeActions(asked, request, spoken)).told, undefined);
  assert.equal(windows.length, 0);
  const { h: other } = await harness(t, { agent: codex });
  const none: string[] = []; other.forks.open = script => { none.push(script); return 'Terminal'; };
  fakeJev(other, () => ({ tangent: .9, needsAgent: .9, ready: .9 })); other.workingSince = Date.now();
  await turn(other, 'By the way, what does CNS mean?');
  assert.equal(none.length, 0, 'Codex has no fork yet');
});

test('with a fork in focus, words that are no question move the focus back: once the operator has left its matter (not while its answer is on the way), or as they are sent; a question stays', async t => {
  const { h } = await harness(t, { features: ['instructions'] });
  h.forks.open = () => 'Terminal'; h.deliver = (() => {}) as any;
  let answers: Record<string, number> = {};
  fakeJev(h, () => ({ needsAgent: .1, ready: .9, ...answers }));
  h.workingSince = Date.now();
  const open = async () => { await h.forks.start('What does CNS mean?'); assert.equal(h.forks.focus, 'fork'); };
  await open();
  // Its answer is on the way: an "okay" answers the voice, and the fork keeps the focus.
  h.forks.asked = Date.now();
  answers = { settled: .9, tangent: .1 };
  await turn(h, 'Okay.');
  assert.equal(h.forks.focus, 'fork');
  // It has answered: a follow-up question stays, whatever it reads as on leaving; words that close the matter move back.
  h.forks.answered = Date.now() + 1;
  answers = { settled: .9, tangent: .9 };
  await turn(h, 'And why is it called that?');
  assert.equal(h.forks.focus, 'fork');
  answers = { settled: .9, tangent: .1 };
  const closing = await turn(h, 'Okay, got it.');
  assert.equal(h.forks.focus, 'main');
  assert.match(closing.told!, /^<fork ended> Back to the main session of Claude Code \(the operator moved on\)/);
  // Work said with a fork in focus goes to the main session, even while the fork's answer is on the way.
  await open(); h.forks.asked = Date.now() + 5;
  answers = { settled: .1, tangent: .1, needsAgent: .9 };
  const work = await turn(h, 'Add a legend to the chart.');
  assert.deepEqual([work.send, h.forks.focus], [true, 'main']);
  assert.match(work.told!, /Back to the main session of Claude Code \(work goes to the main session\)/);
  // Words that moved the focus back don't open a new fork in the same turn.
  await open(); h.forks.answered = Date.now() + 10;
  answers = { settled: .9, tangent: .2, needsAgent: .9 };
  const moments = fakeJev(h, moment => ({ needsAgent: .9, ready: .9, settled: .9, tangent: moment.trigger === 'job' ? .9 : .2 }));
  await turn(h, 'Thanks. What does the main session say?');
  assert.equal(h.forks.focus, 'main');
  assert.equal(moments.find(m => m.trigger === 'job')!.fork, undefined);
  // The conversation goes quiet (Standby begins): a fork that has answered gives the focus back, one still answering keeps it.
  await open(); h.forks.asked = Date.now() + 20;
  h.forks.quiet();
  assert.equal(h.forks.focus, 'fork');
  h.forks.answered = Date.now() + 30;
  h.forks.quiet();
  assert.equal(h.forks.focus, 'main');
  assert.match(h.forks.untold!, /the conversation went quiet/);
});

test('a fork takes only words Jev read; waiting work follows the same rules, and how sure Jev must be is a setting', async t => {
  const { h } = await harness(t, { features: ['instructions'] });
  const opened: string[] = []; h.forks.open = script => { opened.push(script); return 'Terminal'; }; h.deliver = (() => {}) as any;
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const history = h.voiceSessions.mediator!.history;
  h.workingSince = Date.now();
  // The operator goes on speaking while Jev reads the question: what they add is unread and would go with it, so no fork.
  let during = () => {};
  let answers: Record<string, number> = { tangent: .9, needsAgent: .9, ready: .9 };
  fakeJev(h, moment => { if (moment.trigger === 'job') during(); return answers; });
  during = () => history.add({ type: 'session.input_transcript.delta', delta: 'and also add a legend', start_ms: 0, end_ms: 900 });
  assert.equal((await turn(h, 'What does CNS mean?')).send, true);
  assert.deepEqual([opened.length, h.forks.focus], [0, 'main']);
  during = () => {};
  await turn(h, 'What does CNS mean?');
  assert.deepEqual([opened.length, h.forks.focus], [1, 'fork']);
  // With the fork in focus, work the operator hasn't finished saying moves back at once: it goes later without another reading.
  h.forks.asked = Date.now() + 5;
  answers = { tangent: .1, settled: .1, needsAgent: .9, ready: .05 };
  const waiting = await turn(h, 'Add a legend to the');
  assert.deepEqual([waiting.send, waiting.wait, h.forks.focus], [false, true, 'main']);
  // Words that are sent: a question opens a fork, and with a fork in focus anything else goes back.
  const sent = async (tangent: number) => { answers = { tangent, settled: .1, needsAgent: .9, ready: .9 }; return (await turn(h, 'What does CNS mean?')).told; };
  assert.match((await sent(.9))!, /goes to a fork/);
  assert.equal(await sent(.9), undefined, 'a question stays with the fork');
  assert.match((await sent(.2))!, /work goes to the main session/);
  assert.equal(await sent(.2), undefined, 'in the main session, words that are no question stay there');
  // How sure Jev must be is a setting (forkFrom, .55 unless set): the same reading opens a fork or not as it says, and
  // what opens a fork stays in one.
  h.setTuning({ ...h.tuning, forkFrom: .8 });
  assert.equal(await sent(.6), undefined, 'under the setting: no fork');
  h.setTuning({ ...h.tuning, forkFrom: .4 });
  assert.match((await sent(.45))!, /goes to a fork/);
  assert.equal(await sent(.45), undefined, 'it stays with the fork it opened');
  assert.match((await sent(.3))!, /work goes to the main session/);
  h.setTuning({ ...h.tuning, forkFrom: .55 });
  assert.match((await sent(.6))!, /goes to a fork/, 'the default');
});

test("the fork's answer is on the way until its turn ends: a permission prompt is no answer, and a fork that reports nothing for minutes no longer holds the focus", async t => {
  const { h } = await harness(t, { features: ['instructions'] });
  h.forks.open = () => 'Terminal';
  await h.forks.start('What does CNS mean?');
  const post = (event: Record<string, unknown>) => fetch(h.baseUrl + '/fork/1/hook', { method: 'POST', headers: { Authorization: `Bearer ${h.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'fork-session', ...event }) });
  await post({ hook_event_name: 'SessionStart' });
  h.forks.asked = Date.now();
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'What does CNS mean?' });
  await post({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  await settle(40);
  assert.equal(h.forks.busy, true, 'waiting for a permission is not an answer');
  h.forks.quiet();
  assert.equal(h.forks.focus, 'fork');
  await post({ hook_event_name: 'Stop' });
  await until(() => !h.forks.busy);
  // Asked again, and silent since: after the bound, the focus is free to go back.
  h.forks.asked = Date.now() + 1; h.forks.active = 0;
  assert.equal(h.forks.busy, true);
  h.forks.asked = Date.now() - 181000;  h.forks.answered = h.forks.asked - 1;
  assert.equal(h.forks.busy, false);
  h.forks.quiet();
  assert.equal(h.forks.focus, 'main');
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
  h.forks.back('the operator moved on'); await settle(5);
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
