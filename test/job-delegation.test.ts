import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev } from '../src/core/jev.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { liveInstructions } from '../src/core/prompts.ts';
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
  const own = await jev.read({ trigger: 'turn', latest, page: view });
  assert.deepEqual(Object.keys(bodies[0].questions).sort(), ['needs_agent', 'ready']);
  assert.match(bodies[0].state.voice_reply, /Claude would have to add it/);
  assert.match(bodies[0].state.page_commands, /^- Go to the next section\n- Go to the section "Options"$/);
  assert.match(bodies[0].state.why, /the voice companion has replied/);
  assert.ok(!('needs_agent' in bodies[1].questions), "the voice tool's own reading never asks whether the words go to the agent");
  assert.ok('page_command' in bodies[1].questions && 'companion_only' in bodies[1].questions && 'standby' in bodies[1].questions);
  assert.ok(!('page_work' in bodies[1].questions) && !('page_unhappy' in bodies[1].questions), 'what the page falls short of is the job delegation\'s');
  assert.equal(bodies[1].state.voice_reply, undefined);
  assert.deepEqual([job.needsAgent, job.ready, own.needsAgent], [.8, .6, null]);
  const silent = await jev.read({ trigger: 'job', latest });
  assert.equal(bodies[2].state.voice_reply, '(the companion has not replied)');
  assert.equal(bodies[2].state.page_commands, undefined, 'no page, no commands');
  assert.equal(silent.needsAgent, .8);
});

test("the job delegation decides once the voice has said its first sentence, and reads what it said; the page moves before", async t => {
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

test("the voice answers from what it was told and general knowledge, says when it doesn't know, and says work is the agent's", () => {
  const text = liveInstructions(claude, { jev: true });
  assert.match(text, /What you can answer: only what you were told \(this conversation, Claude's work you were told about, the page\) and general knowledge\. When the answer is in neither, say plainly that you don't know and that Claude would have to check: never guess\./);
  assert.match(text, /When the operator's words are unclear, ask one short question instead of answering\./);
  assert.doesNotMatch(liveInstructions(claude), /What you can answer/, 'without Jev, GPT Live delegates as before');
});
