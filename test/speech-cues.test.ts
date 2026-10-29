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
  assert.equal(Stage.next(view), 'page_next_slide', "the page's own next step, for pacing a walkthrough");
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
  assert.deepEqual(spoken(m, [" Let's", ' go', ' to', ' the', ' next', ' slide.']), [], "next and back are the operator's to ask: the voice tool takes them from their words");
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

test('the turn moves nothing again for words the voice moved the page for; only the page asked for, nothing goes to the agent', async t => {
  const { harness, fakeJev, pageReading, turn } = await import('./live-fake.ts');
  const { h } = await harness(t);
  const runs: string[][] = [];
  let page = pageReading({ command: 'goto_sessions', only: .9 });
  h.stage = { describe: async () => view, run: async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; }, view, observe() {}, close() {} } as any;
  // The job delegation finds work only where they ask for some.
  fakeJev(h, moment => moment.trigger === 'job' ? { needsAgent: /fix/.test(moment.latest!.text) ? .9 : .2 } : { sessions: { asked: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0, page: moment.trigger === 'step' ? pageReading() : page });
  const only = await turn(h, 'take me to the sessions', { cued: true });
  assert.equal(only.send, false);
  page = pageReading({ command: 'goto_sessions', only: .1 });
  const more = await turn(h, 'show me the sessions and fix the typo', { cued: true });
  assert.equal(more.send, true);
  assert.deepEqual(runs, [], 'nothing ran twice');
  await turn(h, 'take me to the sessions');
  assert.deepEqual(runs, [['goto_sessions']], 'without a cue, the turn moves the page');
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

test('a walkthrough asked for: the first part shows, and each time the voice finishes one and goes quiet, the page moves on; the operator speaking ends it', async t => {
  const { harness, page, until } = await import('./live-fake.ts');
  const { h, lives } = await harness(t);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  let slide = 3; const runs: string[][] = [];
  const deck = (): StageView => ({ ...view, where: `Slide ${slide} of 5`, commands: [{ id: 'page_next', say: 'Go to the next slide' }, { id: 'page_slide_3', say: 'Go to slide 3', name: 'Margins' }] });
  h.stage = { describe: async () => deck(), run: async (ids: string[]) => { runs.push(ids); if (ids[0] === 'page_next' && slide < 5) slide++; return { done: [], onScreen: `Slide ${slide} of 5` }; }, follow: async () => null, view: deck(), observe() {}, close() {} } as any;
  const { fakeJev, pageReading } = await import('./live-fake.ts');
  fakeJev(h, moment => moment.trigger === 'job' ? { needsAgent: .1 } : { sessions: { asked: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0, page: pageReading({ command: 'page_slide_3', only: .8, walk: .9 }) });
  h.presenter.walkQuietMs = 50;
  const { turn } = await import('./live-fake.ts');
  const walked = await turn(h, 'walk me through the rest');
  assert.deepEqual([walked.send, walked.moved], [false, true]);
  await until(() => lives[0].appended.some(([kind, text]) => kind === 'commentary' && /The operator asked to be walked through the page, and the voice tool paces it.*Slide 3 of 5.*Present this part/.test(text)));
  assert.deepEqual(runs, [['page_slide_3']]);
  const commentary = () => lives[0].appended.filter(([kind, text]) => kind === 'commentary' && /The page moved on/.test(text)).map(([, text]) => text);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(runs, [['page_slide_3']], 'nothing moves before the voice has presented the part');
  h.presenter.heard('Margins are up three points. ');
  await until(() => commentary().length === 1);
  assert.match(commentary()[0], /Slide 4 of 5.*Present it in a few sentences/);
  h.presenter.heard('Costs fell. ');
  await until(() => commentary().length === 2);
  h.presenter.heard('That is the last one. ');
  await until(() => !h.presenter.walking);
  assert.equal(slide, 5); assert.equal(commentary().length, 2, 'the last part ends it: a step that goes nowhere is not presented');
  // Asked again, and the operator speaks up meanwhile: it stops.
  slide = 3; await turn(h, 'walk me through the rest');
  h.voiceSessions.mediator!.history.lastInputAt = Date.now() + 10000;
  await until(() => !h.presenter.walking);
});

test("GPT Live's delegation moves the page for the operator's words; its own words in that answer move nothing again, nor does asking again", async t => {
  const { harness, page, until, fakeJev, pageReading } = await import('./live-fake.ts');
  const { h, lives } = await harness(t);
  // Jev is there before voice starts, as it is when fdc starts with a TypeSafe key.
  fakeJev(h);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const runs: string[][] = [], judged: string[] = [], jobs: string[] = [];
  const deck: StageView = { ...view, where: 'Slide 24', commands: [{ id: 'page_next', say: 'Go to the next slide' }, { id: 'page_slide_27', say: 'Go to slide 27', name: 'One highlight at a time' }] };
  h.stage = { tabId: 1, view: deck, describe: async () => deck, run: async (ids: string[]) => { runs.push(ids); return { done: [{ id: ids[0], say: 'Go to the next slide' }], onScreen: 'Slide 25: Moving the page by voice' }; }, follow: async () => null, observe() {}, close() {} } as any;
  const read = { sessions: { asked: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0 };
  fakeJev(h, ({ trigger, latest, done }) => {
    if (trigger === 'step') return { page: pageReading() };
    if (trigger === 'job') { jobs.push(latest!.text); return { needsAgent: .3 }; }
    const said = latest!.text; judged.push(said);
    // As Jev is asked: what already ran for these words is done.
    return { ...read, page: /continue/i.test(said) && !done?.length ? pageReading({ command: 'page_next', only: .7, walk: .2 }) : pageReading({ only: .1 }) };
  });
  h.voiceSessions.mediator!.operatorQuietMs = 30;
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: "Okay, let's continue.", start_ms: 0, end_ms: 900 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } });
  await until(() => runs.length === 1);
  await until(() => lives[0].appended.some(([kind, text]) => kind === 'thinking' && /The voice tool moved the page; on screen now: Slide 25/.test(text)));
  // The voice then answers, naming the slide it wrongly thinks comes next, and asks the voice tool to act again.
  live.emit('event', { type: 'session.output_transcript.delta', delta: " Let's look at one highlight at a time. " });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd2', target: 'client' } });
  await until(() => lives[0].appended.some(([kind, text]) => kind === 'thinking' && /Nothing changed on the page/.test(text)));
  assert.deepEqual(runs, [['page_next']], "one move, once: not again for GPT Live's asking, nor for the voice's words in that answer");
  assert.equal(judged.filter(said => /continue/.test(said)).length, 2, 'asked twice, read twice: the second knows what ran');
  // Words GPT Live doesn't ask the voice tool about are read by it as their turn ends: asking nothing of the page, they
  // move nothing.
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Fix the parser.', start_ms: 5000, end_ms: 6000 });
  await until(() => jobs.includes('Fix the parser.'));
  assert.equal(runs.length, 1); assert.ok(judged.includes('Fix the parser.'));
});

test("a part's last step goes on to the next section; a backchannel doesn't end the operator's turn; a complaint the page can't answer reaches the agent", async t => {
  const { harness, page, until, fakeJev, pageReading } = await import('./live-fake.ts');
  const wait = <T>(label: string, check: () => T) => until(check).catch(error => { throw new Error(`${label}: ${error.message}`); });
  const { h, lives } = await harness(t);
  fakeJev(h);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const runs: string[][] = [], jobs: string[] = [];
  const box: StageView = { ...view, where: 'Step 3 of 3', commands: [{ id: 'page_next_step', say: 'Next step in the box' }, { id: 'next_section', say: 'Go to the next section' }] };
  const { StageNothing } = await import('../src/core/stage.ts');
  h.stage = { tabId: 1, view: box, describe: async () => box, run: async (ids: string[]) => {
    runs.push(ids);
    if (ids[0] === 'page_next_step') throw new StageNothing('Already on the last step', [], '', { id: 'page_next_step', say: 'Next step in the box' });
    return { done: [{ id: ids[0], say: 'Go to the next section' }], onScreen: 'Section 4. Your code owns the workflow' };
  }, follow: async () => null, observe() {}, close() {} } as any;
  const read = { sessions: { asked: 0, unlisted: 0, turnOn: [], turnOff: [] }, companionOnly: 0 };
  const delivered: any[] = [];
  h.deliver = (request: any) => { delivered.push(request); };
  fakeJev(h, ({ trigger, latest }) => {
    if (trigger === 'step') return { page: pageReading() };
    const said = latest!.text;
    // The job delegation: a complaint about the page needs the agent.
    if (trigger === 'job') { jobs.push(said); return { needsAgent: /wrong/.test(said) ? .9 : .1, ready: .9 }; }
    return { ...read, page: /next/i.test(said) ? pageReading({ command: 'page_next_step', only: .8, walk: .1 }) : /wrong/.test(said) ? pageReading({ only: .8 }) : pageReading({ only: .1 }) };
  });
  h.voiceSessions.mediator!.operatorQuietMs = 60000;
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: "We're continuing, next", start_ms: 0, end_ms: 900 });
  // GPT Live's "Mm-hmm" while they pause isn't an answer: the job delegation waits.
  live.emit('event', { type: 'session.output_transcript.delta', delta: ' Mm-hmm.' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(jobs, [], 'a backchannel is not the end of their turn');
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } });
  live.emit('event', { type: 'session.output_transcript.delta', delta: ' Sure, moving on. ' });
  await wait('the move', () => runs.length === 2);
  assert.deepEqual(runs, [['page_next_step'], ['next_section']], 'the last step of a part goes on to the next section');
  await wait('the answer', () => lives[0].appended.some(([kind, text]) => kind === 'thinking' && /moved the page; on screen now: Section 4/.test(text)));
  // A complaint about the page that no command answers: the job delegation sends their words to the agent, to extend the
  // page's controller.
  await new Promise(resolve => setTimeout(resolve, 1600));
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'You keep going to the wrong section.', start_ms: 5000, end_ms: 6000 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd2', target: 'client' } });
  await new Promise(resolve => setTimeout(resolve, 600));
  live.emit('event', { type: 'session.output_transcript.delta', delta: " I'm sorry about that. " });
  await wait('the complaint', () => delivered.some(r => /wrong section/.test(r.content) && /asked the page .* for something its controls don't do/.test(r.content)));
});
