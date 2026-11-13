// The page audit: every action on the page on the stage in one record (page.jsonl), with who acted, why, what the page
// answered, where the page and the ring were before and after, and what GPT Live was told of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PageAudit, type PageAction } from '../src/core/page-audit.ts';
import { Stage, StageError, StageNothing } from '../src/core/stage.ts';
import { fakeJev, harness, page, pageReading, until } from './live-fake.ts';

const view = { title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"', viewerAt: 0, parts: [],
  commands: [{ id: 'goto_options', say: 'Go to the section "Options"' }, { id: 'row_fdc', say: 'Highlight the row "FDC"' }, { id: 'next_section', say: 'Go to the next section' }] };
const place = (where: string, ring: string | null) => ({ url: view.url, where, viewerAt: 0, ring: { on: ring !== null, at: ring } });
/** A page that answers each run as told, and reads as `view`. */
function staged(answer: () => unknown) {
  const actions: PageAction[] = [];
  const browser = { evaluate: async (_tabId: number, expression: string) => expression.endsWith('window.__fdcStage.describe()') ? view : expression.includes('__fdcStage.follow(') ? answer() : answer(), close() {} } as any;
  const stage = new Stage({ log: () => {}, browser, record: action => { actions.push(action); return `action-${actions.length}`; } });
  stage.tabId = 7;
  return { stage, actions };
}

test('every command run on the page is recorded with who asked, why, what the page answered, and where the page and the ring were before and after', async () => {
  let reply: unknown = { said: ['heading in "Options": Options — Three ways forward', 'item in "Options": FDC'], before: place('section "Intro"', null), here: place('section "Options"', 'FDC') };
  const { stage, actions } = staged(() => reply);
  await stage.describe();
  const ran = await stage.run(['goto_options', 'row_fdc'], { by: 'jev', because: { said: 'Here are the options, starting with FDC.', jevCall: 'call-1', step: 0 } });
  assert.equal(ran.action, 'action-1', "the run names its record, for what GPT Live is then told");
  const { ms, ...first } = actions[0];
  assert.deepEqual(first, { by: 'jev', because: { said: 'Here are the options, starting with FDC.', jevCall: 'call-1', step: 0 }, tabId: 7,
    commands: [{ id: 'goto_options', say: 'Go to the section "Options"', outcome: 'ran', answer: 'heading in "Options": Options — Three ways forward' }, { id: 'row_fdc', say: 'Highlight the row "FDC"', outcome: 'ran', answer: 'item in "Options": FDC' }],
    before: { url: view.url, where: 'section "Intro"', ring: { on: false, at: null } }, after: { url: view.url, where: 'section "Options"', ring: { on: true, at: 'FDC' } } });
  // A command that fails: what ran before it, the failure with the page's error, and what was never reached.
  reply = { said: ['heading in "Options": Options'], error: 'No row "FDC" here', before: place('section "Intro"', null), here: place('section "Options"', null) };
  const failed = await stage.run(['goto_options', 'row_fdc', 'next_section'], { by: 'phrase', because: { said: 'the options' } }).catch(error => error);
  assert.ok(failed instanceof StageError && failed.action === 'action-2');
  assert.deepEqual(actions[1].commands!.map(c => [c.id, c.outcome, c.answer]), [['goto_options', 'ran', 'heading in "Options": Options'], ['row_fdc', 'failed', 'No row "FDC" here'], ['next_section', 'not reached', undefined]]);
  assert.deepEqual([actions[1].by, actions[1].error], ['phrase', 'No row "FDC" here']);
  // The page's own answer that there was nothing to do.
  reply = { said: [], limit: 'Already on the last section', before: place('section "Options"', null), here: place('section "Options"', null) };
  const nothing = await stage.run(['next_section']).catch(error => error);
  assert.ok(nothing instanceof StageNothing && nothing.action === 'action-3');
  assert.deepEqual(actions[2].commands, [{ id: 'next_section', say: 'Go to the next section', outcome: 'nothing to do', answer: 'Already on the last section' }]);
});

test('the ring following a sentence is recorded only when it moved; the agent\'s own browser tools on the stage\'s tab are recorded too', async () => {
  let reply: unknown = { on: 'FDC reply loops', score: .8, moved: true };
  const { stage, actions } = staged(() => reply);
  await stage.follow('The reply loops are doing the heavy lifting.');
  reply = { on: 'FDC reply loops', score: .8, moved: false };
  await stage.follow('Lots of posts in the reply loops.');
  assert.deepEqual(actions, [{ by: 'ring', because: { said: 'The reply loops are doing the heavy lifting.' }, tabId: 7, after: { ring: { on: true, at: 'FDC reply loops' } } }]);
  stage.observe({ tool: 'mcp__open-claude-in-chrome__javascript_tool', input: { tabId: 7, text: 'location.reload()' }, response: 'ok' });
  stage.observe({ tool: 'mcp__open-claude-in-chrome__javascript_tool', input: { tabId: 9, text: 'location.reload()' }, response: 'ok' });
  stage.observe({ tool: 'Bash', input: { command: 'ls' }, response: '' });
  assert.deepEqual(actions.slice(1), [{ by: 'agent', tabId: 7, because: { tool: 'mcp__open-claude-in-chrome__javascript_tool', input: { tabId: 7, text: 'location.reload()' } } }], 'only what acts on the tab on stage');
  stage.observe({ tool: 'mcp__open-claude-in-chrome__navigate', input: { tabId: 9, url: 'http://localhost/c.html' }, response: 'Navigated' });
  assert.deepEqual([actions.at(-1)!.by, actions.at(-1)!.tabId, actions.at(-1)!.commands![0].id], ['agent', 9, 'tab_9'], 'the agent putting another tab on the stage');
});

test('the record is one owner-only file beside the run\'s events, and holds what GPT Live was told about each move, word for word', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-page-audit-')), file = path.join(dir, 'page.jsonl');
  const audit = new PageAudit({ file, clean: text => text.replace('secret', '[redacted]') });
  const id = audit.action({ by: 'operator', tabId: 7, after: { where: 'the secret section' } });
  audit.told('The operator moved the page themselves; they are looking at the secret section.', id);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(l => [l.type, l.id ?? l.action]), [['action', id], ['told', id]]);
  assert.equal(lines[0].after.where, 'the [redacted] section');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // Through fdc itself: the voice's sentence, Jev's choice, the page's answer, and what the voice then hears.
  const { h } = await harness(t);
  fakeJev(h, m => m.trigger === 'cue' ? { id: 'jev-call-7', page: pageReading({ command: 'goto_options', more: 0 }) } : {});
  h.stage.browser = { evaluate: async (_tabId: number, expression: string) => expression.endsWith('window.__fdcStage.describe()') ? view
    : { said: ['heading in "Options": Options — Three ways forward'], before: place('section "Intro"', null), here: place('section "Options"', 'Options') }, close() {} } as any;
  h.stage.tabId = 7;
  await h.presenter.show('Here are the options.');
  // What the voice hears follows once the page has been read again.
  await until(() => fs.readFileSync(path.join(h.runDir, 'page.jsonl'), 'utf8').includes('"type":"told"'));
  const recorded = fs.readFileSync(path.join(h.runDir, 'page.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const action = recorded.find(l => l.type === 'action');
  assert.deepEqual([action.by, action.because, action.commands[0].id, action.commands[0].answer, action.after.where],
    ['jev', { said: 'Here are the options.', jevCall: 'jev-call-7', step: 0 }, 'goto_options', 'heading in "Options": Options — Three ways forward', 'section "Options"']);
  const told = recorded.find(l => l.type === 'told');
  assert.equal(told.action, action.id);
  assert.match(told.text, /^You moved the page; on screen now: heading in "Options": Options — Three ways forward/);
});

test("each step of a move reaches the voice and Jev's next reading; the voice saying it can't answer has the operator's kept words read again", async t => {
  const { h, lives } = await harness(t);
  const moments = fakeJev(h, m => m.trigger === 'cue' ? { page: pageReading({ command: 'goto_options', more: .9, gaveUp: /can't find/.test(m.latest!.text) ? .9 : .1 }) }
    : m.trigger === 'step' ? { page: pageReading({ command: 'row_fdc', more: 0 }) } : {});
  const answers = ['heading : Options — Three ways forward. Under it: FDC; Editor.', 'item in "Options": FDC — 231 reply loops'];
  let ran = 0;
  h.stage.browser = { evaluate: async (_tabId: number, expression: string) => expression.endsWith('window.__fdcStage.describe()') ? view
    : { said: [answers[ran++ % 2]], before: place('section "Intro"', null), here: place('section "Options"', 'FDC') }, close() {} } as any;
  h.stage.tabId = 7;
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  let reconsidered = 0; h.mediator!.reconsider = () => { reconsidered++; };
  await h.presenter.show('Here are the options, starting with FDC.');
  const step = moments.find(m => m.trigger === 'step')!;
  assert.deepEqual(step.done!.map(c => [c.id, c.shown]), [['goto_options', answers[0]]], 'Jev chooses the next step knowing what the first one landed on');
  const told = () => lives[0].appended.filter(([kind, text]) => kind === 'thinking' && /^(The page is on its way|You moved the page)/.test(text)).map(([, text]) => text);
  await until(() => told().length === 2);
  assert.equal(told()[0], `The page is on its way; it has reached: ${answers[0]}`, 'a step on the way, in short');
  assert.match(told()[1], /^You moved the page; on screen now: item in "Options": FDC — 231 reply loops/);
  assert.equal(reconsidered, 0);
  await h.presenter.show("I can't find the March numbers on this page.");
  assert.equal(reconsidered, 1, 'the words that stayed with the voice are read again for the agent');
});
