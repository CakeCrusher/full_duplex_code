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
  ],
  cues: [{ say: 'Next slide', run: 'next_slide' }, { say: 'Missing', run: 'not_a_command' }] };

test('cues: section and annotation names after a turning phrase, and the page\'s own phrases', () => {
  const cues = Stage.cues(view);
  assert.deepEqual(cues.map(c => `${c.run}:${c.words.join(' ')}:${c.name ?? false}`), [
    'goto_sessions:sessions:true', 'goto_system_map:system map:true', 'goto_map:map:true', 'show_my_recommendation:recommendation:true', 'page_next_slide:next slide:false']);
  assert.deepEqual(cueWords("The Options!"), ['options']);
});

const spoken = (matcher: CueMatcher, deltas: string[]) => { let at = 1000; return deltas.flatMap(d => matcher.hear(d, at += 200).map(c => c.run)); };

test('a name moves the page only after a turning phrase, once, as soon as its last word is complete', () => {
  const m = new CueMatcher(); m.set(Stage.cues(view));
  assert.deepEqual(spoken(m, [' Our', ' sessions', ' showed', ' a lot.', ' Now', " let's", ' look', ' at', ' the', ' sess', 'ions', ' section', ',']), ['goto_sessions'],
    'mentioning sessions moves nothing; "let\'s look at the sessions" does, once the word is whole');
  assert.deepEqual(spoken(m, [' and', ' the', ' sessions', ' again.']), [], 'the same cue does not fire again for later words');
  assert.deepEqual(spoken(m, [' Back', ' to', ' the', ' system', ' map.']), ['goto_system_map'], 'the longer name wins');
  assert.deepEqual(spoken(m, [' Next', ' slide', ' please.']), ['page_next_slide'], "the page's own phrase needs no turning words");
  assert.deepEqual(spoken(m, [' Look', ' at', ' your', ' recommendation', ' here.']), ['show_my_recommendation'], 'my and your are the same name');
});

test('a new response starts fresh after a pause', () => {
  const m = new CueMatcher(); m.set(Stage.cues(view));
  assert.deepEqual(m.hear(" Let's look at sessions.", 1000).map(c => c.run), ['goto_sessions']);
  assert.deepEqual(m.hear(" Let's look at sessions.", 1500).map(c => c.run), ['goto_sessions'], 'said again in the same response, it moves again');
  assert.deepEqual(m.hear(" Let's look at sessions.", 9000).map(c => c.run), ['goto_sessions']);
});
