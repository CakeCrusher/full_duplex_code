// The stage: the page the agent showed, which the gate moves without the agent (stage.ts, sessions.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Stage, StageNothing, type StageView } from '../src/core/stage.ts';
import { DelegationAudit } from '../src/core/delegation-audit.ts';
import { Mediator, type Gated } from '../src/core/mediator.ts';
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
  assert.deepEqual((await audit.judge('go to the options and highlight the recommendation', undefined, 3000, view)).page, { steps: ['goto_options', 'show_the_recommendation'], only: .8, work: 0, other: 0, count: 2 });
  assert.match(sent.state.page, /Briefing .*The viewer is at: section "Intro"/);
  assert.deepEqual(Object.keys(sent.questions.page_step_1.criteria), ['none', 'next_section', 'goto_options', 'show_the_recommendation', 'other_action']);
  answers = { ...answers, page_steps: { choice: '0' }, page_step_2: choice('none') };
  assert.deepEqual((await audit.judge('options', undefined, 3000, view)).page!.steps, ['goto_options'], 'a confident first step runs without a count');
  answers = { ...answers, page_steps: { choice: '3' }, page_step_1: choice('next_section', .4), page_step_2: choice('made_up'), page_step_3: choice('next_section') };
  assert.deepEqual((await audit.judge('next', undefined, 3000, view)).page!.steps, ['next_section']);
  answers = { ...answers, page_steps: { choice: '2' }, page_step_1: choice('next_section'), page_step_2: choice('none'), page_step_3: choice('none') };
  assert.deepEqual((await audit.judge('next section and add a slide', undefined, 3000, view)).page!.steps, ['next_section'], 'a count that includes work is not a repetition');
  answers = { ...answers, page_steps: { choice: '5' }, page_step_1: choice('next_section'), page_step_2: choice('next_section'), page_step_3: choice('none') };
  assert.deepEqual((await audit.judge('down five sections', undefined, 3000, view)).page!.steps, Array(5).fill('next_section'), 'one command repeated runs as often as counted');
  answers = { ...answers, page_steps: { choice: '2' }, page_step_1: choice('goto_options'), page_step_2: choice('other_action', .9), page_step_3: choice('none') };
  assert.deepEqual((await audit.judge('go to the options and highlight the third row', undefined, 3000, view)).page!.steps, [], 'another action anywhere: the whole request is a one-off action');
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

test('a one-off action that reaches outside the page is refused before it runs', async () => {
  const { FastAction } = await import('../src/core/fast-action.ts');
  const reply = (code: string) => new FastAction({ apiKey: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({ output_text: code }) }) });
  assert.equal(await reply('el(3).click();\nreturn "The table is open.";').write('open the table', 'digest'), 'el(3).click();\nreturn "The table is open.";');
  assert.equal(await reply('```js\nel(1).click();\n```').write('x', 'digest'), 'el(1).click();', 'fences are dropped');
  for (const code of ['await fetch("https://x")', 'location.href = "https://x"', 'localStorage.clear()', 'window.open("x")', 'document.cookie']) await assert.rejects(reply(code).write('x', 'digest'), /Refused an action that reaches outside the page/, code);
});
