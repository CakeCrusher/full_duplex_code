import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev } from '../src/core/jev.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { liveInstructions, pageState } from '../src/core/prompts.ts';
import type { StageView } from '../src/core/stage.ts';
import { fakeJev, harness, page, pageReading, settle, turn, until } from './live-fake.ts';

const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"',
  commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }], parts: [] };
const stage = (h: any) => { h.stage = { tabId: 7, view, pages: new Map(), describe: async () => view, run: async () => ({ done: [], onScreen: '' }), follow: async () => null, observe() {}, close() {} }; };

test("two calls over the same state that ask different questions: the job delegation, with the voice's reply and the page's commands; the voice tool's own, when GPT Live asks it to act, about everything else", async () => {
  const bodies: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: .8 }, ready: { noul: .6 } } }) }; } });
  const latest = { role: 'operator' as const, text: 'Can the page show me the error bars?' };
  const job = await jev.read({ trigger: 'job', latest, reply: "I can't show that; Claude would have to add it.", page: view });
  const own = await jev.read({ trigger: 'delegation', latest, reply: 'Let me pull that', page: view });
  assert.deepEqual(Object.keys(bodies[0].questions).sort(), ['needs_agent', 'ready']);
  assert.match(bodies[0].state.voice_reply, /Claude would have to add it/);
  assert.match(bodies[0].state.page_commands, /^- Go to the next section\n- Go to the section "Options"$/);
  assert.match(bodies[0].state.why, /the voice companion has replied/);
  assert.ok(!('needs_agent' in bodies[1].questions), "the voice tool's own reading never asks whether the words go to the agent");
  assert.ok('page_command' in bodies[1].questions && 'companion_only' in bodies[1].questions && 'standby' in bodies[1].questions);
  assert.ok(!('page_work' in bodies[1].questions) && !('page_unhappy' in bodies[1].questions), 'what the page falls short of is the job delegation\'s');
  assert.equal(bodies[1].state.voice_reply, 'Let me pull that', 'what GPT Live has said since their words');
  assert.match(bodies[1].state.why, /asked the voice tool to act, now/);
  assert.match(bodies[1].questions.page_command.instructions, /what the voice companion is saying or about to say \(`voice_reply`\)/);
  assert.deepEqual([job.needsAgent, job.ready, own.needsAgent], [.8, .6, null]);
  const silent = await jev.read({ trigger: 'job', latest });
  assert.equal(bodies[2].state.voice_reply, '(the companion has not replied)');
  assert.equal(bodies[2].state.page_commands, undefined, 'no page, no commands');
  assert.equal(silent.needsAgent, .8);
});

/** Each append to GPT Live, with the delegation it answers. */
const answers = (live: any) => { const all: [string, string, string | null][] = [], append = live.append.bind(live); live.append = (kind: string, text: string, id: string | null = null) => { all.push([kind, text, id]); return append(kind, text, id); }; return all; };

test("GPT Live's delegation: the voice tool reads the conversation with what GPT Live said, moves the page and answers the delegation with what is on screen; the turn's end asks only the job delegation, which takes what was done", async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .1, ready: .9 } : m.trigger === 'delegation' ? { page: pageReading({ command: 'goto_options', only: .9 }) } : { page: pageReading() });
  stage(h);
  const runs: string[][] = [];
  h.stage.run = async (ids: string[]) => { runs.push(ids); return { done: [view.commands[1]], onScreen: 'Options: three plans.' }; };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!, live = h.voiceSessions.live!, appended = answers(live);
  Object.assign(mediator, { replyMs: 3000, replyStartMs: 1000, operatorQuietMs: 60000 });
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'What are the options?', start_ms: 0, end_ms: 900 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', type: 'delegation', target: 'client' } });
  await until(() => appended.some(([, , id]) => id === 'd1'));
  assert.deepEqual(runs, [['goto_options']]);
  assert.deepEqual(appended.filter(([, , id]) => id === 'd1'), [['thinking', 'The voice tool moved the page; on screen now: Options: three plans.', 'd1']], 'one answer: what is on screen');
  assert.deepEqual(moments.map(m => m.trigger), ['delegation', 'step'], 'no job delegation before the turn ends');
  live.emit('event', { type: 'session.output_transcript.delta', delta: ' There are three plans here. ' });
  await until(() => moments.some(m => m.trigger === 'job'));
  await until(() => mediator.pending === 0);
  assert.deepEqual(moments.map(m => m.trigger), ['delegation', 'step', 'job'], 'the turn end asks nothing else');
  assert.equal(delivered.length, 0);
  assert.match(mediator.history.request()?.notes?.join(' ') ?? '', /only about showing things on the page/, 'kept, noted as the page\'s');
});

test("GPT Live asking when there is nothing to do hears so; asked again for the same words, the voice tool knows what it already ran", async t => {
  const { h } = await harness(t);
  let command: string | undefined = 'next_section';
  const moments = fakeJev(h, m => m.trigger === 'delegation' ? { page: pageReading({ command, only: .9 }) } : m.trigger === 'step' ? { page: pageReading() } : { needsAgent: .1 });
  stage(h);
  h.stage.run = async () => ({ done: [view.commands[0]], onScreen: 'Section 2.' });
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const live = h.voiceSessions.live!, appended = answers(live);
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Next.', start_ms: 0, end_ms: 400 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', type: 'delegation', target: 'client' } });
  await until(() => appended.some(([, , id]) => id === 'd1'));
  command = undefined;
  live.emit('event', { type: 'session.output_transcript.delta', delta: ' Section two is about' });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd2', type: 'delegation', target: 'client' } });
  await until(() => appended.some(([, , id]) => id === 'd2'));
  const second = moments.filter(m => m.trigger === 'delegation')[1];
  assert.deepEqual(second.done?.map(c => c.id), ['next_section'], 'what ran for the same words');
  assert.equal(second.reply, 'Section two is about');
  assert.deepEqual(appended.find(([, , id]) => id === 'd2'), ['thinking', "Nothing changed on the page or in the settings. Don't mention it unless the operator asked to see something.", 'd2']);
});

test("when GPT Live doesn't ask, the voice tool reads the operator's words itself as their turn ends; asked later for the same words, it knows what ran", async t => {
  const { h } = await harness(t);
  // As Jev is asked: what already ran for these words is done.
  const moments = fakeJev(h, m => m.trigger === 'delegation' ? { page: pageReading({ command: m.done?.length ? undefined : 'next_section', only: .9 }) } : m.trigger === 'step' ? { page: pageReading() } : { needsAgent: .1 });
  stage(h);
  const runs: string[][] = [];
  h.stage.run = async (ids: string[]) => { runs.push(ids); return { done: [view.commands[0]], onScreen: 'Section 2.' }; };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const live = h.voiceSessions.live!, appended = answers(live);
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Continue.', start_ms: 0, end_ms: 400 });
  live.emit('event', { type: 'session.output_transcript.delta', delta: ' Sure, moving on. ' });
  await until(() => runs.length === 1);
  assert.deepEqual(moments.filter(m => m.trigger !== 'step').map(m => m.trigger)[0], 'delegation', "the voice tool's own reading, at the turn's end");
  await until(() => appended.some(([, text]) => /on screen now: Section 2/.test(text)));
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'late', type: 'delegation', target: 'client' } });
  await until(() => appended.some(([, , id]) => id === 'late'));
  assert.deepEqual(moments.filter(m => m.trigger === 'delegation').at(-1)!.done?.map(c => c.id), ['next_section'], 'GPT Live asking later: what already ran');
  await settle(100);
  assert.equal(runs.length, 1, 'not again');
});

test('with no reply, the job delegation reads after a short wait; a word of the operator ends the wait at once', async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .1 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { replyMs: 5000, replyStartMs: 400, operatorQuietMs: 50 });
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Hmm, so that is the plan.', start_ms: 0, end_ms: 900 });
  const started = Date.now();
  await until(() => moments.some(m => m.trigger === 'job'));
  const waited = Date.now() - started;
  assert.ok(waited >= 400 && waited < 2500, `waited ${waited} ms for a reply that never came`);
  assert.equal(moments.find(m => m.trigger === 'job')!.reply, undefined);
  // A long wait for a reply, cut short when the operator says more.
  Object.assign(mediator, { replyStartMs: 60000, replyMs: 60000 });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'And the next part.', start_ms: 3000, end_ms: 3800 });
  await until(() => mediator.turn?.last === 1);
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Wait.', start_ms: 4500, end_ms: 4800 });
  await until(() => moments.filter(m => m.trigger === 'job').length >= 2);
});

test("words about the page that no command does reach the agent to extend the page's controller", async t => {
  const { h } = await harness(t);
  stage(h);
  fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .9 } : { page: pageReading({ only: .8 }) });
  const decided = await turn(h, 'Show me the error bars on that chart.');
  assert.equal(decided.send, true);
  assert.match(decided.note!, /asked the page "Briefing" \(http:\/\/localhost\/b\.html\) in the browser for something its controls don't do.*improve the page's controller/);
  // The page moved for words the job delegation also sends: the agent hears the page part is done.
  fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .9 } : m.trigger === 'step' ? { page: pageReading() } : { page: pageReading({ command: 'goto_options', only: .3 }) });
  h.stage.run = async () => ({ done: [view.commands[1]], onScreen: 'Options' }) as any;
  const both = await turn(h, 'Go to the options and fix the typo there.');
  assert.match(both.note!, /already did the page part of this in the browser/);
});

test("the voice answers from what it was told and general knowledge, says when it doesn't know, and says work is the agent's; it asks the voice tool to show what it is about to talk about", () => {
  const text = liveInstructions(claude, { jev: true });
  assert.match(text, /What you can answer: only what you were told \(this conversation, Claude's work you were told about, the page\) and general knowledge\. When the answer is in neither, say plainly that you don't know and that Claude would have to check: never guess\./);
  assert.match(text, /When the operator's words are unclear, ask one short question instead of answering\./);
  assert.match(text, /Generate <\|SpawnThinking\|> when:\n- you begin talking about something the page has a part for .*generate it first, before you name or explain it/);
  assert.match(text, /Never generate it for work for Claude: what needs Claude reaches it by itself when the operator stops speaking\./);
  assert.match(text, /say in a few words that the page can't do that yet and that Claude will add it/);
  assert.doesNotMatch(text, /let's look at/, 'no spoken cues: its delegation shows the page');
  assert.doesNotMatch(liveInstructions(claude), /What you can answer|Showing and steering/, 'without Jev, GPT Live delegates as before');
  assert.match(liveInstructions(claude), /say "let's look at" and a part's name/);
});

test("GPT Live is told what the page's controls can do besides going to its parts", () => {
  const state = pageState({ title: 'Briefing', names: ['Intro', 'Options'], others: [], parts: [], where: 'section "Intro"', controls: ['Show the error bars', 'Switch to the table view'] });
  assert.match(state, /Its parts, by name: Intro, Options\. Besides showing its parts, its controls can: Show the error bars; Switch to the table view\./);
  assert.doesNotMatch(pageState({ title: 'Briefing', names: ['Intro'], others: [], parts: [], where: '' }), /controls/);
});
