// The page follows what the voice says (presenter.ts): each sentence it says, bare acknowledgments aside, asks Jev which
// command shows what it is talking about and whether another must follow; a part's own controls are offered once that
// part is on screen. The operator's goal is kept apart from the page (voice-sessions.ts), and where they move the page
// themselves reaches the voice (watchViewer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { StageNothing, type StageView } from '../src/core/stage.ts';
import { fakeJev, harness, page, settle, turn, until } from './live-fake.ts';

const top: StageView = { tabId: 1, title: 'Audience map', url: 'http://localhost/m.html', about: null, where: 'section "The map"', parts: [],
  focus: { path: ['The map'], step: { index: 1, total: 3, of: 'section' } },
  commands: [
    { id: 'goto_map', say: 'Go to the section "The map"', name: 'The map', top: true },
    { id: 'goto_matrix', say: 'Go to the section "Projects by approaches"', name: 'Projects by approaches', top: true },
    { id: 'goto_waves', say: 'Go to the section "FDC waves"', name: 'FDC waves', top: true },
    { id: 'back', say: 'Go back to wherever the viewer was just before the last move' },
  ] };
// Once the waves are on screen, their own control is offered too (a part's controls: stage-page.js).
const waves: StageView = { ...top, where: 'section "FDC waves"', focus: { path: ['FDC waves'], step: { index: 3, total: 3, of: 'section' } },
  commands: [...top.commands, { id: 'page_split_campaigns', say: 'Split the FDC row into its campaigns' }] };

/** A stage whose page offers the waves' own control once the waves are shown; every run is recorded with whether it was a step on the way. */
function stageOf(h: any, { nothing = new Set<string>() } = {}) {
  let at = top;
  const runs: { ids: string[]; fast: boolean }[] = [];
  h.stage = { tabId: 1, pages: new Map(), get view() { return at; }, describe: async () => at,
    run: async (ids: string[], { fast = false } = {}) => {
      runs.push({ ids, fast });
      if (nothing.has(ids[0])) throw new StageNothing('nothing to do there', [], '', { id: ids[0], say: ids[0] });
      if (ids[0] === 'goto_waves') at = waves;
      const done = ids.map(id => at.commands.find(c => c.id === id)!);
      return { done, onScreen: ids[0] === 'page_split_campaigns' ? 'FDC split into five rows: before the loop, waves one to four.' : `at ${ids[0]}`, here: { url: at.url, where: at.where, focus: at.focus, viewerAt: 0 } };
    }, follow: async () => null, here: async () => undefined, observe() {}, close() {} };
  return runs;
}
const thinking = (live: any) => live.appended.filter(([kind]: string[]) => kind === 'thinking').map(([, text]: string[]) => text);

test("the page follows the voice's words, not only turning phrases: \"getting you there\" moves it; an acknowledgment asks nothing; the operator's words move nothing", async t => {
  const { h, lives } = await harness(t);
  const runs = stageOf(h);
  const moments = fakeJev(h, m => m.trigger === 'cue' ? { page: /getting you there/.test(m.latest!.text) ? { command: 'goto_matrix', more: .1 } : {} } : m.trigger === 'job' ? { needsAgent: .1 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  await turn(h, 'Take me to the projects by approaches.');
  assert.deepEqual(runs, [], "the operator's words move nothing");
  h.presenter.heard(' Okay.'); h.presenter.heard(' One sec.');
  await settle(50);
  assert.ok(!moments.some(m => m.trigger === 'cue'), 'a bare acknowledgment shows nothing, so Jev is not asked');
  h.presenter.heard(' Sure, getting you there.');
  await until(() => runs.length === 1);
  assert.deepEqual(runs[0], { ids: ['goto_matrix'], fast: false });
  const asked = moments.find(m => m.trigger === 'cue')!;
  assert.equal(asked.latest!.text, 'Sure, getting you there.');
  assert.ok(asked.page!.commands.some(c => c.id === 'goto_matrix'));
  await until(() => thinking(lives[0]).some((text: string) => /^You moved the page; on screen now: at goto_matrix \(The map, section 1 of 3\)/.test(text)));
});

test("a part's own control, offered once the part is on screen, runs as the next step: one command at a time until Jev wants no more, and the voice hears once", async t => {
  const { h, lives } = await harness(t);
  const runs = stageOf(h);
  const moments = fakeJev(h, m => m.trigger === 'cue' ? { page: { command: 'goto_waves', more: .8 } } : m.trigger === 'step' ? { page: m.page!.commands.some(c => c.id === 'page_split_campaigns') ? { command: 'page_split_campaigns', more: .1 } : {} } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const before = thinking(lives[0]).length;
  h.presenter.heard(' That button splits FDC into its five campaigns.');
  await until(() => runs.length === 2);
  assert.deepEqual(runs, [{ ids: ['goto_waves'], fast: true }, { ids: ['page_split_campaigns'], fast: false }], 'the step on the way only lands; the last one settles');
  const step = moments.find(m => m.trigger === 'step')!;
  assert.deepEqual(step.done!.map(c => c.id), ['goto_waves']);
  assert.ok(step.page!.commands.some(c => c.id === 'page_split_campaigns'), 'read again after the first command: the part offers its own');
  await until(() => thinking(lives[0]).some((text: string) => /^You moved the page; on screen now: FDC split into five rows/.test(text)));
  await settle(50);
  assert.equal(thinking(lives[0]).slice(before).filter((text: string) => text.startsWith('You moved the page')).length, 1, 'told once, what the last step shows');
  assert.equal(moments.filter(m => m.trigger === 'step').length, 1, 'no more asked once Jev wants none');
});

test('a command that has nothing to do gives way to the next likeliest: "back" with nothing to go back to shows the map', async t => {
  const { h, lives } = await harness(t);
  const runs = stageOf(h, { nothing: new Set(['back']) });
  fakeJev(h, m => m.trigger === 'cue' ? { page: { command: 'back', more: 0, likely: { back: .55, goto_map: .3, none: .15 } } } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  h.presenter.heard(" Sure, let's look at the main map again.");
  await until(() => runs.length === 2);
  assert.deepEqual(runs.map(r => r.ids[0]), ['back', 'goto_map']);
  await until(() => thinking(lives[0]).some((text: string) => /^You moved the page; on screen now: at goto_map/.test(text)));
  assert.ok(!thinking(lives[0]).some((text: string) => /The page didn't move/.test(text)), 'it moved: no "nothing to do" for the voice');
});

test("Jev failing moves nothing and sends the agent nothing about the page", async t => {
  const { h } = await harness(t);
  const runs = stageOf(h);
  fakeJev(h, m => { if (m.trigger === 'cue') throw new Error('Jev returned HTTP 503'); return {}; });
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  h.voiceSessions.live!.emit('event', { type: 'session.input_transcript.delta', delta: 'Show me the waves.', start_ms: 0, end_ms: 800 });
  h.presenter.heard(' Here are the waves.');
  await settle(100);
  assert.deepEqual(runs, []);
  assert.ok(!h.voiceSessions.mediator!.history.request()?.notes?.length, 'no failed-controls note for the agent');
});

test("the operator's goal is kept apart from the page: set from their words, told to the voice, read by Jev with what was shown, kept across sessions, ended when they drop it", async t => {
  const { h, lives } = await harness(t);
  stageOf(h);
  const moments = fakeJev(h, m => {
    if (m.trigger === 'turn') return { standby: 0, goal: /walk me through/i.test(m.latest!.text) ? { choice: 'new' as const, p: .9 } : /enough/.test(m.latest!.text) ? { choice: 'done' as const, p: .8 } : { choice: 'keep' as const, p: .9 } };
    if (m.trigger === 'cue') return { page: /grid/.test(m.latest!.text) ? { command: 'goto_matrix', more: 0 } : {} };
    return { needsAgent: .1 };
  });
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  await turn(h, 'Walk me through the projects by approach.');
  assert.equal(h.voiceSessions.goal?.text, 'Walk me through the projects by approach.');
  await until(() => thinking(lives[0]).some((text: string) => text.startsWith(`The operator's goal now (this replaces any goal you were told before): "Walk me through the projects by approach."`)));
  h.presenter.heard(" Here's the grid of projects against approaches.");
  await until(() => h.voiceSessions.goal?.shown.length === 1);
  assert.deepEqual(h.voiceSessions.goal!.shown, ['The map, section 1 of 3'], 'where the page then was');
  await turn(h, 'What does the third column mean?');
  assert.match(moments.at(-1)!.goal!, /^"Walk me through the projects by approach\." \(asked \d+ s ago\); shown for it since: The map, section 1 of 3$/);
  assert.ok(h.voiceSessions.goal, 'a question within the goal keeps it');
  // A new voice session hears the goal at its start.
  await h.live!.close('operator ended voice');
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  await until(() => lives[1] && thinking(lives[1]).some((text: string) => text.startsWith("The operator's goal now")));
  await turn(h, "Okay, that's enough of that.");
  assert.equal(h.voiceSessions.goal, undefined);
  await until(() => thinking(lives[1]).some((text: string) => text.startsWith('The operator has no goal for you to keep to now')));
});

test('where the operator moves the page themselves reaches the voice once they stop, once', async t => {
  const { h, lives } = await harness(t);
  stageOf(h);
  let here: any = { url: 'http://localhost/m.html', where: 'section "The map"', viewerAt: 0 };
  h.stage.here = async () => here;
  fakeJev(h);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const run = (h.voiceSessions as any).run;
  const told = () => thinking(lives[0]).filter((text: string) => text.startsWith('The operator moved the page themselves'));
  await h.voiceSessions.viewer(run);
  assert.equal(told().length, 0, 'not moved by them');
  here = { ...here, where: 'section "Hotspots"', focus: { path: ['Hotspots'], step: { index: 2, total: 3, of: 'section' } }, viewerAt: Date.now() - 300 };
  await h.voiceSessions.viewer(run);
  assert.equal(told().length, 0, 'still moving');
  here = { ...here, viewerAt: Date.now() - 2000 };
  await h.voiceSessions.viewer(run);
  await until(() => told().length === 1);
  assert.equal(told()[0], 'The operator moved the page themselves; they are looking at section "Hotspots" (Hotspots, section 2 of 3).');
  await h.voiceSessions.viewer(run);
  assert.equal(told().length, 1, 'told once');
});
