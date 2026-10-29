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
const posted = (tool_name: string, tool_input: Record<string, unknown>, tool_response: unknown = '') => ({ raw: { hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response } });

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

test('Jev is asked for one page command at a time, in the conversation; unlikely or unknown picks run nothing, another action is a one-off', async () => {
  let answers: Record<string, unknown> = {}, sent: any;
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers }) }; } });
  const moment = { history: 'voice assistant: Want the options?\n', latest: { role: 'operator', text: 'Yes, go to the options and highlight the recommendation.' } as Line };
  const choice = (id: string, p = .95) => ({ choice: id, probabilities: { [id]: p } });
  answers = { needs_agent: { noul: .2 }, page_command: choice('goto_options'), page_only: { noul: .8 } };
  assert.deepEqual((await jev.read({ trigger: 'turn', ...moment, page: view })).page, { command: 'goto_options', only: .8, other: 0, walk: 0 }, 'the command, and whether the page is what the words are about');
  assert.match(sent.state.page, /Briefing .*The viewer is at: section "Intro"/);
  assert.deepEqual([sent.state.history, sent.state.latest], ['voice assistant: Want the options?', 'user: Yes, go to the options and highlight the recommendation.'], 'the latest words, and what happened before them');
  assert.match(sent.state.why, /stopped speaking/);
  assert.deepEqual(Object.keys(sent.questions.page_command.criteria), ['none', 'next_section', 'goto_options', 'show_the_recommendation', 'other_action']);
  assert.ok(!Object.keys(sent.questions).some(name => /^page_step|^page_steps$/.test(name)), 'one command question, no count');
  answers = { page_command: choice('next_section', .35) };
  assert.equal((await jev.read({ trigger: 'turn', ...moment, page: view })).page!.command, undefined, 'unlikely: nothing runs');
  answers = { page_command: choice('made_up') };
  assert.equal((await jev.read({ trigger: 'turn', ...moment, page: view })).page!.command, undefined, 'not a command of the page');
  answers = { page_command: choice('other_action', .9) };
  assert.deepEqual((await jev.read({ trigger: 'turn', ...moment, page: view })).page, { command: undefined, only: 0, other: .9, walk: 0 }, 'another action: a one-off does it');
  // After a command ran, the page as it is now, and what ran: whether more is asked, and which command is next.
  answers = { page_command: choice('show_the_recommendation'), page_more: { noul: .8 } };
  assert.equal((await jev.read({ trigger: 'step', ...moment, page: view, done: [view.commands[1]] })).page!.command, 'show_the_recommendation');
  assert.deepEqual(Object.keys(sent.questions), ['page_command', 'page_more']);
  assert.equal(sent.state.page_done, '1. Go to the section "Options"');
  answers = { page_command: choice('show_the_recommendation'), page_more: { noul: .3 } };
  assert.equal((await jev.read({ trigger: 'step', ...moment, page: view, done: [view.commands[1]] })).page!.command, undefined, 'nothing more asked: done');
  answers = { needs_agent: { noul: .9 } };
  assert.equal((await jev.read({ trigger: 'delegation', ...moment })).page, undefined, 'no page, no page questions');
  assert.equal(sent.questions.page_command, undefined);
});

test("Jev reads the latest words with what happened before them, as a new voice session starts from: the agent's events and the conversation, in order", async t => {
  const { h, sessionId } = await harness(t);
  const moments = fakeJev(h), hook = (command: string) => h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok' } });
  const said = Date.now();
  hook('npm test');
  await new Promise(resolve => setTimeout(resolve, 5));
  const latest = Date.now();
  await new Promise(resolve => setTimeout(resolve, 5));
  hook('git commit');
  await h.read({ trigger: 'delegation', spoken: [{ role: 'intermediary', text: 'Tests are running.', at: said - 5000 }, { role: 'operator', text: 'Then commit it.', at: latest }] });
  assert.equal(moments[0].latest!.text, 'Then commit it.');
  assert.match(moments[0].history!, /^voice assistant: Tests are running\.\nClaude Code observation \(history\):\n[^\n]*npm test[^\n]*\n$/, 'in the order it happened, as the agent and a new voice session read it');
  assert.doesNotMatch(moments[0].history!, /git commit/, 'nothing after the latest words');
});

test("commands that do the same count as one choice, even below none: the page's own runs", () => {
  const deck: StageView = { ...view, commands: [{ id: 'back', say: 'Go back to wherever the viewer was' }, { id: 'next_section', say: 'Go to the next section' }, { id: 'page_back', say: 'Go back to the previous slide' }, { id: 'page_next', say: 'Go to the next slide' }] };
  const step = (probabilities: Record<string, number>) => ({ choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities });
  assert.equal(chosenCommand(step({ none: .3, back: .26, page_back: .25, next_section: .19 }), deck), 'page_back', "fdc's back and the page's back together beat none");
  assert.equal(chosenCommand(step({ none: .4, back: .26, page_back: .11, next_section: .23 }), deck), undefined, 'together still unlikely: nothing runs');
  assert.equal(chosenCommand(step({ next_section: .5, page_next: .1, none: .4 }), deck), 'next_section', "a unit's own step is not the page's next");
});

test('the page moves one command at a time until Jev wants no more: a repeated move repeats, a part reached again ends it, five at most', async t => {
  const { h } = await harness(t);
  const runs: string[] = [];
  h.stage = { describe: async () => view, run: async (ids: string[]) => { runs.push(...ids); return { done: ids.map(id => view.commands.find(c => c.id === id) ?? { id, say: id }), onScreen: `at ${ids[0]}` }; }, view, observe() {}, close() {} } as any;
  h.presenter.stepDwellMs = 0;
  let next: (string | undefined)[] = [];
  const moments = fakeJev(h, moment => moment.trigger === 'step' ? { page: pageReading({ command: next.shift() }) } : {});
  next = ['next_section', 'next_section', undefined];
  assert.deepEqual(await h.presenter.steps('next_section', []), { done: Array(3).fill(view.commands[0]), onScreen: 'at next_section' });
  assert.deepEqual(runs, ['next_section', 'next_section', 'next_section'], '"forward three sections"');
  assert.deepEqual(moments.map(m => [m.trigger, m.done!.length]), [['step', 1], ['step', 2], ['step', 3]], 'asked again after each command, with what ran');
  runs.length = 0; next = ['show_the_recommendation', 'goto_options'];
  await h.presenter.steps('goto_options', []);
  assert.deepEqual(runs, ['goto_options', 'show_the_recommendation'], 'a part reached again is no further on');
  runs.length = 0; next = Array(10).fill('next_section');
  await h.presenter.steps('next_section', []);
  assert.equal(runs.length, 5, 'five at most');
});

function staged(t: any, page: { command?: string; only: number }, run: (ids: string[]) => Promise<any>) {
  return harness(t).then(async ({ h, lives }) => {
    h.stage = { describe: async () => view, run, view, observe() {}, close() {} } as any;
    // After the first command, Jev wants no other; the job delegation finds work unless the page is all they ask.
    fakeJev(h, moment => moment.trigger === 'step' ? { page: pageReading() } : moment.trigger === 'job' ? { needsAgent: page.only > .5 ? .1 : .9 } : { sessions: { asked: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0, page: pageReading(page) });
    await h.startLive(undefined, undefined, 'fresh');
    const told = () => lives[0].appended.map(([kind, text]) => `${kind}: ${text}`).join('\n');
    return { h, told };
  });
}

test('the turn: page-only is done on the page and kept from the harness; with more, the words go on noting the page part is done; a failure goes to the harness', async t => {
  const runs: string[][] = [];
  const only = await staged(t, { command: 'goto_options', only: .9 }, async ids => { runs.push(ids); return { done: [view.commands[1]], onScreen: 'heading: Options — eleven of them.' }; });
  const kept = await turn(only.h, 'take me to the options');
  assert.deepEqual(runs, [['goto_options']]);
  assert.deepEqual([kept.send, kept.moved, kept.note], [false, true, handledNote('page')]);
  await until(() => /moved the page for the operator's words; on screen now: heading: Options — eleven of them\./.test(only.told()));
  const mixed = await staged(t, { command: 'goto_options', only: .1 }, async () => ({ done: [view.commands[1]], onScreen: 'heading: Options' }));
  const along = await turn(mixed.h, 'show me the options and fix the typo');
  assert.equal(along.send, true, 'the job delegation found work: the words go on');
  assert.match(along.note!, /already did the page part of this in the browser \(Go to the section "Options"\); don't do that again, do the rest/);
  const work = await staged(t, { only: .1 }, async () => { throw new Error('not run'); });
  const passed = await turn(work.h, 'make this title bigger');
  assert.equal(passed.send, true);
  assert.match(passed.note!, /^When they said it, the user was looking at "Briefing" \(http:\/\/localhost\/b\.html\) in the browser, at: section "Intro"\.$/);
  const idle = await staged(t, { command: 'next_section', only: .9 }, async () => { throw new StageNothing('nothing to do there', [], '', view.commands[0]); });
  const nothing = await turn(idle.h, 'go back');
  assert.deepEqual([nothing.send, nothing.moved], [false, false], 'nothing to do there: the voice says so');
  await until(() => /The page had nothing to do for the operator's words/.test(idle.told()));
  const broken = await staged(t, { command: 'show_the_recommendation', only: .9 }, async () => { throw new Error('fdcController.run: no element #rec'); });
  const failed = await turn(broken.h, 'highlight the recommendation');
  assert.deepEqual([failed.send, failed.escalated], [true, true], 'a failure goes to the harness');
  assert.match(failed.note!, /page's controls failed: fdcController\.run: no element #rec\. Fix the page's controller/);
  await until(() => /The page couldn't go on \(fdcController\.run: no element #rec\)/.test(broken.told()));
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

test('a one-off is only the fixed page steps: anything else, code included, is refused', async () => {
  const { FastAction, parseOneOff } = await import('../src/core/fast-action.ts');
  const reply = (text: string) => new FastAction({ apiKey: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({ output_text: text }) }) });
  assert.deepEqual(await reply('{"actions":[{"do":"click","n":3},{"do":"wait","ms":9000},{"do":"find","text":"Q3"}],"say":"The Q3 row."}').write('open the table and point at Q3', 'digest'),
    { actions: [{ do: 'click', n: 3 }, { do: 'wait', ms: 3000 }, { do: 'find', text: 'Q3' }] });
  assert.deepEqual(parseOneOff('```json\n{"actions":[{"do":"scroll","to":"down"}]}\n```'), { actions: [{ do: 'scroll', to: 'down' }] }, 'fences are dropped');
  assert.deepEqual(parseOneOff('{"actions":[{"do":"find","text":"Gemini","in":"row"}]}').actions, [{ do: 'find', text: 'Gemini', in: 'row' }], 'a find can say the kind of thing named');
  for (const text of ['el(3).click();', '{"actions":[{"do":"eval","code":"fetch(1)"}]}', '{"actions":[{"do":"click","n":"3; fetch(1)"}]}', '{"actions":[]}', '{"actions":[{"do":"scroll","to":"https://x"}]}', '{"actions":[{"do":"find","text":"Gemini","in":"script"}]}'])
    assert.throws(() => parseOneOff(text), /fast model|Refused a page step/, text);
});

test('a one-off waits 3 s in all, and a click that opens another page of the site is done, not failed', async () => {
  const { parseOneOff } = await import('../src/core/fast-action.ts');
  assert.deepEqual(parseOneOff('{"actions":[{"do":"wait","ms":2000},{"do":"click","n":1},{"do":"wait","ms":2000},{"do":"wait","ms":500}]}').actions.filter(a => a.do === 'wait').map(a => (a as any).ms), [2000, 1000, 0]);
  const timeouts: (number | undefined)[] = [];
  const browser = { evaluate: async (_tab: number, _code: string, timeoutMs?: number) => { timeouts.push(timeoutMs); throw new Error('{"code":-32000,"message":"Inspected target navigated or closed"}'); }, close() {} };
  const stage = new Stage({ log: () => {}, browser: browser as any });
  stage.tabId = 1;
  assert.equal(await stage.act([{ do: 'click', n: 1 }, { do: 'wait', ms: 1500 }]), 'The page opened another page of this site.');
  assert.deepEqual(timeouts, [6500], "the steps' own waits and 5 s for the rest");
  browser.evaluate = async () => { throw new Error('No element [9]'); };
  await assert.rejects(stage.act([{ do: 'click', n: 9 }]), /No element \[9\]/);
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
