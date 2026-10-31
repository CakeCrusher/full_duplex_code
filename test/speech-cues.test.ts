// GPT Live's own words move the page: cue words in its transcript run stage commands (speech-cues.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CueMatcher, cueWords } from '../src/core/speech-cues.ts';
import { Stage, type StageView } from '../src/core/stage.ts';

const view: StageView = { tabId: 1, title: 'Deck', url: 'http://localhost/d.html', about: null, where: '', parts: [],
  commands: [
    { id: 'goto_sessions', say: 'Go to the section "sessions"', name: 'sessions', top: true },
    { id: 'goto_system_map', say: 'Go to the section "system map"', name: 'system map', top: true },
    { id: 'goto_map', say: 'Go to the section "map"', name: 'map', top: true },
    { id: 'goto_detail', say: 'Go to the heading "Detail"', name: 'Detail' },
    { id: 'show_my_recommendation', say: 'Show and highlight: my recommendation', name: 'my recommendation' },
    { id: 'page_next_slide', say: 'Go to the next slide' },
    { id: 'page_previous_slide', say: 'Go to the previous slide' },
    { id: 'page_slide_2', say: 'Go to slide 2: "Margins"', name: 'Margins' },
    { id: 'page_slide_3', say: 'Go to slide 3', name: 'Highlighting: after a move' },
  ] };

test("cues: the page's own names first, then section and annotation names, and a titled name's title", () => {
  const cues = Stage.cues(view);
  assert.deepEqual(cues.filter(c => c.listed).map(c => `${c.run}:${c.words.join(' ')}`), [
    'page_slide_2:margins', 'page_slide_3:highlighting after a move', 'goto_sessions:sessions', 'goto_system_map:system map', 'goto_map:map', 'show_my_recommendation:recommendation'], 'the names the voice is told');
  assert.deepEqual(cues.filter(c => !c.listed).map(c => `${c.run}:${c.label}`), ['page_slide_3:after a move'], 'the title alone, not told');
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
  assert.deepEqual(spoken(m, [" Let's", ' go', ' to', ' the', ' next', ' slide.']), [], "next and back are no names: Jev finds the page's step (presenter.ts)");
  assert.deepEqual(spoken(m, [" Let's", ' look', ' at', ' after', ' a', ' move.']), ['page_slide_3'], "a titled name's title alone");
  assert.deepEqual(spoken(m, [' Okay,', ' now', " we're", ' on', ' the', ' system', ' map.']), ['goto_system_map'], "now we're on");
  assert.deepEqual(spoken(m, [' In', ' your', ' words,', " “let's", ' look', ' at', ' the', ' system', ' map”.']), [], 'quoting the page or the operator moves nothing');
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
  h.markDelivered(h.request()!);
  say('Um, take me', 5000, 5600); say(' to the options.', 5700, 6400);
  assert.equal(h.cueLatest('moved'), 2);
  const request = h.request()!;
  assert.deepEqual(request.notes, ['moved']); assert.equal(request.cued, true);
  assert.equal(request.fresh, 'Um, take me to the options.', 'their turn is still read: the move may have been all they asked');
  say('Highlight your recommendation.', 12000, 13000);
  const next = h.request()!;
  assert.equal(next.fresh, 'Highlight your recommendation.'); assert.equal(next.cued, undefined, 'words a cue answered earlier leave newer words to their turn');
  assert.deepEqual(next.notes, ['moved'], 'though the note still goes with the earlier words');
});

test("the voice moves the page: a part's name at once, other turning words through Jev, and never the operator's words", async t => {
  const { harness, page, until, fakeJev, pageReading, turn } = await import('./live-fake.ts');
  const { h, lives } = await harness(t);
  const runs: string[][] = [];
  h.stage = { tabId: 1, view, pages: new Map(), describe: async () => view, run: async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: `at ${ids[0]}` }; }, follow: async () => null, observe() {}, close() {} } as any;
  const moments = fakeJev(h, m => m.trigger === 'cue' ? { page: pageReading({ command: 'page_next_slide' }) } : m.trigger === 'job' ? { needsAgent: .1 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  h.presenter.speechCues.set(Stage.cues(view));
  await turn(h, 'take me to the sessions');
  assert.deepEqual(runs, [], "the operator's words move nothing");
  h.presenter.heard(" Let's look at the sessions.");
  await until(() => runs.length === 1);
  assert.deepEqual(runs[0], ['goto_sessions']);
  await until(() => lives[0].appended.some(([kind, text]) => kind === 'thinking' && /You moved the page; on screen now: at goto_sessions/.test(text)));
  h.presenter.heard(" Let's go to the next slide.");
  await until(() => runs.length === 2);
  assert.deepEqual(runs[1], ['page_next_slide'], 'no name: Jev finds the command for what the voice meant');
  assert.ok(moments.some(m => m.trigger === 'cue' && /next slide/.test(m.latest!.text)));
  h.presenter.heard(" Let's move on to the next one.");
  await until(() => runs.length === 3);
});

test("where the voice turns and the page can't go: its answer is the voice's to hear, a failure goes to the agent with the operator's words, and nothing found is said", async t => {
  const { harness, page, until, fakeJev, pageReading } = await import('./live-fake.ts');
  const { StageNothing } = await import('../src/core/stage.ts');
  const { h, lives } = await harness(t);
  let fail: Error | undefined;
  h.stage = { tabId: 1, view, pages: new Map(), describe: async () => view, run: async () => { if (fail) throw fail; return { done: [], onScreen: '' }; }, follow: async () => null, observe() {}, close() {} } as any;
  fakeJev(h, m => m.trigger === 'cue' ? { page: pageReading(/error bars/.test(m.latest!.text) ? {} : { command: 'page_next_slide' }) } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  h.presenter.speechCues.set(Stage.cues(view));
  const thinking = () => lives[0].appended.filter(([kind]) => kind === 'thinking').map(([, text]) => text).join('\n');
  fail = new StageNothing('Already on the last slide', [], '', { id: 'page_next_slide', say: 'Go to the next slide' });
  h.presenter.heard(" Let's go to the next slide.");
  await until(() => /The page didn't move: "Already on the last slide"/.test(thinking()));
  h.voiceSessions.live!.emit('event', { type: 'session.input_transcript.delta', delta: 'Show me the margins.', start_ms: 0, end_ms: 800 });
  fail = new Error('fdcController.run: no element #m');
  h.presenter.heard(" Let's look at Margins.");
  await until(() => h.voiceSessions.mediator!.history.request()?.notes?.some(note => /controls failed: fdcController\.run: no element #m\. Fix the page's controller/.test(note)));
  fail = undefined;
  h.presenter.heard(" Let's look at the error bars.");
  await until(() => /The page has nothing for "the error bars"; it didn't move\./.test(thinking()));
});

test("GPT Live is briefed on the page once it can be read: a new tab's blank page is read again shortly", async t => {
  const { harness, page } = await import('./live-fake.ts');
  const { h, lives } = await harness(t);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  let reads = 0;
  h.stage.tabId = 1; h.stage.describe = (async () => { if (reads++ === 0) throw new Error('javascript_tool failed: Cannot access a chrome:// URL'); return view; }) as any;
  await h.voiceSessions.briefStage();
  assert.ok(!lives[0].appended.some(([, text]) => /The page open beside the operator now/.test(text)), 'not yet');
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.ok(lives[0].appended.some(([kind, text]) => kind === 'thinking' && /The page open beside the operator now \(this replaces any page you were told about before\): "Deck"/.test(text)), 'briefed on the second read');
  assert.ok(reads >= 2);
});
