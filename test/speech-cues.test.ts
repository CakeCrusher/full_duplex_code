// GPT Live's own words move the page: cue words in its transcript run stage commands (speech-cues.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CueMatcher, cueWords } from '../src/core/speech-cues.ts';
import { Stage, type StageView } from '../src/core/stage.ts';

const view: StageView = { tabId: 1, title: 'Deck', url: 'http://localhost/d.html', about: null, where: '', outline: '',
  commands: [
    { id: 'goto_sessions', say: 'Go to the section "sessions"', name: 'sessions', top: true },
    { id: 'goto_system_map', say: 'Go to the section "system map"', name: 'system map', top: true },
    { id: 'goto_map', say: 'Go to the section "map"', name: 'map', top: true },
    { id: 'goto_detail', say: 'Go to the heading "Detail"', name: 'Detail' },
    { id: 'show_my_recommendation', say: 'Show and highlight: my recommendation', name: 'my recommendation' },
    { id: 'page_next_slide', say: 'Go to the next slide' },
    { id: 'page_slide_2', say: 'Go to slide 2: "Margins"', name: 'Margins' },
  ],
  cues: [{ say: 'Next slide', run: 'next_slide' }, { say: 'Missing', run: 'not_a_command' }] };

test('cues: section and annotation names after a turning phrase, and the page\'s own phrases', () => {
  const cues = Stage.cues(view);
  assert.deepEqual(cues.map(c => `${c.run}:${c.words.join(' ')}:${c.name ?? false}`), [
    'goto_sessions:sessions:true', 'goto_system_map:system map:true', 'goto_map:map:true', 'show_my_recommendation:recommendation:true', 'page_slide_2:margins:true', 'page_next_slide:next slide:false']);
  assert.deepEqual(cueWords("The Options!"), ['options']);
});

const spoken = (matcher: CueMatcher, deltas: string[]) => { let at = 1000; return deltas.flatMap(d => matcher.hear(d, at += 200).map(c => c.run)); };

test('a name moves the page only after a turning phrase, once, as soon as its last word is complete', () => {
  const m = new CueMatcher(); m.set(Stage.cues(view));
  assert.deepEqual(spoken(m, [' Our', ' sessions', ' showed', ' a lot.', ' Now', " let's", ' look', ' at', ' the', ' sess', 'ions', ' section', ',']), ['goto_sessions'],
    'mentioning sessions moves nothing; "let\'s look at the sessions" does, once the word is whole');
  assert.deepEqual(spoken(m, [' and', ' the', ' sessions', ' again.']), [], 'the same cue does not fire again for later words');
  assert.deepEqual(spoken(m, [" Let's", ' go', ' back', ' to', ' the', ' system', ' map.']), ['goto_system_map'], 'the longer name wins');
  assert.deepEqual(spoken(m, [' Claude', ' will', ' look', ' at', ' the', ' sessions', ' code', ' next.']), [], "relaying the agent's work moves nothing");
  assert.deepEqual(spoken(m, [" Let's", ' go', ' to', ' the', ' next', ' slide.']), ['page_next_slide'], "the page's own phrase, after let's");
  assert.deepEqual(spoken(m, [' Claude', ' is', ' adding', ' a', ' next', ' slide', ' button.']), [], 'talking about a next slide moves nothing');
  assert.deepEqual(spoken(m, [" Let's", ' look', ' at', ' your', ' recommendation', ' here.']), ['show_my_recommendation'], 'my and your are the same name');
  assert.deepEqual(spoken(m, [" Let's", ' look', ' the', ' sessions', ' part.']), ['goto_sessions'], 'loosely said');
  assert.deepEqual(spoken(m, [' Now', ' the', ' sessions', ' parser', ' is', ' fixed.']), [], 'narrating work moves nothing');
});

test('a new response starts fresh after a pause', () => {
  const m = new CueMatcher(); m.set(Stage.cues(view));
  assert.deepEqual(m.hear(" Let's look at sessions.", 1000).map(c => c.run), ['goto_sessions']);
  assert.deepEqual(m.hear(" Let's look at sessions.", 1500).map(c => c.run), ['goto_sessions'], 'said again in the same response, it moves again');
  assert.deepEqual(m.hear(" Let's look at sessions.", 9000).map(c => c.run), ['goto_sessions']);
});

test("the operator's latest words that the voice answered by moving the page are noted for the agent, and still judged", async () => {
  const { VoiceHistory } = await import('../src/core/voice-history.ts');
  const h = new VoiceHistory();
  const say = (delta: string, start_ms: number, end_ms: number) => h.add({ type: 'session.input_transcript.delta', delta, start_ms, end_ms });
  say('Fix the parser.', 0, 900);
  h.markDelivered(h.request(1000)!);
  say('Um, take me', 5000, 5600); say(' to the options.', 5700, 6400);
  assert.equal(h.cueLatest('moved'), 2);
  const request = h.request(Infinity)!;
  assert.deepEqual(request.notes, ['moved']); assert.equal(request.cued, true);
  assert.equal(request.fresh, 'Um, take me to the options.', 'the gate still judges them: the move may have been all they asked');
});

test('the gate moves nothing again for words the voice moved the page for; only the page asked for, nothing goes to the agent', async t => {
  const { harness } = await import('./live-fake.ts');
  const { h } = await harness(t);
  const runs: string[][] = [];
  let page = { steps: ['goto_sessions'], only: .9, work: 0, count: 1 };
  h.stage = { describe: async () => view, run: async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; }, view, observe() {}, close() {} } as any;
  h.handOffAudit = { judge: async () => ({ needsAgent: .2, sessions: { asked: 0, only: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0, page }) } as any;
  const only = await h.sessionSwitch.gate('take me to the sessions', 'r1', undefined, undefined, true);
  assert.equal(only.page, true); assert.match(only.handled!, /you already moved the page as you spoke/);
  page = { steps: ['goto_sessions'], only: .1, work: .9, count: 1 };
  const more = await h.sessionSwitch.gate('show me the sessions and fix the typo', 'r2', undefined, undefined, true);
  assert.equal(more.handled, undefined); assert.equal(more.note, undefined, 'the request already carries the cue note');
  assert.deepEqual(runs, [], 'nothing ran twice');
  await h.sessionSwitch.gate('take me to the sessions', 'r3');
  assert.deepEqual(runs, [['goto_sessions']], 'without a cue, the gate moves the page');
});
