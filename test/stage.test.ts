// The stage: the page the agent showed, which the gate moves without the agent (stage.ts, sessions.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Stage, StageNothing, type StageView } from '../src/core/stage.ts';
import { DelegationAudit } from '../src/core/delegation-audit.ts';
import { Mediator, type Ahead, type Gated } from '../src/core/mediator.ts';
import { harness, until } from './live-fake.ts';

const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"', cues: [],
  commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }, { id: 'show_the_recommendation', say: 'Show and highlight: the recommendation' }] };
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
  const browser = { evaluate: async (tabId: number, expression: string) => { calls.push(`${tabId}:${expression.slice(-360)}`); return expression.endsWith('window.__fdcStage.describe()') ? { ...view, tabId: undefined } : expression.includes('"next_section"') ? { said: ['one'], error: 'Already broken' } : expression.includes('"back"') ? { said: [], nothing: true } : { said: ['one', 'two'] }; }, close() {} } as any;
  const stage = new Stage({ log: () => {}, browser });
  assert.equal(await stage.describe(), undefined, 'no stage, no page');
  stage.tabId = 7;
  assert.deepEqual((await stage.describe())!.commands.map(c => c.id), ['next_section', 'goto_options', 'show_the_recommendation']);
  await stage.describe();
  assert.equal(calls.length, 1, 'a fresh description is reused');
  const ran = await stage.run(['goto_options', 'show_the_recommendation']);
  assert.match(calls[1], /for \(const id of \["goto_options","show_the_recommendation"\]\)/);
  assert.deepEqual(ran, { done: [view.commands[1], view.commands[2]], onScreen: 'two' });
  await assert.rejects(stage.run(['goto_options', 'next_section']), (error: any) => error.message === 'Already broken' && error.done[0].id === 'goto_options' && error.failed.id === 'next_section' && error.onScreen === 'one', 'a step that throws stops the rest; what ran before it is reported');
  await assert.rejects(stage.run(['back']), (error: any) => error instanceof StageNothing && error.failed.id === 'back', 'nothing to do is not done');
});

test('Jev picks whole page commands in order; the count ends the list, unlikely or unknown picks are dropped', async () => {
  let answers: Record<string, unknown> = {}, sent: any;
  const audit = new DelegationAudit({ apiKey: 'k', file: '/dev/null', log: () => {}, fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers }) }; } });
  const choice = (id: string, p = .95) => ({ choice: id, probabilities: { [id]: p } });
  answers = { needs_agent: { noul: .2 }, page_steps: { choice: '2' }, page_step_1: choice('goto_options'), page_step_2: choice('show_the_recommendation'), page_step_3: choice('show_the_recommendation'), page_only: { noul: .8 } };
  assert.equal((await audit.judge('go to the options and highlight the recommendation', undefined, 3000, view)).page!.work, 1, 'work unanswered counts as asked');
  answers = { ...answers, page_work: { noul: 0 } };
  assert.deepEqual((await audit.judge('go to the options and highlight the recommendation', undefined, 3000, view)).page, { steps: ['goto_options', 'show_the_recommendation'], only: .8, work: 0, other: 0, count: 2, first: .95 });
  assert.match(sent.state.page, /Briefing .*The viewer is at: section "Intro"/);
  assert.deepEqual(Object.keys(sent.questions.page_step_1.criteria), ['none', 'next_section', 'goto_options', 'show_the_recommendation', 'other_action']);
  answers = { ...answers, page_steps: { choice: '0' }, page_step_2: choice('none') };
  assert.deepEqual((await audit.judge('options', undefined, 3000, view)).page!.steps, ['goto_options'], 'a confident first step runs without a count');
  answers = { ...answers, page_steps: { choice: '3' }, page_step_1: choice('next_section', .35), page_step_2: choice('made_up'), page_step_3: choice('next_section') };
  assert.deepEqual((await audit.judge('next', undefined, 3000, view)).page!.steps, ['next_section']);
  answers = { ...answers, page_steps: { choice: '2' }, page_step_1: choice('next_section'), page_step_2: choice('none'), page_step_3: choice('none') };
  assert.deepEqual((await audit.judge('next section and add a slide', undefined, 3000, view)).page!.steps, ['next_section'], 'a count that includes work is not a repetition');
  answers = { ...answers, page_steps: { choice: '5' }, page_step_1: choice('next_section'), page_step_2: choice('next_section'), page_step_3: choice('none') };
  assert.deepEqual((await audit.judge('down five sections', undefined, 3000, view)).page!.steps, Array(5).fill('next_section'), 'one command repeated runs as often as counted');
  answers = { ...answers, page_steps: { choice: '2' }, page_step_1: choice('goto_options'), page_step_2: choice('other_action', .9), page_step_3: choice('none') };
  assert.deepEqual((await audit.judge('go to the options and highlight the third row', undefined, 3000, view)).page!.steps, [], 'another action anywhere: the whole request is a one-off action');
  answers = { ...answers, page_steps: { choice: '0' }, page_step_1: choice('goto_options'), page_step_2: choice('none'), page_work: { noul: .8 } };
  assert.deepEqual((await audit.judge('make the options section bigger', undefined, 3000, view)).page!.steps, ['goto_options'], "a sure first step runs though Jev counted none: it shows the part being worked on");
  answers = { needs_agent: { noul: .9 } };
  assert.equal((await audit.judge('fix the parser', undefined, 3000)).page, undefined, 'no page, no page questions');
  assert.equal(sent.questions.page_steps, undefined);
});

function gated(t: any, page: { steps: string[]; only: number }, run: (ids: string[]) => Promise<any>) {
  return harness(t).then(({ h }) => {
    h.stage = { describe: async () => view, run, view, observe() {}, close() {} } as any;
    h.handOffAudit = { judge: async () => ({ needsAgent: .3, sessions: { asked: 0, only: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0, page: { ...page, count: page.steps.length } }) } as any;
    return h;
  });
}

test('the gate: page-only is done on the page; with more, the request goes on noting the page part is done; a failure goes to the harness', async t => {
  const runs: string[][] = [];
  const only = await gated(t, { steps: ['goto_options'], only: .9 }, async ids => { runs.push(ids); return { done: [view.commands[1]], onScreen: 'heading: Options — eleven of them.' }; });
  const handled = await only.sessionSwitch.gate('take me to the options', 'r1');
  assert.deepEqual(runs, [['goto_options']]);
  assert.equal(handled.page, true);
  assert.match(handled.handled!, /^Nothing was sent to Claude Code: the voice tool did it on the page \(Go to the section "Options"\)\. On screen now: heading: Options — eleven of them\./);
  const mixed = await gated(t, { steps: ['goto_options'], only: .1 }, async () => ({ done: [view.commands[1]], onScreen: 'heading: Options' }));
  const along = await mixed.sessionSwitch.gate('show me the options and fix the typo', 'r2');
  assert.equal(along.handled, undefined);
  assert.match(along.note!, /already did the page part of this in the browser \(Go to the section "Options"\); don't do that again, do the rest/);
  assert.match(along.told!, /already did the page part .* The rest goes to Claude/);
  const work = await gated(t, { steps: [], only: .1 }, async () => { throw new Error('not run'); });
  const passed = await work.sessionSwitch.gate('make this title bigger', 'r5');
  assert.equal(passed.handled, undefined);
  assert.match(passed.note!, /^When they said it, the user was looking at "Briefing" \(http:\/\/localhost\/b\.html\) in the browser, at: section "Intro"\.$/);
  const idle = await gated(t, { steps: ['next_section'], only: .9 }, async () => { throw new StageNothing('nothing to do there', [], '', view.commands[0]); });
  const nothing = await idle.sessionSwitch.gate('go back', 'r4');
  assert.equal(nothing.handled, undefined, 'nothing to do: the request goes on');
  assert.match(nothing.note!, /there was nothing to do there; do what the user asked/);
    const broken = await gated(t, { steps: ['show_the_recommendation'], only: .9 }, async () => { throw new Error('fdcController.run: no element #rec'); });
  const failed = await broken.sessionSwitch.gate('highlight the recommendation', 'r3');
  assert.equal(failed.handled, undefined, 'a failure goes to the harness');
  assert.match(failed.note!, /page's controls failed: fdcController\.run: no element #rec\. Fix the page's controller/);
  assert.match(failed.told!, /^The page couldn't go on \(fdcController\.run: no element #rec\)/);
});

test('the mediator tells GPT Live what the page shows and sends the harness the note with the request', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  const appends: [string, string, string | null][] = []; live.append = async (kind: string, content: string, delegationId: string | null) => { appends.push([kind, content, delegationId]); };
  const deliveries: any[] = [];
  const gate = async (): Promise<Gated> => ({ needsAgent: .6, note: 'The voice tool already did the page part.', told: 'On screen now: Options.' });
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, gate });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Show me the options and fix the typo.', start_ms: 0, end_ms: 900 });
  m.delegate('d1', 900);
  await until(() => deliveries.length);
  assert.deepEqual(appends[0], ['thinking', 'On screen now: Options.', 'd1']);
  assert.match(deliveries[0].content, /Earlier speech went with earlier voice requests\. The voice tool already did the page part\.\n\nuser: Show me the options and fix the typo\.$/);
});

test('a one-off is only the fixed page steps: anything else, code included, is refused', async () => {
  const { FastAction, parseOneOff } = await import('../src/core/fast-action.ts');
  const reply = (text: string) => new FastAction({ apiKey: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({ output_text: text }) }) });
  assert.deepEqual(await reply('{"actions":[{"do":"click","n":3},{"do":"wait","ms":9000},{"do":"find","text":"Q3"}],"say":"The Q3 row."}').write('open the table and point at Q3', 'digest'),
    { actions: [{ do: 'click', n: 3 }, { do: 'wait', ms: 3000 }, { do: 'find', text: 'Q3' }], say: 'The Q3 row.' });
  assert.deepEqual(parseOneOff('```json\n{"actions":[{"do":"scroll","to":"down"}]}\n```'), { actions: [{ do: 'scroll', to: 'down' }], say: '' }, 'fences are dropped');
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

test('requests reach the agent in the order made, however long each one\'s gate takes', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  live.append = async () => {};
  const deliveries: any[] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const gate = async (said: string): Promise<Gated> => { started.push(said); if (/bigger/.test(said)) await slow; return { needsAgent: .9 }; };
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, gate });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Go to the options and make its title bigger.', start_ms: 0, end_ms: 900 });
  m.delegate('d1', 900);
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Actually, make it smaller instead.', start_ms: 5000, end_ms: 6000 });
  m.delegate('d2', 6000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(deliveries.length, 0, 'the second waits for the first');
  assert.equal(started.length, 1, "the second's gate, which may move the page, starts after the first's");
  release();
  await until(() => deliveries.length === 2);
  assert.match(deliveries[0].content, /bigger/); assert.match(deliveries[1].content, /smaller/);
});

test("a request whose gate's outcome fails isn't lost: its words go with the next request", async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  live.append = async () => {};
  const faults: string[] = [];
  const m = new Mediator({ live, observer, deliver: () => {}, log: e => { if (e.type === 'bridge.fault') faults.push(String(e.message)); }, publish: () => {}, clean: String, hold: null, gate: async () => ({ needsAgent: .9 }) });
  t.after(() => { m.stop(); observer.close(); });
  m.afterGate = () => { throw new Error('boom'); };
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Fix the parser.', start_ms: 0, end_ms: 900 });
  m.delegate('d1', 900);
  await until(() => faults.length);
  assert.deepEqual(faults, ['boom']);
  assert.equal(m.history.request(Infinity)?.fresh, 'Fix the parser.');
});

test('a page controller returning anything is kept to well-formed commands and cues', async () => {
  const odd = { title: 7, url: 'http://localhost/x.html', about: { not: 'text' }, where: null, outline: ['no'], commands: [{ id: 'slide_3', say: 'Go to slide 3', name: 3 }, { id: 4 }, null, 'x', { id: 'ok', say: 'Fine' }], cues: { say: 'next' } };
  const stage = new Stage({ log: () => {}, browser: { evaluate: async () => odd, close() {} } as any });
  stage.tabId = 1;
  const view = (await stage.describe(0))!;
  assert.deepEqual(view.commands, [{ id: 'slide_3', say: 'Go to slide 3', name: '3' }, { id: 'ok', say: 'Fine' }]);
  assert.deepEqual(view.cues, []); assert.equal(view.about, null); assert.equal((view as any).outline, undefined); assert.equal(view.title, '7');
});

test('listening ahead: the page moves as the operator pauses; GPT Live\'s delegation then sends nothing new, and the words still reach the agent later, noted', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  const appends: [string, string, string | null][] = []; live.append = async (kind: string, content: string, delegationId: string | null) => { appends.push([kind, content, delegationId]); };
  const deliveries: any[] = [], asked: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const ahead: Ahead = { judge: async said => { asked.push(said); await slow; return /next slide/i.test(said) ? { steps: ['next_slide'], only: 1, count: 1 } : undefined; }, act: async judgment => judgment ? { told: 'Moved: next slide.' } : undefined };
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({ needsAgent: .9 }), ahead });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Next slide.', start_ms: 0, end_ms: 700 });
  await until(() => asked.length);
  await new Promise(resolve => setTimeout(resolve, 400));
  m.delegate('d1', 700);
  assert.equal(deliveries.length, 0, 'a delegation arriving while it looks waits');
  release();
  await until(() => appends.some(([, , id]) => id === 'd1'));
  assert.deepEqual(asked, ['Next slide.']);
  assert.ok(appends.some(([kind, text, id]) => kind === 'thinking' && text === 'Moved: next slide.' && id === null), 'GPT Live hears it at once');
  assert.ok(appends.some(([kind, text, id]) => kind === 'thinking' && text === 'Moved: next slide.' && id === 'd1'), 'and in answer to its delegation');
  assert.equal(deliveries.length, 0, 'nothing goes to the agent now');
  m.handOff('operator ended voice');
  await until(() => deliveries.length);
  assert.match(deliveries[0].content, /only about showing things on the page.*\n\nuser: Next slide\.$/s, 'the words still reach the agent, noted');
});

test('listening ahead never acts on half a sentence: the transcript arrives a word at a time, rarely punctuated', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {}; live.append = async () => {};
  const asked: string[] = [], acted: string[] = [];
  const m = new Mediator({ live, observer, deliver: () => {}, log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({}),
    ahead: { judge: async said => { asked.push(said); return { steps: ['next_slide'], only: 1, count: 1 }; }, act: async (_judgment, _since, said) => { acted.push(said!); return undefined; } } });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Next', start_ms: 0, end_ms: 300 });
  // Still talking: the microphone hears them while the transcript waits for more words.
  for (let i = 0; i < 9; i++) { m.hear({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008 }); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.deepEqual(asked, [], '"Next" alone is not read while they speak');
  live.emit('event', { type: 'session.input_transcript.delta', delta: ', can you fix', start_ms: 300, end_ms: 1300 });
  const quiet = Date.now();
  await until(() => asked.length);
  assert.ok(Date.now() - quiet < 400, 'with the microphone quiet, Jev reads the words at once');
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' the parser', start_ms: 1300, end_ms: 1600 });
  const last = Date.now();
  await until(() => acted.length);
  assert.deepEqual(distinct(asked), ['Next, can you fix', 'Next, can you fix the parser'], 'read again with the word that came late');
  assert.deepEqual(acted, ['Next, can you fix the parser']);
  assert.ok(Date.now() - last >= 550, 'acted on once they were quiet a while');
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Next slide.', start_ms: 5000, end_ms: 5600 });
  const ended = Date.now();
  await until(() => acted.length === 2);
  assert.ok(Date.now() - ended < 550, 'a finished sentence is acted on sooner');
  assert.equal(asked.filter(said => said === 'Next slide.').length, 1, 'words read once are not read again');
});
const distinct = (said: string[]) => [...new Set(said)];

test("listening ahead acts once GPT Live starts its answer and no word follows, never on its murmurs or talk it was already giving", async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {}; live.append = async () => {};
  const acted: string[] = [];
  const m = new Mediator({ live, observer, deliver: () => {}, log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({}),
    ahead: { judge: async () => ({ steps: ['next_slide'], only: 1, count: 1 }), act: async (_judgment, _since, said) => { acted.push(said!); return undefined; } } });
  t.after(() => { m.stop(); observer.close(); });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const talking = async (ms: number) => { for (let i = 0; i < ms / 100; i++) { m.hear({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008 }); await wait(100); } };
  const quiet = () => m.hear({ at: Date.now(), inputRms: 0, rawInputRms: 0, gateThreshold: .008 });
  const said = (delta: string, at: number) => live.emit('event', { type: 'session.input_transcript.delta', delta, start_ms: at, end_ms: at + 300 });
  const answer = (delta: string, at: number) => live.emit('event', { type: 'session.output_transcript.delta', delta, start_ms: at, end_ms: at + 300 });
  said('Next', 0); answer('Mm.', 300);
  await talking(1100);
  assert.deepEqual(acted, [], 'a murmur while they talk is no end of their turn');
  said(' slide', 400); quiet(); await wait(160); quiet();
  const started = Date.now(); answer(" Let's", 1000);
  await until(() => acted.length);
  assert.deepEqual(acted, ['Next slide']);
  assert.ok(Date.now() - started < 400, 'soon after the answer starts, once no word followed for a moment');
  // GPT Live already talking when the operator's next words end: its next words don't count; quiet does.
  answer(' Here we are.', 1300); said('Go back', 5000); quiet(); await wait(200); quiet();
  answer(' On', 1600); answer(' the', 1900);
  await wait(400);
  assert.equal(acted.length, 1, 'talk it was already giving is not an answer');
  await until(() => acted.length === 2);
  assert.equal(acted[1], 'Go back', 'quiet, after a while');
  // GPT Live starts as the last word arrives, but more words follow: nothing moves yet.
  await wait(1100);
  said('Previous', 10000); answer(' Sure,', 10500); await wait(150); said(' wait, next', 10400);
  await wait(300);
  assert.equal(acted.length, 2, 'a word after the answer started holds the move');
});

test('listening ahead does a one-off action when no command fits and Jev is sure it is only for the page', async t => {
  const { h } = await harness(t);
  const acted: any[] = [];
  h.stage = { describe: async () => view, digest: async () => 'digest', act: async (actions: any) => { acted.push(actions); return 'row: Gemini'; }, run: async () => { throw new Error('no command'); }, view, observe() {}, close() {} } as any;
  h.fastAction = { write: async () => ({ actions: [{ do: 'find', text: 'Gemini' }], say: 'The Gemini row.' }) } as any;
  const told = await h.sessionSwitch.aheadAct({ steps: [], only: .9, work: .1, other: .85, count: 0 }, Date.now(), 'highlight the Gemini row');
  assert.deepEqual(acted, [[{ do: 'find', text: 'Gemini' }]]);
  assert.match((told as { told: string }).told, /already did it on the page \(A one-off action for "highlight the Gemini row"\)\. On screen now: The Gemini row\. \(row: Gemini\)/);
  assert.equal(await h.sessionSwitch.aheadAct({ steps: [], only: .9, work: .1, other: .5, count: 0 }, Date.now(), 'maybe the row'), undefined, 'not sure enough: left to GPT Live');
  assert.equal(await h.sessionSwitch.aheadAct({ steps: [], only: .9, work: .4, other: .9, count: 0 }, Date.now(), 'highlight it and fix the row'), undefined, 'work in it: left to GPT Live');
  assert.equal(acted.length, 1);
  h.stage.act = async () => { throw new Error('Inspected target crashed'); };
  assert.deepEqual(await h.sessionSwitch.aheadAct({ steps: [], only: .9, work: .1, other: .85, count: 0 }, Date.now(), 'highlight the Gemini row'),
    { failed: "No page command fitted this, and the voice tool's one-off action on the page failed: Inspected target crashed. Do what the user asked, and consider giving the page a command for it." },
    'once steps ran, a failure goes on with its error rather than to the gate to try again');
});

test("a cue waits for listening ahead's move in progress, and runs only if it moved nothing", async t => {
  const { h } = await harness(t);
  const runs: string[][] = [];
  h.stage = { describe: async () => view, run: async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; }, view, observe() {}, close() {}, follow: async () => null } as any;
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {}; live.append = async () => {};
  const mediator = new Mediator({ live, observer, deliver: () => {}, log: () => {}, publish: () => {}, clean: String, hold: null });
  t.after(() => { mediator.stop(); observer.close(); });
  let finish!: () => void;
  mediator.looking = new Promise<void>(resolve => { finish = resolve; });
  h.voiceSessions.mediator = mediator;
  const cue = { run: 'goto_options', label: 'options', words: ['options'], name: true };
  const first = h.runCue(cue);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(runs, [], 'it waits');
  h.aheadAt = Date.now(); h.aheadMoved = true; finish(); await first;
  assert.deepEqual(runs, [], 'listening ahead moved the page: the cue is skipped');
  h.aheadAt = 0; mediator.looking = Promise.resolve();
  await h.runCue(cue);
  assert.deepEqual(runs, [['goto_options']], 'it moved nothing: the cue runs');
});

test('a look moves nothing if more words came while Jev read; the look asked for meanwhile waits its turn; Jev reads one at a time; words a look holds when voice ends still reach the agent', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {}; live.append = async () => {};
  const asked: string[] = [], acted: string[] = [], deliveries: any[] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({}),
    ahead: { judge: async said => { asked.push(said); await slow; return undefined; }, act: async (_judgment, _since, said) => { acted.push(said!); return undefined; } } });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Go to the.', start_ms: 0, end_ms: 500 });
  await until(() => !!m.looking);
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Risks, then fix the parser.', start_ms: 600, end_ms: 1800 });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(asked, ['Go to the.'], 'one read at a time');
  release();
  await until(() => acted.length === 1);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(acted, ['Go to the. Risks, then fix the parser.'], "more words came while the first look's were read: it moved nothing, and the look asked for meanwhile read them all");
  // Voice ends while a look holds the words: they go to the agent once it's done.
  let finish!: () => void;
  const m2 = new Mediator({ live: Object.assign(new EventEmitter(), { state: 'active', id: 'live_2', close() {}, append: async () => {} }) as any, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({}),
    ahead: { judge: () => new Promise(resolve => { finish = () => resolve(undefined); }), act: async () => undefined } });
  t.after(() => m2.stop());
  (m2.live as any).emit('event', { type: 'session.input_transcript.delta', delta: 'Next slide, then fix the parser.', start_ms: 0, end_ms: 900 });
  await until(() => !!m2.looking);
  m2.handOff('operator ended voice');
  assert.equal(deliveries.length, 0, 'held by the look');
  finish();
  await until(() => deliveries.length);
  assert.match(deliveries[0].content, /Next slide, then fix the parser\./);
});

test('a dropped connection\'s look moves nothing and hands nothing off: its words wait to be carried', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {}; live.append = async () => {};
  const acted: string[] = [], deliveries: any[] = [];
  let finish!: () => void;
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({}),
    ahead: { judge: () => new Promise(resolve => { finish = () => resolve({ steps: ['next_slide'], only: 1, count: 1, first: 1 }); }), act: async (_j, _s, said) => { acted.push(said!); return { told: 'Moved.' }; } } });
  t.after(() => observer.close());
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Next slide, then fix the parser.', start_ms: 0, end_ms: 900 });
  await until(() => !!m.looking);
  m.stop();
  finish();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(acted, [], 'nothing moves for a closed connection');
  assert.equal(deliveries.length, 0, 'nothing handed off: carrying decides');
  assert.equal(m.history.request(Infinity)?.fresh, 'Next slide, then fix the parser.', 'the words wait, unclaimed, to be carried');
});

test("a delegation after listening ahead moved the page doesn't judge older words GPT Live answered itself", async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  const appends: [string, string, string | null][] = []; live.append = async (kind: string, content: string, id: string | null) => { appends.push([kind, content, id]); };
  const deliveries: any[] = [], gated: string[] = [];
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null,
    gate: async said => { gated.push(said); return { needsAgent: .5, handled: 'Moved to slide 1.', page: true }; },
    ahead: { judge: async said => /second slide/.test(said) ? { steps: ['page_slide_2'], only: .95, work: .05, count: 1, first: .95 } : undefined, act: async judgment => judgment ? { told: 'Moved: slide 2.' } : undefined } });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Walk me through it briefly.', start_ms: 0, end_ms: 1200 });
  live.emit('event', { type: 'session.output_transcript.delta', delta: 'The first slide introduces the expediter.', start_ms: 1500, end_ms: 4000 });
  await new Promise(resolve => setTimeout(resolve, 500));
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Go back to the second slide.', start_ms: 9000, end_ms: 10500 });
  await until(() => appends.some(([, text, id]) => text === 'Moved: slide 2.' && id === null));
  m.delegate('d1', 10500);
  await until(() => appends.some(([, text, id]) => text === 'Moved: slide 2.' && id === 'd1'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(gated, [], 'the gate never judged "walk me through it" (it would have gone to slide 1)');
  assert.equal(deliveries.length, 0, 'nothing more goes now; the words wait for the next request');
});

test("a reconnect takes the words a look holds, and the old connection's look no longer hands them off", async () => {
  const { VoiceHistory } = await import('../src/core/voice-history.ts');
  const old = new VoiceHistory(), fresh = new VoiceHistory();
  old.add({ type: 'session.input_transcript.delta', delta: 'Next slide, then fix the parser.', start_ms: 0, end_ms: 900 });
  const request = old.request(Infinity)!;
  old.claim(request, 'ahead-1');
  fresh.carry(old);
  assert.equal(fresh.request(Infinity)?.fresh, 'Next slide, then fix the parser.');
  assert.equal(old.release('ahead-1'), 0, 'carried: the look releases nothing');
  assert.equal(old.request(Infinity), null);
});

test('listening ahead moves nothing for words a cue already moved the page for, or moves it for while Jev reads them', async t => {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {}; live.append = async () => {};
  const asked: string[] = [];
  const m = new Mediator({ live, observer, deliver: () => {}, log: () => {}, publish: () => {}, clean: String, hold: null, gate: async () => ({}), ahead: { judge: async said => { asked.push(said); return undefined; }, act: async () => undefined } });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Next slide.', start_ms: 0, end_ms: 700 });
  m.history.cueLatest('moved');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual(asked, [], 'cued words are the gate\'s to judge');
  const { h } = await harness(t);
  const runs: string[][] = [];
  h.stage = { describe: async () => view, run: async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; }, view, observe() {}, close() {} } as any;
  h.handOffAudit = { judge: async () => { m.cueAt = Date.now(); return { needsAgent: .1, page: { steps: ['next_section'], only: .9, work: 0, count: 1, first: .95 } }; } } as any;
  h.voiceSessions.mediator = m;
  const since = Date.now();
  assert.equal(await h.sessionSwitch.aheadAct(await h.sessionSwitch.aheadJudge('next section'), since, 'next section'), undefined);
  assert.deepEqual(runs, [], 'a cue moved the page while Jev read the words');
});
