import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { Mediator, type Decision, type Route } from '../src/core/mediator.ts';
import { quietTurn, type Waiting } from '../src/core/turn.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';
import type { VoiceRequest } from '../src/core/adapter.ts';
import { settle, until } from './live-fake.ts';
import { forgetScript, phantom } from '../src/core/voice-history.ts';

// A mediator whose quiet's request decides by `decide`, given the latest words it reads and what waited before them (in
// `saying`, whole); what GPT Live says alone by `voice`; the conversation is quiet after 60 ms.
function fixture(t: TestContext, decide: (latest: string, waiting: Waiting, call: number) => Decision, voice: (said: string) => Decision = () => ({ send: false })) {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.close = () => { live.state = 'closed'; }; live.append = async () => {};
  const jobs: ({ latest: string } & Waiting)[] = [], deliveries: VoiceRequest[] = [], turns: string[] = [], said: (string | undefined)[] = [], owns: string[] = [];
  const route: Route = {
    page: async (_request, spoken, waiting = {}) => { turns.push(spoken.at(-1)?.text ?? ''); said.push(waiting.saying); return {}; },
    quiet: async (_request, spoken, _reply, _since, _early, waiting = {}) => { const latest = spoken.at(-1)?.text ?? ''; jobs.push({ latest, ...waiting }); return decide(latest, waiting, jobs.length); },
    voice: async spoken => { owns.push(spoken.at(-1)!.text); return voice(spoken.at(-1)!.text); },
  };
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, route, tuning: { ...DEFAULT_TUNING, quietMs: 60 } });
  Object.assign(m, { heldQuietMs: 60000, heldCapMs: 60000 });
  t.after(() => { m.stop(); observer.close(); });
  let at = 0;
  const say = (text: string) => { live.emit('event', { type: 'session.input_transcript.delta', delta: text, start_ms: at, end_ms: at + 500 }); at += 3000; };
  const answer = (text: string) => { live.emit('event', { type: 'session.output_transcript.delta', delta: text, start_ms: at, end_ms: at + 500 }); at += 3000; };
  return { m, live, jobs, deliveries, turns, said, owns, say, answer };
}
const wait: Decision = { send: false, wait: true, needed: true };

test('words the operator has not finished wait undecided; the next reading takes them with what they add, and they go once, whole', async t => {
  const f = fixture(t, (_latest, _waiting, call) => call === 1 ? wait : { send: true });
  // GPT Live begins to answer within the quiet time here: the page is read before the quiet's request.
  f.m.quietMs = 900;
  f.say('Make the header');
  await until(() => f.jobs.length === 1);
  await settle(100);
  assert.equal(f.deliveries.length, 0, 'not finished: nothing sent');
  assert.ok(f.m.undecided());
  f.say('blue, and the footer too.');
  f.answer(" The header and the footer, got it.");
  await until(() => f.deliveries.length === 1);
  assert.match(f.jobs[1].saying!, /^Make the header ?blue, and the footer too\.$/, 'what they are saying is all of it since the last decision: the questions about sending read it whole');
  assert.equal(f.jobs[1].latest, 'blue, and the footer too.', 'the latest words are the new ones: a page command never runs twice for the same words');
  assert.deepEqual([f.turns, f.said], [[f.jobs[1].latest], [f.jobs[1].saying]], "the same in the request made as GPT Live begins to answer, which reads the page; nothing GPT Live never answered was read before the quiet");
  assert.equal(f.jobs[0].saying, undefined, 'nothing waited before the first words');
  assert.match(f.deliveries[0].content, /Make the header.*blue, and the footer too\./s);
  assert.equal(f.m.undecided(), false);
});

test('waiting words go to the agent once the conversation stays quiet, noted as possibly unfinished', async t => {
  const f = fixture(t, () => wait);
  f.m.heldQuietMs = 300;
  f.say('Also, the current log is not useful. Just remove that. I want to see, um');
  await until(() => f.jobs.length === 1);
  await settle(150);
  assert.equal(f.deliveries.length, 0);
  await until(() => f.deliveries.length === 1);
  assert.match(f.deliveries[0].content, /stopped partway through this and said nothing more for \d+ seconds.*may be unfinished/);
  assert.match(f.deliveries[0].content, /remove that/);
});

test('the quiet that sends waiting words waits while GPT Live is still talking', async t => {
  const f = fixture(t, () => wait);
  f.m.heldQuietMs = 300;
  f.say('Can you also');
  await until(() => f.jobs.length === 1);
  for (let i = 0; i < 4; i++) { f.live.emit('event', { type: 'session.output_transcript.delta', delta: ' and so the page lists them ' }); await settle(120); }
  assert.equal(f.deliveries.length, 0, 'not while the voice answers a side question');
  await until(() => f.deliveries.length === 1);
});

test('speaking again before the conversation is quiet puts the decision off: one reading takes all of it', async t => {
  const f = fixture(t, () => ({ send: true }));
  f.say('Actually, I like the soft shapes one, the');
  f.say('rim is a bit too pronounced, so give me three variants.');
  await until(() => f.deliveries.length === 1);
  assert.equal(f.jobs.length, 1);
  assert.match(f.jobs[0].latest, /soft shapes one, the ?rim is a bit too pronounced/);
});

test('a reading that found the waiting words need the agent is remembered for the next one; words that never did stop waiting when they need nothing', async t => {
  const f = fixture(t, (_latest, waiting, call) => call === 1 ? wait : call === 2 ? { send: false, wait: Boolean(waiting.needed), needed: waiting.needed } : { send: false });
  f.m.heldQuietMs = 60000;
  f.say('Fix the import, and maybe');
  await until(() => f.jobs.length === 1);
  f.say('Never mind the rest.');
  await until(() => f.jobs.length === 2);
  assert.equal(f.jobs[1].needed, true, 'the request found in the first reading is not dropped by the next');
  assert.ok(f.m.undecided());
  // Words that wait only because the operator went on, and that need nothing, stop waiting.
  const g = fixture(t, (_latest, waiting, call) => call === 1 ? { send: false, wait: true } : { send: false });
  g.m.heldQuietMs = 250;
  g.say('So, um');
  await until(() => g.jobs.length === 1);
  g.say('anyway, nice weather.');
  await until(() => g.jobs.length === 2);
  await settle(500);
  assert.equal(g.jobs[1].needed, false);
  assert.equal(g.m.undecided(), false);
  assert.equal(g.deliveries.length, 0);
});

test('words that have waited too long are read as overdue even while the operator goes on, and go once they need the agent', async t => {
  const f = fixture(t, (_latest, waiting) => waiting.overdue ? { send: true } : wait);
  f.m.heldCapMs = 300;
  f.say('Fix the import in the router.');
  await until(() => f.jobs.length === 1);
  assert.equal(f.jobs[0].overdue, false);
  await settle(400);
  // Past the cap, they go at the next quiet whatever it finds of what the operator says now.
  f.say('And while that runs, about the deck');
  await until(() => f.deliveries.length === 1);
  assert.equal(f.jobs.at(-1)!.overdue, true);
  assert.match(f.deliveries[0].content, /Fix the import in the router\./);
});

/** A voice tool with no page, no forks and no features, whose reading Jev gives as `answers`; `speaks` makes the operator speak while it is read. */
const toolWith = (answers: (moment: any) => Record<string, unknown>, { working, outbox, speaks = false }: { working?: number; outbox?: Map<string, any>; speaks?: boolean } = {}) => {
  const asked: any[] = [];
  const bridge: any = { agent: claude, forks: { possible: false }, features: new Set(), agentWorking: () => working, log: () => {}, outbox: outbox ?? new Map(), stage: { describe: async () => undefined }, mediator: { history: { lastInputAt: 0 } },
    read: async (moment: any) => { asked.push(moment); if (speaks) bridge.mediator.history.lastInputAt = Date.now() + 1; return { trigger: 'turn', made: 'quiet', said: '', transcript: '', ...answers(moment) }; } };
  return { bridge, asked };
};
const quietly = (bridge: any, waiting: Waiting = {}) => quietTurn(bridge, { utterances: [], through: 0, seqs: [0], fresh: 'x' }, [], undefined, [], {}, waiting);

test("the job delegation's rule: sent once needed and finished; waits while unfinished or still being said; once needed, never dropped", async () => {
  const decide = async (needsAgent: number, ready: number, waiting: Waiting = {}, speaks = false) => {
    const { send, wait, needed } = await quietly(toolWith(() => ({ needsAgent, ready }), { speaks }).bridge, waiting);
    return { send, wait, needed };
  };
  assert.deepEqual(await decide(.9, .9), { send: true, wait: false, needed: false }, 'a finished request goes');
  assert.deepEqual(await decide(.9, .1), { send: false, wait: true, needed: true }, 'an unfinished one waits');
  assert.deepEqual(await decide(.9, .9, {}, true), { send: false, wait: true, needed: true }, 'nothing goes when they spoke again while it was read: the next quiet reads it with the rest');
  assert.deepEqual(await decide(.9, .1, { overdue: true }), { send: true, wait: false, needed: false }, 'waited too long: it goes, finished or not');
  assert.deepEqual(await decide(.1, .9, { needed: true }), { send: true, wait: false, needed: false }, 'found needed before: a later reading of the whole stretch keeps it needed');
  assert.deepEqual(await decide(.1, .9), { send: false, wait: false, needed: false }, 'talk that needs nothing is kept');
  assert.deepEqual(await decide(.1, .9, {}, true), { send: false, wait: true, needed: false }, 'still being said: read again with the rest');
});

test("while the agent is in the middle of a turn, a request is steered in unless Jev finds it can wait; then it is held for the turn's end", async () => {
  const decide = async (working: number | undefined, now: number, waiting: Waiting = {}) => {
    const { bridge, asked } = toolWith(moment => ({ needsAgent: .9, ready: .9, ...moment.working !== undefined && { now } }), { working });
    const { send, later } = await quietly(bridge, waiting);
    return { send, later, asked: asked[0].working };
  };
  assert.deepEqual(await decide(undefined, .1), { send: true, later: false, asked: undefined }, 'between turns nothing is asked: the request starts a turn');
  assert.deepEqual(await decide(95000, .1), { send: true, later: true, asked: 95000 }, 'it can wait: held until the turn ends');
  assert.deepEqual(await decide(95000, .6), { send: true, later: false, asked: 95000 }, 'it must go in now: steered into the turn');
  assert.equal((await decide(95000, .29)).later, true);
  assert.equal((await decide(95000, .3)).later, false, 'held only on a clear word that it can wait');
  assert.equal((await decide(95000, .1, { overdue: true })).later, false, 'words that waited already go in now');
  assert.equal((await decide(95000, .1, { needed: true })).later, false);
});

test("what GPT Live says once the operator's words were read is read at the next quiet: when it leaves something with the agent, that goes, with the words that stayed with it", async t => {
  // The operator's question stays with the voice; the voice then says the agent would have to look.
  const f = fixture(t, () => ({ send: false }), said => ({ send: /would have to look/.test(said) }));
  f.say('What was the retention rate in the March cohort?');
  await until(() => f.jobs.length === 1);
  await settle(100);
  assert.deepEqual([f.deliveries.length, f.owns.length], [0, 0], 'kept: the voice is looking on the page, and it had said nothing yet');
  f.answer(" Let me check the cohort table. I can't find March there; Claude would have to look.");
  await until(() => f.deliveries.length === 1);
  assert.deepEqual([f.jobs.length, f.owns], [1, ["Let me check the cohort table. I can't find March there; Claude would have to look."]], 'its words alone are read, once');
  assert.match(f.deliveries[0].content, /user: What was the retention rate in the March cohort\?\nvoice assistant: Let me check the cohort table\. I can't find March there; Claude would have to look\./, 'the question that stayed with it goes along, before what it said');
  assert.equal(f.deliveries[0].said, "Let me check the cohort table. I can't find March there; Claude would have to look.", "what the voice is told went: its own words");
  assert.equal(f.deliveries[0].own, true);
  await settle(200);
  assert.equal(f.owns.length, 1, 'read once');

  // What it says that leaves nothing with the agent: nothing goes, and the question stays for the next request.
  const g = fixture(t, () => ({ send: false }));
  g.say('Is that the same list?');
  await until(() => g.jobs.length === 1);
  g.answer(' Yes, it is the same list as before.');
  await until(() => g.owns.length === 1);
  await settle(100);
  assert.equal(g.deliveries.length, 0);
  // The operator speaking again: the next quiet reads their turn, what the voice said before it being history.
  g.say('And the other one?');
  await until(() => g.jobs.length === 2);
  assert.equal(g.owns.length, 1, "their turn, not the voice's words again");

  // The voice asking for something itself, the operator having asked nothing: it goes on its own.
  const h = fixture(t, () => ({ send: false }), said => ({ send: /a drawing would help/.test(said) }));
  h.answer(' For this part, a drawing would help: one that shows how the memory equation is built up.');
  await until(() => h.deliveries.length === 1);
  assert.match(h.deliveries[0].content, /voice assistant: For this part, a drawing would help: one that shows how the memory equation is built up\.$/);
  assert.equal(h.jobs.length, 0, 'no turn of the operator was read');
});

test("moments after a request was held for the turn's end, an acknowledgment stays with the voice, and words that press for it bring it in", async () => {
  // Where the request sent moments ago is now is the outbox's to say.
  const decide = async (adds: number, now: number, state: 'held' | 'sent' | 'uncertain') => {
    const { bridge, asked } = toolWith(moment => ({ needsAgent: .7, ready: .9, ...moment.sent && { adds }, now }), { working: 95000, outbox: new Map([['legend', { state }]]) });
    const { send, later } = await quietly(bridge, { sent: { ago: 4000, said: 'Add a legend when you are done.', id: 'legend' } });
    return { send, later, held: asked[0].sent?.held };
  };
  assert.deepEqual(await decide(.1, .1, 'held'), { send: false, later: false, held: true }, '"okay": nothing more for the agent, and what is held stays held');
  assert.deepEqual(await decide(.1, .8, 'held'), { send: true, later: false, held: true }, '"no, send it now": steered in, which brings the held request with it');
  assert.deepEqual(await decide(.1, .8, 'sent'), { send: false, later: false, held: false }, 'once it has been delivered (released at the turn\'s end too), words that add nothing stay with the voice');
  assert.deepEqual(await decide(.9, .1, 'held'), { send: true, later: true, held: true }, 'an addition that can wait is held too');
  assert.deepEqual(await decide(.1, .8, 'uncertain'), { send: true, later: false, held: undefined }, 'a request not known to have arrived is no reason to keep a repeat of it');
});

test('pieces of transcript that are no speech of the operator (another script, a control token) are not their words: no turn, no request, no seed', async t => {
  assert.deepEqual(['्क', 'બહાર', '<|stream', '<', ' <| ', '\uFFFD'].map(phantom), [true, true, true, true, true, true]);
  assert.deepEqual([' Yeah', 'café', '4', '?', ' ', 'naïve résumé', 'a < b'].map(phantom), [false, false, false, false, false, false, false], 'speech, digits and punctuation stay');
  const f = fixture(t, () => ({ send: true }));
  f.say('्क');
  await settle(250);
  assert.deepEqual([f.jobs.length, f.deliveries.length, f.m.history.lastInputAt], [0, 0, 0], 'no turn is read for it');
  f.say('Add a legend.');
  f.say(' બહાર');
  f.say(' Please.');
  await until(() => f.deliveries.length === 1);
  assert.doesNotMatch(f.deliveries[0].content, /્ક|બહાર/, 'and it is no part of what the agent gets');
  assert.deepEqual(f.m.history.turns().map(turn => turn.text), ['Add a legend.', 'Please.'], 'nor of the conversation a later connection is seeded with');
  // After such a piece, GPT Live answering again reads nothing of the operator's a second time: the piece is not their last word.
  const read = f.jobs.length;
  f.say(' ్ద');
  f.m.liveEvent({ type: 'session.output_transcript.delta', delta: ' Done.', start_ms: 90000, end_ms: 90400 });
  await settle(250);
  assert.equal(f.jobs.length, read, 'the words before it were read once');

  // An operator who speaks in another script: two pieces in a row are speech, and from then on every piece is.
  t.after(forgetScript);
  const g = fixture(t, () => ({ send: true }));
  for (const piece of ['Добавь', ' легенду', ' к', ' графику.']) g.m.liveEvent({ type: 'session.input_transcript.delta', delta: piece, start_ms: 0, end_ms: 400 });
  await until(() => g.deliveries.length === 1);
  assert.match(g.deliveries[0].content, /Добавь легенду к графику\./, 'all of it reaches the agent, the first piece included');
  assert.deepEqual(['Да', '्क'].map(phantom), [false, false], 'and a single word of theirs is theirs');
});
