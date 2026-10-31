import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev } from '../src/core/jev.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { liveInstructions, pageState } from '../src/core/prompts.ts';
import { roles } from '../src/core/roles.ts';
import { DEFAULT_FEATURES } from '../src/core/features.ts';
import type { StageView } from '../src/core/stage.ts';
import { fakeJev, harness, page, pageReading, settle, turn, until } from './live-fake.ts';

const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"',
  commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }], parts: [] };
const stage = (h: any) => { h.stage = { tabId: 7, view, pages: new Map(), describe: async () => view, run: async () => ({ done: [], onScreen: '' }), follow: async () => null, observe() {}, close() {} }; };

test("two calls over the same state that ask different questions: the job delegation, with the voice's reply and the page's commands; the voice tool's own, about everything else", async () => {
  const bodies: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: .8 }, ready: { noul: .6 } } }) }; } });
  const latest = { role: 'operator' as const, text: 'Can the page show me the error bars?' };
  const job = await jev.read({ trigger: 'job', latest, reply: "I can't show that; Claude would have to add it.", page: view });
  const own = await jev.read({ trigger: 'turn', latest, page: view, learn: true });
  assert.deepEqual(Object.keys(bodies[0].questions).sort(), ['needs_agent', 'ready']);
  assert.match(bodies[0].state.voice_reply, /Claude would have to add it/);
  assert.match(bodies[0].state.page_commands, /^- Go to the next section\n- Go to the section "Options"$/);
  assert.match(bodies[0].state.why, /the voice companion has replied/);
  assert.ok(!('needs_agent' in bodies[1].questions), "the voice tool's own reading never asks whether the words go to the agent");
  assert.ok('companion_only' in bodies[1].questions && 'standby' in bodies[1].questions);
  assert.ok(!('page_command' in bodies[1].questions), "the operator's words never move the page: only the voice's do");
  assert.equal(bodies[1].state.voice_reply, undefined);
  assert.deepEqual([job.needsAgent, job.ready, own.needsAgent], [.8, .6, null]);
  const silent = await jev.read({ trigger: 'job', latest });
  assert.equal(bodies[2].state.voice_reply, '(the companion has not replied)');
  assert.equal(bodies[2].state.page_commands, undefined, 'no page, no commands');
  assert.equal(silent.needsAgent, .8);
  await jev.read({ trigger: 'turn', latest });
  assert.deepEqual(Object.keys(bodies[3].questions), ['standby'], "without the learner or the tuner, nothing acts on words about the companion's behavior, so they aren't asked about");
});

test("the job delegation decides once the voice has said its first sentence, and reads what it said", async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.trigger === 'job' ? { needsAgent: /don't know/.test(m.reply ?? '') ? .9 : .1, ready: .9 } : { page: pageReading() });
  stage(h);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { replyMs: 3000, replyStartMs: 1000, operatorQuietMs: 60000 });
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'What does the dashed divider mean?', start_ms: 0, end_ms: 900 });
  // GPT Live starting to answer ends the operator's turn: the voice tool's own reading is made at once.
  live.emit('event', { type: 'session.output_transcript.delta', delta: " I don't know that" });
  await until(() => moments.some(m => m.trigger === 'turn'));
  await settle(200);
  assert.ok(!moments.some(m => m.trigger === 'job'), 'the job delegation waits for the end of its first sentence');
  live.emit('event', { type: 'session.output_transcript.delta', delta: '; Claude would have to check. ' });
  await until(() => delivered.length === 1);
  assert.match(moments.find(m => m.trigger === 'job')!.reply!, /^I don't know that; Claude would have to check\.$/);
  assert.match(delivered[0].content, /What does the dashed divider mean\?/);
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
  await until(() => moments.filter(m => m.trigger === 'turn').length === 2);
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Wait.', start_ms: 4500, end_ms: 4800 });
  await until(() => moments.filter(m => m.trigger === 'job').length >= 2);
});

test("with a page open, the job delegation knows what its controls can do, and the agent hears what the user was looking at; the page itself doesn't move", async t => {
  const { h } = await harness(t);
  stage(h);
  const runs: string[][] = []; h.stage.run = async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; };
  const moments = fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .9, ready: .9 } : {});
  const decided = await turn(h, 'Show me the error bars on that chart.');
  assert.equal(decided.send, true);
  assert.match(decided.note!, /^When they said it, the user was looking at "Briefing" \(http:\/\/localhost\/b\.html\) in the browser, at: section "Intro"\.$/);
  assert.equal(moments.find(m => m.trigger === 'job')!.page, view, "the job delegation reads the page's commands: what they can't do goes to the agent, to add");
  assert.equal(moments.find(m => m.trigger === 'turn')!.page, undefined);
  assert.deepEqual(runs, []);
});

test("the voice answers what it can with moderate confidence, asks when in doubt, and leaves to the agent only what it can't do: the same account in its instructions and in Jev's", () => {
  const text = liveInstructions(claude, { jev: true }), shared = roles(claude, new Set(DEFAULT_FEATURES));
  assert.match(shared, /It answers whatever it can with moderate confidence, from what it knows and what it was told \(this conversation, Claude's work, the page\); when in doubt about what the operator means, it asks; .* Only a request that is fully stated and that the voice companion can't do itself is Claude's\./);
  assert.ok(text.includes(shared), "in the voice companion's instructions");
  assert.ok(new Jev({ apiKey: 'k', log: () => {}, agent: claude }).setting.includes(shared), "and in what Jev reads: written apart, Jev's account had drifted");
  assert.doesNotMatch(text, /never guess|would have to check|What you can answer/, 'no script for not knowing: it leaned on the agent');
  assert.match(liveInstructions(claude), /You can answer, with moderate confidence/, 'without Jev, the same principle in its delegation policy');
});

test("the voice moves the page with its own words and leans toward showing; how is its own judgment", () => {
  const state = pageState({ title: 'Briefing', names: ['Intro', 'Options'], others: [], parts: [], where: 'section "Intro"', controls: ['Show the error bars', 'Switch to the table view'] });
  assert.match(state, /Its parts, by name: Intro, Options\. Besides showing its parts, its controls can: Show the error bars; Switch to the table view\./);
  assert.doesNotMatch(pageState({ title: 'Briefing', names: ['Intro'], others: [], parts: [], where: '' }), /controls/);
  for (const text of [liveInstructions(claude, { jev: true }), liveInstructions(claude)]) {
    assert.match(text, /You move it with your words: say "let's look at" and a part's name/);
    assert.match(text, /Lean toward showing: whenever the conversation touches something the page covers, present it there\./);
    assert.match(text, /Whether to show one part, walk through several or go on to the next is yours to judge from what the operator wants\./);
    assert.doesNotMatch(text, /moves with the operator's words|follows their own words|Never start presenting|next part follows by itself|say so in a few words|commands, cues or controls/, "no operator page control, no script for after a move");
    assert.doesNotMatch(text, /can't change any file, page or setting/, 'the voice does move the page');
  }
  assert.match(liveInstructions(claude, { jev: true }), /or what a control shows, and the page goes there/);
});
