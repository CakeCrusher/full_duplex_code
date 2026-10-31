// The stage: the page the agent showed, which the gate moves without the agent (stage.ts, sessions.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Stage, StageNothing, type StageView } from '../src/core/stage.ts';
import { chosenCommand, Jev, type Line } from '../src/core/jev.ts';
import { Mediator, type Decision } from '../src/core/mediator.ts';
import { handledNote } from '../src/core/prompts.ts';
import { decides, fakeJev, harness, pageReading, turn, until } from './live-fake.ts';

const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"',
  commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }, { id: 'show_the_recommendation', say: 'Show and highlight: the recommendation' }], parts: [] };
// A finished tool call, as every agent's observer reports it (AgentObserver.toolUse).
const posted = (tool: string, input: Record<string, unknown>, response: unknown = '') => ({ tool, input, response });

test('the stage script parses (it only ever runs inside a page)', () => {
  assert.doesNotThrow(() => new Function(fs.readFileSync(new URL('../src/core/stage-page.js', import.meta.url), 'utf8')));
});

test('the stage is the tab the agent last showed with the browser tools', () => {
  const stage = new Stage({ log: () => {} });
  stage.observe(posted('mcp__open-claude-in-chrome-hybrid__navigate', { url: 'http://localhost/a.html', tabId: 11 }));
  assert.equal(stage.tabId, 11);
  stage.observe(posted('mcp__open-claude-in-chrome-hybrid__tabs_create_mcp', {}, [{ type: 'text', text: 'Created new tab. Tab ID: 12' }]));
  assert.equal(stage.tabId, 12);
  stage.observe(posted('mcp__open-claude-in-chrome-hybrid__execute_code', { code: 'async () => { await chrome.navigate({ url: "x", tabId: 13 }); }' }));
  assert.equal(stage.tabId, 13);
  stage.observe(posted('mcp__open-claude-in-chrome-hybrid__javascript_tool', { tabId: 14, text: '1' }));
  stage.observe(posted('Read', { file_path: '/x' }));
  assert.equal(stage.tabId, 13, 'reading a page or a file does not change the stage');
});

test("every agent's finished tool calls name the tab it showed: Claude's and Codex's hooks as they are, Pi's start and end paired", async () => {
  const { PiObserver } = await import('../src/adapters/pi/observer.ts');
  const claude = new ClaudeObserver({ sessionId: 'c' });
  const seen: any[] = [];
  claude.on('observation', o => seen.push(claude.toolUse(o)));
  claude.hook({ session_id: 'c', hook_event_name: 'PostToolUse', tool_name: 'mcp__open-claude-in-chrome-hybrid__navigate', tool_input: { url: 'http://x/a.html', tabId: 21 }, tool_response: 'Navigated' });
  assert.deepEqual(seen.at(-1), { tool: 'mcp__open-claude-in-chrome-hybrid__navigate', input: { url: 'http://x/a.html', tabId: 21 }, response: 'Navigated' });
  claude.close();
  const pi = new PiObserver({ sessionId: 'p' }), stage = new Stage({ log: () => {} });
  pi.on('observation', o => stage.observe(pi.toolUse(o)));
  pi.observe({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'mcp__open-claude-in-chrome-hybrid__navigate', args: { url: 'http://x/deck.html', tabId: 33 } });
  assert.equal(stage.tabId, undefined, 'started, not finished');
  pi.observe({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'mcp__open-claude-in-chrome-hybrid__navigate', result: { content: [{ type: 'text', text: 'Navigated to http://x/deck.html.' }] }, isError: false });
  assert.equal(stage.tabId, 33, "a page Pi shows is on stage, as Claude's and Codex's are");
  pi.observe({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'mcp__open-claude-in-chrome-hybrid__tabs_create_mcp', args: {} });
  pi.observe({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'mcp__open-claude-in-chrome-hybrid__tabs_create_mcp', result: { content: [{ type: 'text', text: 'Created new tab. Tab ID: 34' }] }, isError: false });
  assert.equal(stage.tabId, 34);
});

test('a closed stage tab ends the stage', async () => {
  const stage = new Stage({ log: () => {}, browser: { evaluate: async () => { throw new Error('Tab 7 is not in the MCP group.'); }, close() {} } as any });
  stage.tabId = 7;
  await assert.rejects(stage.describe());
  assert.equal(stage.tabId, undefined);
});

test('the stage runs the script and its commands in the stage tab, in order', async () => {
  const calls: string[] = [];
  const browser = { evaluate: async (tabId: number, expression: string) => { calls.push(`${tabId}:${expression.slice(-480)}`); return expression.endsWith('window.__fdcStage.describe()') ? { ...view, tabId: undefined } : expression.includes('"next_section"') ? { said: ['one'], error: 'Already broken' } : expression.includes('"back"') ? { said: [], nothing: true } : { said: ['one', 'two'] }; }, close() {} } as any;
  const stage = new Stage({ log: () => {}, browser });
  assert.equal(await stage.describe(), undefined, 'no stage, no page');
  stage.tabId = 7;
  assert.deepEqual((await stage.describe())!.commands.map(c => c.id), ['next_section', 'goto_options', 'show_the_recommendation']);
  await stage.describe();
  assert.equal(calls.length, 1, 'a fresh description is reused');
  const ran = await stage.run(['goto_options', 'show_the_recommendation']);
  assert.match(calls[1], /for \(const \[i, id\] of \["goto_options","show_the_recommendation"\]\.entries\(\)\) \{ if \(i\) await new Promise/, 'in order, with a pause between steps');
  assert.deepEqual(ran, { done: [view.commands[1], view.commands[2]], onScreen: 'two' });
  await assert.rejects(stage.run(['goto_options', 'next_section']), (error: any) => error.message === 'Already broken' && error.done[0].id === 'goto_options' && error.failed.id === 'next_section' && error.onScreen === 'one', 'a step that throws stops the rest; what ran before it is reported');
  await assert.rejects(stage.run(['back']), (error: any) => error instanceof StageNothing && error.failed.id === 'back', 'nothing to do is not done');
});

test("Jev is asked which page command shows what the voice meant; unlikely or unknown picks run nothing, and the operator's own words get no page question", async () => {
  let answers: Record<string, unknown> = {}, sent: any;
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers }) }; } });
  const moment = { history: 'user: What are my choices?\n', latest: { role: 'intermediary', text: "Let's look at the choices you have." } as Line };
  const choice = (id: string, p = .95) => ({ choice: id, probabilities: { [id]: p } });
  answers = { page_command: choice('goto_options') };
  assert.deepEqual((await jev.read({ trigger: 'cue', ...moment, page: view })).page, { command: 'goto_options' });
  assert.match(sent.state.page, /Briefing .*The viewer is at: section "Intro"/);
  assert.deepEqual([sent.state.history, sent.state.latest], ['user: What are my choices?', "voice assistant: Let's look at the choices you have."], 'the voice\'s words, and what happened before them');
  assert.deepEqual(Object.keys(sent.questions), ['page_command']);
  assert.deepEqual(Object.keys(sent.questions.page_command.criteria), ['none', 'next_section', 'goto_options', 'show_the_recommendation']);
  answers = { page_command: choice('next_section', .35) };
  assert.equal((await jev.read({ trigger: 'cue', ...moment, page: view })).page!.command, undefined, 'unlikely: nothing runs');
  answers = { page_command: choice('made_up') };
  assert.equal((await jev.read({ trigger: 'cue', ...moment, page: view })).page!.command, undefined, 'not a command of the page');
  answers = { needs_agent: { noul: .9 } };
  for (const trigger of ['turn', 'delegation'] as const) {
    assert.equal((await jev.read({ trigger, latest: { role: 'operator', text: 'Go to the options.' }, page: view })).page, undefined, `${trigger}: no page question`);
    assert.equal(sent.questions.page_command, undefined);
  }
});

test("commands that do the same count as one choice, even below none: the page's own runs", () => {
  const deck: StageView = { ...view, commands: [{ id: 'back', say: 'Go back to wherever the viewer was' }, { id: 'next_section', say: 'Go to the next section' }, { id: 'page_back', say: 'Go back to the previous slide' }, { id: 'page_next', say: 'Go to the next slide' }] };
  const step = (probabilities: Record<string, number>) => ({ choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities });
  assert.equal(chosenCommand(step({ none: .3, back: .26, page_back: .25, next_section: .19 }), deck), 'page_back', "fdc's back and the page's back together beat none");
  assert.equal(chosenCommand(step({ none: .4, back: .26, page_back: .11, next_section: .23 }), deck), undefined, 'together still unlikely: nothing runs');
  assert.equal(chosenCommand(step({ next_section: .5, page_next: .1, none: .4 }), deck), 'next_section', "a unit's own step is not the page's next");
  const sections: StageView = { ...view, commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'page_next_section', say: 'Go to the next section' }, { id: 'page_section_3', say: 'Go to section 3', name: 'Confidence' }] };
  assert.equal(chosenCommand(step({ next_section: .42, page_next_section: .33, none: .1 }), sections), 'page_next_section', 'two that say the same are one choice');
});

test("the operator's turn never moves the page; with a page open, their words go to the agent noting what they were looking at", async t => {
  const { h } = await harness(t);
  const runs: string[][] = [];
  h.stage = { describe: async () => view, run: async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; }, view, observe() {}, close() {} } as any;
  fakeJev(h, moment => moment.trigger === 'job' ? { needsAgent: .9, ready: .9 } : { sessions: { asked: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0 });
  const passed = await turn(h, 'take me to the options and make this title bigger');
  assert.equal(passed.send, true);
  assert.match(passed.note!, /^When they said it, the user was looking at "Briefing" \(http:\/\/localhost\/b\.html\) in the browser, at: section "Intro"\.$/);
  assert.deepEqual(runs, [], 'the voice moves the page, with its own words');
});

test('the mediator tells GPT Live what the voice tool did and sends the harness the note with the words', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  const appends: [string, string, string | null][] = []; live.append = async (kind: string, content: string, delegationId: string | null) => { appends.push([kind, content, delegationId]); };
  const deliveries: any[] = [];
  const route = decides(async (): Promise<Decision> => ({ send: true, note: 'The voice tool already did the page part.', told: 'On screen now: Options.' }));
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, route });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Show me the options and fix the typo.', start_ms: 0, end_ms: 900 });
  m.decide('delegation', 'd1');
  await until(() => deliveries.length);
  assert.deepEqual(appends[0], ['thinking', 'On screen now: Options.', 'd1']);
  assert.match(deliveries[0].content, /Earlier speech went with earlier voice requests\. The voice tool already did the page part\.\n\nuser: Show me the options and fix the typo\.$/);
});

test("requests reach the agent in the order made, however long each one's reading takes", async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  live.append = async () => {};
  const deliveries: any[] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const route = decides(async ({ fresh }): Promise<Decision> => { started.push(fresh); if (/bigger/.test(fresh)) await slow; return { send: true }; });
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, route });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Go to the options and make its title bigger.', start_ms: 0, end_ms: 900 });
  m.decide('turn');
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Actually, make it smaller instead.', start_ms: 5000, end_ms: 6000 });
  m.decide('turn');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(deliveries.length, 0, 'the second waits for the first');
  assert.equal(started.length, 1, "the second's reading, which may move the page, starts after the first's");
  release();
  await until(() => deliveries.length === 2);
  assert.match(deliveries[0].content, /bigger/); assert.match(deliveries[1].content, /smaller/);
});

test("words whose turn fails aren't lost: they go with the next request", async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  live.append = async () => {};
  const faults: string[] = [];
  const m = new Mediator({ live, observer, deliver: () => {}, log: e => { if (e.type === 'bridge.fault') faults.push(String(e.message)); }, publish: () => {}, clean: String, hold: null, route: decides(async () => ({ send: true })) });
  t.after(() => { m.stop(); observer.close(); });
  m.decided = () => { throw new Error('boom'); };
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Fix the parser.', start_ms: 0, end_ms: 900 });
  m.decide('turn');
  await until(() => faults.length);
  assert.deepEqual(faults, ['boom']);
  assert.equal(m.history.request()?.fresh, 'Fix the parser.');
});

test('a page controller returning anything is kept to well-formed commands', async () => {
  const odd = { title: 7, url: 'http://localhost/x.html', about: { not: 'text' }, where: null, parts: [{ name: 'Intro', text: 7 }, 'x', { name: 'Fine', text: 'It says this.' }], commands: [{ id: 'slide_3', say: 'Go to slide 3', name: 3 }, { id: 4 }, null, 'x', { id: 'ok', say: 'Fine' }], cues: { say: 'next' } };
  const stage = new Stage({ log: () => {}, browser: { evaluate: async () => odd, close() {} } as any });
  stage.tabId = 1;
  const view = (await stage.describe(0))!;
  assert.deepEqual(view.commands, [{ id: 'slide_3', say: 'Go to slide 3', name: '3' }, { id: 'ok', say: 'Fine' }]);
  assert.equal(view.about, null); assert.equal(view.title, '7');
  assert.deepEqual(view.parts, [{ name: 'Intro', text: '7' }, { name: 'Fine', text: 'It says this.' }]);
});

test('the page on stage is remembered across restarts of fdc, and forgotten once its tab is gone', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-stage-')), 'stage', 'x.json');
  const first = new Stage({ log: () => {}, browser: { evaluate: async () => ({}), close() {} } as any, file });
  first.observe(posted('mcp__open-claude-in-chrome-hybrid__navigate', { url: 'http://localhost/deck.html', tabId: 41 }));
  const logged: any[] = [];
  const again = new Stage({ log: event => logged.push(event), browser: { evaluate: async () => { throw new Error('Tab 41 is not in the MCP group.'); }, close() {} } as any, file });
  assert.equal(again.tabId, 41, 'a restart picks the page up again');
  assert.equal(logged[0].type, 'stage.restored');
  await again.describe(0).catch(() => {});
  assert.equal(again.tabId, undefined, 'its tab closed meanwhile: no stage');
  assert.equal(new Stage({ log: () => {}, file }).tabId, undefined, 'and the next start knows it');
});

test('the other pages the agent showed are remembered too, for a week; on restart only those still open are offered', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-stage-')), 'stage', 'x.json');
  const read = (tabId: number) => ({ title: `Page ${tabId}`, url: `http://localhost/${tabId}.html`, about: null, where: 'top', commands: [], parts: [] });
  const browser = (open: number[]) => ({ evaluate: async (tabId: number) => read(tabId), tabs: async () => open.map(tabId => ({ tabId, title: '', url: '' })), close() {} }) as any;
  const first = new Stage({ log: () => {}, browser: browser([41, 42, 43]), file });
  for (const tabId of [41, 42, 43]) { first.observe(posted('mcp__open-claude-in-chrome-hybrid__navigate', { url: `http://localhost/${tabId}.html`, tabId })); await first.describe(0); }
  assert.deepEqual([...first.pages.keys()], [41, 42, 43]);
  // fdc restarts; meanwhile the operator closed the first page's tab.
  const again = new Stage({ log: () => {}, browser: browser([42, 43]), file });
  assert.equal(again.tabId, 43);
  const view = await again.describe(0);
  assert.deepEqual([...again.pages.keys()], [42, 43], 'the closed tab is no page to switch back to');
  assert.deepEqual(view!.commands.filter(c => c.id.startsWith('tab_')).map(c => c.id), ['tab_42'], 'the voice can switch back to the page still open');
  // Three days later the page is still picked up; after more than a week it is not.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, at: Date.now() - 3 * 86400000 }));
  assert.equal(new Stage({ log: () => {}, file }).tabId, 43);
  fs.writeFileSync(file, JSON.stringify({ ...saved, at: Date.now() - 8 * 86400000 }));
  assert.equal(new Stage({ log: () => {}, file }).tabId, undefined);
});
