import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jev } from '../src/core/jev.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { liveInstructions, pageState } from '../src/core/prompts.ts';
import { roles } from '../src/core/roles.ts';
import { DEFAULT_FEATURES } from '../src/core/features.ts';
import type { StageView } from '../src/core/stage.ts';
import { fakeJev, harness, learn, page, pageReading, settle, turn, until } from './live-fake.ts';

const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"',
  commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }], parts: [] };
const stage = (h: any) => { h.stage = { tabId: 7, view, pages: new Map(), describe: async () => view, run: async () => ({ done: [], onScreen: '' }), follow: async () => null, observe() {}, close() {} }; };

test("one request for the operator's turn, the same as it ends and once the voice has replied: whether their words go to the agent, what a command of the page does for them, their goal and the rest, with what is so at that moment", async () => {
  const bodies: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: .8 }, ready: { noul: .6 } } }) }; } });
  const latest = { role: 'operator' as const, text: 'Can the page show me the error bars?' };
  const ended = await jev.read({ trigger: 'turn', made: 'ended', latest, page: view, learn: true });
  const replied = await jev.read({ trigger: 'turn', made: 'replied', latest, reply: "I can't show that; Claude would have to add it.", page: view, learn: true });
  assert.deepEqual(bodies[1].questions, bodies[0].questions, 'the same questions both times');
  const { voice_reply: before, ...first } = bodies[0].state, { voice_reply: after, ...second } = bodies[1].state;
  assert.deepEqual(second, first, 'over the same state');
  assert.deepEqual([before, after], ['(the companion has not replied)', "I can't show that; Claude would have to add it."], 'with what the companion has said by then');
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['model', 'questions', 'state'], 'which of the two it is stays in the record: Jev is not told');
  for (const name of ['needs_agent', 'ready', 'companion_only', 'goal', 'page_command', 'page_asked', 'page_more', 'behave', 'design_talk', 'lasting']) assert.ok(name in bodies[0].questions, name);
  assert.ok(!('standby' in bodies[0].questions), 'Standby is read later, once the conversation has gone quiet');
  assert.match(bodies[0].state.page_commands, /^- Go to the next section\n- Go to the section "Options"$/);
  assert.match(bodies[0].state.why, /the voice companion has replied to them \(`voice_reply`, what it has said so far\)/);
  assert.match(bodies[0].questions.needs_agent.instructions, /^Do the latest words need the coding agent, now that the voice companion has replied/);
  assert.match(bodies[0].questions.page_command.instructions, /does what the operator asks for in the latest words/, 'with a page open, what they ask of it: its commands do that without the agent');
  assert.match(bodies[0].questions.page_asked.instructions, /ask for something to be done or shown on the page right now/, 'only what they ask for: a remark or a question runs nothing');
  assert.ok(!('withheld' in bodies[0].questions), 'no instructions in force, nothing for them to keep from the agent');
  assert.equal(bodies[0].state.saying, undefined, 'no words waiting from before');
  assert.deepEqual([ended.needsAgent, ended.ready, replied.needsAgent, replied.ready], [.8, .6, .8, .6]);
  const silent = await jev.read({ trigger: 'turn', made: 'replied', latest });
  assert.equal(bodies[2].state.voice_reply, '(the companion has not replied)');
  assert.equal(bodies[2].state.page_commands, undefined, 'no page, no commands');
  assert.equal(silent.needsAgent, .8);
  assert.deepEqual(Object.keys(bodies[2].questions), ['needs_agent', 'ready', 'goal'], "without a page, the learner or the tuner, only these: nothing acts on words about the companion's behavior, so they aren't asked about");
  assert.equal(bodies[2].state.goal, '(none)', 'the goal in force, which new words may replace or end');
  const kept = await jev.read({ trigger: 'turn', latest, instructions: ["I1: Don't delegate everything to Claude; make adjustments yourself when you can."] });
  assert.match(bodies[3].questions.withheld.instructions, /keep the latest words from the coding agent/, "with instructions in force, whether they keep these words from the agent");
  assert.equal(kept.withheld, 0, 'as Jev answered');
  const done = await jev.read({ trigger: 'turn', made: 'replied', latest, page: view, done: [{ id: 'goto_options', say: 'Go to the section "Options"', shown: 'Options: three ways forward.' }] });
  assert.equal(bodies[4].state.page_done, '1. Go to the section "Options" → Options: three ways forward.', 'what the voice tool did on the page for these words, for reading whether anything is left for the agent');
  assert.equal(done.needsAgent, .8);
  // Words of an earlier turn that still wait (the operator hadn't finished): the questions about sending read all they are
  // saying, and what the voice tool does itself is still read from the new words.
  await jev.read({ trigger: 'turn', latest: { role: 'operator', text: 'and add a legend to it.' }, saying: 'Make a chart of the scores and add a legend to it.', sent: { ago: 3000, said: 'Open the report.' }, working: 4000, fork: 'main' });
  const whole = bodies[5];
  assert.deepEqual([whole.state.latest, whole.state.saying], ['user: and add a legend to it.', 'user: Make a chart of the scores and add a legend to it.']);
  assert.match(whole.questions.needs_agent.instructions, /^Does what the operator is saying \(`saying`: all they have said that is not decided yet, ending with the latest words\) need the coding agent, now that the voice companion has replied/);
  assert.match(whole.questions.ready.instructions, /^Have the operator finished saying what they want for now \(`saying`: all they have said that is not decided yet, ending with the latest words\), so that a good listener/);
  assert.match(whole.questions.now.instructions, /Must what the operator is saying \(`saying`\) reach it now/);
  assert.match(whole.questions.adds.instructions, /Does what the operator is saying \(`saying`\) give the agent anything it needs beyond that request\?$/);
  assert.match(whole.questions.tangent.instructions, /^Does what the operator is saying \(`saying`\) belong in a fork of the coding agent's session .*: does it turn aside to ask something .*, or ask for a fork\?$/);
  assert.match(whole.questions.goal.instructions, /^Do the latest words set what the operator wants/, 'the goal, like the page and the learner, from the new words');
});

test("the job delegation waits past the voice's acknowledgments for what it makes of the words, or until it stops", async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.made === 'replied' ? { needsAgent: /don't know/.test(m.reply ?? '') ? .9 : .1, ready: .9 } : { page: pageReading() });
  stage(h);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { replyMs: 4000, replyStartMs: 1000, replyPauseMs: 1500, operatorQuietMs: 60000 });
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'What does the dashed divider mean?', start_ms: 0, end_ms: 900 });
  // GPT Live starting to answer ends the operator's turn: the voice tool's own reading is made at once.
  live.emit('event', { type: 'session.output_transcript.delta', delta: ' Good question.' });
  await until(() => moments.some(m => m.made === 'ended'));
  await settle(300);
  assert.ok(!moments.some(m => m.made === 'replied'), 'an acknowledgment says nothing of what the voice makes of the words');
  live.emit('event', { type: 'session.output_transcript.delta', delta: " I don't know that one; Claude would have to check what the dashed divider means. " });
  await until(() => delivered.length === 1);
  assert.equal(moments.find(m => m.made === 'replied')!.reply, "Good question. I don't know that one; Claude would have to check what the dashed divider means.");
  assert.match(delivered[0].content, /What does the dashed divider mean\?/);
  // A short answer and then quiet: it stopped, and that is its reply.
  await settle(1600);
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'And the legend?', start_ms: 5000, end_ms: 5600 });
  live.emit('event', { type: 'session.output_transcript.delta', delta: " It's the key." });
  const asked = Date.now();
  await until(() => moments.filter(m => m.made === 'replied').length === 2);
  const waited = Date.now() - asked;
  assert.ok(waited >= 1400 && waited < 3500, `decided ${waited} ms after the voice stopped`);
  assert.equal(moments.filter(m => m.made === 'replied')[1].reply, "It's the key.");
});

test('with no reply, the job delegation reads after a short wait; a word of the operator ends the wait at once', async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.made === 'replied' ? { needsAgent: .1 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { replyMs: 5000, replyStartMs: 400, operatorQuietMs: 50 });
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Hmm, so that is the plan.', start_ms: 0, end_ms: 900 });
  const started = Date.now();
  await until(() => moments.some(m => m.made === 'replied'));
  const waited = Date.now() - started;
  assert.ok(waited >= 400 && waited < 2500, `waited ${waited} ms for a reply that never came`);
  assert.equal(moments.find(m => m.made === 'replied')!.reply, undefined);
  // A long wait for a reply, cut short when the operator says more.
  Object.assign(mediator, { replyStartMs: 60000, replyMs: 60000 });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'And the next part.', start_ms: 3000, end_ms: 3800 });
  await until(() => moments.filter(m => m.made === 'ended').length === 2);
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Wait.', start_ms: 4500, end_ms: 4800 });
  await until(() => moments.filter(m => m.made === 'replied').length >= 2);
});

test('moments after a request reached the agent, Jev is asked whether the next words add to it: its tail stays with the voice, an addition goes', async t => {
  const bodies: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: .6 }, ready: { noul: .8 }, adds: { noul: .2 } } }) }; } });
  const tail = await jev.read({ trigger: 'turn', made: 'replied', latest: { role: 'operator', text: 'Okay' }, sent: { ago: 4200, said: "We don't need test mode. Go ahead and launch it." } });
  assert.deepEqual(Object.keys(bodies[0].questions).sort(), ['adds', 'goal', 'needs_agent', 'ready']);
  assert.ok(!('just_sent' in bodies[0].state), 'what was sent is in the history the voice got, not a field of its own');
  assert.match(bodies[0].questions.adds.instructions, /the latest such line in `history` says which/);
  assert.equal(tail.adds, .2);
  await jev.read({ trigger: 'turn', made: 'replied', latest: { role: 'operator', text: 'Okay' } });
  assert.ok(!('adds' in bodies[1].questions), 'asked only when a request went moments before');

  const { h } = await harness(t);
  const moments = fakeJev(h, m => m.made === 'replied' ? { needsAgent: .7, ready: .9, ...m.sent && { adds: /blue/.test(m.latest!.text) ? .9 : .1 } } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { replyStartMs: 50, operatorQuietMs: 50 });
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  const live = h.voiceSessions.live!, jobs = () => moments.filter(m => m.made === 'replied');
  live.emit('event', { type: 'session.input_transcript.delta', delta: "We don't need test mode. Go ahead and launch it.", start_ms: 0, end_ms: 900 });
  await until(() => delivered.length === 1);
  assert.equal(jobs()[0].sent, undefined, 'nothing had been sent before it');
  assert.equal(delivered[0].said, "We don't need test mode. Go ahead and launch it.", "the request carries the operator's words: what the voice is told was sent");
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Okay.', start_ms: 3000, end_ms: 3300 });
  await until(() => jobs().length === 2);
  await settle(50);
  assert.equal(jobs()[1].sent!.said, "We don't need test mode. Go ahead and launch it.");
  assert.ok(jobs()[1].sent!.ago < 10000);
  assert.equal(delivered.length, 1, 'the tail of a request just sent is no second request');
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' And make the button blue.', start_ms: 6000, end_ms: 6900 });
  await until(() => delivered.length === 2);
  assert.match(delivered[1].content, /Okay\./, 'what stayed with the voice goes with the next request, as everything said since the last one does');
  // Later, the same words are read as any turn is.
  mediator.lastSent!.at -= 11000;
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Okay.', start_ms: 20000, end_ms: 20300 });
  await until(() => jobs().length === 4);
  assert.equal(jobs()[3].sent, undefined, 'only moments after a request');
});

test("with a page open, the job delegation knows what its controls can do, and the agent hears what the user was looking at; a request none of its commands does moves nothing", async t => {
  const { h } = await harness(t);
  stage(h);
  const runs: string[][] = []; h.stage.run = async (ids: string[]) => { runs.push(ids); return { done: [], onScreen: '' }; };
  const moments = fakeJev(h, m => m.made === 'replied' ? { needsAgent: .9, ready: .9 } : {});
  const decided = await turn(h, 'Show me the error bars on that chart.');
  assert.equal(decided.send, true);
  assert.match(decided.note!, /^When they said it, the user was looking at "Briefing" \(http:\/\/localhost\/b\.html\) in the browser, at: section "Intro"\.$/);
  assert.equal(moments.find(m => m.made === 'replied')!.page, view, "the job delegation reads the page's commands: what they can't do goes to the agent, to add");
  assert.equal(moments.find(m => m.made === 'ended')!.page, view, "the voice tool's own reading has the page too: what they ask for that a command does, it does there");
  assert.deepEqual(runs, [], 'Jev chose no command: nothing runs');
});

test("the turn's request is made as it ends and again once the reply is in, the same both times; GPT Live asking to pass the operator's words on is one more signal that their turn has ended: the requests it leads to are those their quiet leads to, word for word, and nothing goes that Jev doesn't send", async t => {
  // The same words, with a page open and an instruction in force: one turn ended by the operator's quiet, the other by GPT Live's delegation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-live-'));
  const ended = async (by: 'quiet' | 'delegation', needs: number) => {
    const { h, lives } = await harness(t, { jevKey: 'tsk-test' }, root);
    stage(h);
    const bodies: any[] = [];
    h.jev!.fetch = async (_url, init) => { const body = JSON.parse(String(init.body)); bodies.push(body); return { ok: true, status: 200, json: async () => ({ answers: body.questions.needs_agent ? { needs_agent: { noul: needs }, ready: { noul: .9 } } : {} }) }; };
    await h.voiceSessions.start('sdp', page('p'), 'fresh');
    learn(h, 'Answer my questions yourself.');
    const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
    const live = h.voiceSessions.live!, mediator = h.voiceSessions.mediator!;
    mediator.operatorQuietMs = 30; mediator.replyStartMs = 30;
    live.emit('event', { type: 'session.input_transcript.delta', delta: 'What does the second option cost?', start_ms: 0, end_ms: 900 });
    if (by === 'delegation') live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 1000 });
    await until(() => bodies.some(body => body.questions.needs_agent)); await settle(60);
    return { bodies, delivered, told: lives[0].appended.filter(([kind]) => kind === 'thinking').map(([, text]) => text) };
  };
  const quiet = await ended('quiet', .2), asked = await ended('delegation', .2);
  assert.deepEqual(asked.bodies, quiet.bodies, 'the same two requests, state and questions: nothing tells Jev which signal ended the turn');
  assert.equal(quiet.bodies.length, 2, "as the turn ends, and once the companion's reply is in (here, its silence)");
  assert.deepEqual(quiet.bodies[1], quiet.bodies[0], 'the same request both times: nothing changed between them');
  for (const name of ['needs_agent', 'ready', 'withheld', 'page_command', 'page_asked', 'goal', 'behave']) assert.ok(name in quiet.bodies[0].questions, `${name}: everything is asked, with the instruction and the page as at any turn`);
  assert.deepEqual([quiet.delivered.length, asked.delivered.length], [0, 0], "Jev kept them: GPT Live's asking sends nothing");
  const kept = "Nothing was sent to Claude Code: the voice tool found the operator's words need nothing from Claude. Answer them yourself; whatever they ask Claude to do goes to it when they say so.";
  assert.deepEqual([quiet.told.includes(kept), asked.told.includes(kept)], [false, true], 'GPT Live hears what came of its asking');
  const sentQuiet = await ended('quiet', .8), sentAsked = await ended('delegation', .8);
  assert.deepEqual(sentAsked.bodies, sentQuiet.bodies);
  assert.deepEqual([sentQuiet.delivered.length, sentAsked.delivered.length], [1, 1], 'Jev sends them, either way');
  assert.equal(sentAsked.delivered[0].content, sentQuiet.delivered[0].content, 'as the same request');
  assert.deepEqual([sentQuiet.delivered[0].delegationId, sentAsked.delivered[0].delegationId], [null, 'd1'], 'and GPT Live is told they went as the answer to its asking');
});

test("each decision is acted on once: what the voice tool does itself from the request made as the turn ends, whether the words go to the agent from the one made once the reply is in", async t => {
  const { h } = await harness(t);
  // Jev answers the same both times: the words need the agent, and the operator sets a goal.
  const moments = fakeJev(h, () => ({ needsAgent: .9, ready: .9, goal: { choice: 'new' as const, p: .9 } }));
  const goals: (string | undefined)[] = [], setGoal = h.voiceSessions.setGoal.bind(h.voiceSessions);
  h.voiceSessions.setGoal = ((text: string | undefined, options: any) => { goals.push(text); return setGoal(text, options); }) as typeof h.voiceSessions.setGoal;
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { operatorQuietMs: 30, replyStartMs: 500, replyMs: 5000 });
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  h.voiceSessions.live!.emit('event', { type: 'session.input_transcript.delta', delta: 'Explain the retry logic to me, and fix the header.', start_ms: 0, end_ms: 900 });
  const made = () => moments.filter(m => m.trigger === 'turn').map(m => m.made);
  await until(() => made().length === 1);
  await settle(150);
  assert.deepEqual([made(), delivered.length, goals.length], [['ended'], 0, 1], 'as the turn ends: the goal is set, and nothing goes yet though Jev finds the words need the agent');
  await until(() => delivered.length === 1);
  assert.deepEqual([made(), goals.length], [['ended', 'replied'], 1], 'once the reply is in (here, the wait for one is over): the words go, and the goal is not set again');
});

test("GPT Live asking to pass on words the voice tool carried out on the page sends nothing: Jev's reading of its reply decides, as for any turn, and they don't go when voice ends", async t => {
  const { h, lives } = await harness(t);
  stage(h);
  const runs: string[][] = []; h.stage.run = async (ids: string[]) => { runs.push(ids); return { done: ids.map(id => view.commands.find(c => c.id === id)!), onScreen: 'Options: three ways forward.' }; };
  // Jev answers the same at both of the turn's requests: the page's command is run from the first only.
  const moments = fakeJev(h, m => m.trigger === 'turn' ? { page: { command: 'goto_options', more: .1, asked: .9 }, needsAgent: .1, ready: .9 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  const live = h.voiceSessions.live!;
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Take me to the options.', start_ms: 0, end_ms: 900 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 1000 });
  await until(() => moments.some(m => m.made === 'replied'));
  await settle(50);
  assert.deepEqual(runs, [['goto_options']], 'what they asked for, done on the page, once');
  assert.deepEqual(moments.find(m => m.made === 'replied')!.done!.map(c => c.id), ['goto_options'], 'the job delegation reads what was done');
  assert.deepEqual(delivered, [], "GPT Live's asking sends nothing, and Jev finds nothing left for the agent");
  const thinking = lives[0].appended.filter(([kind]) => kind === 'thinking').map(([, text]) => text);
  assert.ok(thinking.some(text => text.startsWith('The voice tool did what the operator asked on the page (Go to the section "Options"); on screen now: Options: three ways forward.')), 'GPT Live hears what was done');
  assert.ok(!thinking.some(text => text.startsWith('Nothing was sent')), 'and nothing else about its ask');
  h.voiceSessions.mediator!.handOff('operator ended voice');
  await settle(50);
  assert.deepEqual(delivered, [], 'done on the page: nothing to hand over when voice ends');
});

test("while the operator's instructions keep words from the agent and Jev keeps them, GPT Live, asking to pass them on, hears why nothing went; work, and what they ask of the agent by name, goes on Jev's reading", async t => {
  const { h, lives } = await harness(t);
  const moments = fakeJev(h, m => m.made === 'ended' ? { withheld: /tell Claude/i.test(m.latest!.text) ? .1 : .9 } : m.made === 'replied' ? { needsAgent: /histograms|tell Claude/i.test(m.latest!.text) ? .8 : .2, ready: .9 } : {});
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); h.voiceSessions.mediator!.delivered(request.id); };
  const live = h.voiceSessions.live!, jobs = () => moments.filter(m => m.made === 'replied');
  const thinking = () => lives[0].appended.filter(([kind]) => kind === 'thinking').map(([, text]) => text);
  // An order the operator has told the companion to take itself: GPT Live asks, Jev reads, nothing goes.
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'I want it with vanilla and decaf.', start_ms: 0, end_ms: 900 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 1000 });
  await until(() => jobs().length === 1);
  await until(() => thinking().some(text => text === "Nothing was sent to Claude Code: the operator's instructions keep this from Claude. It goes only when they ask for Claude themselves."));
  assert.equal(delivered.length, 0);
  // Work only the agent can do: Jev's own reading sends it, as ever.
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' I need two histograms of the scores.', start_ms: 5000, end_ms: 5900 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd2', target: 'client' }, offset_ms: 6000 });
  await until(() => delivered.length === 1);
  assert.match(delivered[0].said, /^I need two histograms of the scores\.$/, 'the order before it was settled: it goes along as context, not as a request');
  // The operator asks for the agent themselves: that goes on Jev's reading too.
  live.emit('event', { type: 'session.input_transcript.delta', delta: ' Tell Claude to add a caramel option.', start_ms: 10000, end_ms: 10900 });
  live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd3', target: 'client' }, offset_ms: 11000 });
  await until(() => delivered.length === 2);
  assert.equal(jobs().length, 3, "read like the others: GPT Live's asking sends nothing");
});

test("words that are only about how the companion behaves don't go to the agent on Jev's own reading either", async t => {
  const { h } = await harness(t);
  fakeJev(h, m => m.made === 'ended' ? { companionOnly: .9 } : { needsAgent: .5, ready: .9 });
  const decided = await turn(h, "I want you to be in full control. I don't want you delegating to Claude Code.");
  assert.equal(decided.send, false);
  assert.match(decided.told!, /^The operator told you how you should behave/);
});

test("the voice answers what it can with moderate confidence, asks when in doubt, and leaves to the agent only what it can't do: the same account in its instructions and in Jev's", () => {
  const text = liveInstructions(claude, { jev: true }), shared = roles(claude, new Set(DEFAULT_FEATURES));
  assert.match(shared, /It answers whatever it can with moderate confidence, from what it knows and what it was told \(this conversation, Claude's work, the page\); when in doubt about what the operator means, it asks; .* the voice tool reads their words, does what the page's controls can do, and sends Claude whatever needs it; .* Only a request that is fully stated and that neither the companion nor the page can do is Claude's\./);
  assert.ok(text.includes(shared), "in the voice companion's instructions");
  assert.ok(new Jev({ apiKey: 'k', log: () => {}, agent: claude }).setting.includes(shared), "and in what Jev reads: written apart, Jev's account had drifted");
  assert.doesNotMatch(text, /never guess|would have to check|What you can answer/, 'no script for not knowing: it leaned on the agent');
  assert.match(liveInstructions(claude), /You can answer, with moderate confidence/, 'without Jev, the same principle in its delegation policy');
});

test("the page follows what the voice says and leans toward showing; how is its own judgment, and the operator is never told what to say", () => {
  const state = pageState({ title: 'Briefing', names: ['Intro', 'Options'], others: [], parts: [], where: 'section "Intro"', controls: ['Show the error bars', 'Switch to the table view'] });
  assert.match(state, /Its parts, by name: Intro, Options\. Besides showing its parts, its controls can: Show the error bars; Switch to the table view\./);
  assert.doesNotMatch(pageState({ title: 'Briefing', names: ['Intro'], others: [], parts: [], where: '' }), /controls/);
  // An app's controls, all of them, and the page in its own words: an order page's 50 were cut to 12 and 600 characters
  // (Nov 17), so the voice never knew it could remove a drink or place the order.
  const controls = [...Array.from({ length: 48 }, (_, i) => `Add drink number ${i + 1} of the menu to the order ticket`), 'Remove the Mocha from the order ticket', 'Place the order: send the ticket to the bar'];
  const parts = [{ name: 'Menu', text: 'x'.repeat(5000) }];
  const app = pageState({ title: 'Order board', about: 'Café order board that the barista runs', names: ['Menu'], others: [], parts, where: 'Menu', controls });
  assert.match(app, /^The page open beside the operator now \(this replaces any page you were told about before\): "Order board" \(Café order board that the barista runs\)\./);
  assert.ok(controls.every(say => app.includes(say)), 'every control, in its own words');
  const plain = pageState({ title: 'Order board', about: 'Café order board that the barista runs', names: ['Menu'], others: [], parts, where: 'Menu' });
  assert.ok(app.length - plain.length > 2000 && plain.length <= 4000, "on top of the page's own allowance: its parts keep theirs");
  const many = Array.from({ length: 200 }, (_, i) => `Do thing number ${i + 1} on the page, which takes a sentence to say`);
  assert.ok(pageState({ title: 'T', names: [], others: [], parts: [], where: '', controls: many }).length < 6300, 'within its own allowance, whole controls only');
  for (const text of [liveInstructions(claude, { jev: true }), liveInstructions(claude)]) {
    assert.match(text, /Lean toward showing: whenever the conversation touches something the page covers, present it there, naming the part first so the page is on it as you explain\./);
    assert.match(text, /You know a part only in short until you go there; then you are told what it says and what lies under it\. When an answer should be on the page, go where it should be before answering; if it isn't there, say so/);
    assert.match(text, /Whether to show one part, walk through several or go on to the next is yours to judge from what the operator wants; when they ask to be shown or walked through something, keep to it through their questions and pauses until it is done\./);
    assert.match(text, /They just talk to you: never tell them what to say to move the page\./);
    assert.doesNotMatch(text, /moves with the operator's words|follows their own words|Never start presenting|next part follows by itself|say so in a few words|commands, cues or controls/, "no operator page control, no script for after a move");
    assert.doesNotMatch(text, /can't change any file, page or setting/, 'the voice does move the page');
  }
  assert.match(liveInstructions(claude, { jev: true }), /It follows what you say: as you talk about something on it, or say you will show it, the voice tool moves it there and opens or highlights what you mean/);
  assert.doesNotMatch(liveInstructions(claude, { jev: true }), /let's look at/, 'with Jev, no phrase to say: the page follows its words');
  assert.match(liveInstructions(claude), /You move it with your words: say "let's look at" and a part's name/, 'without Jev, only a part\'s name after a turning phrase moves it');
});
