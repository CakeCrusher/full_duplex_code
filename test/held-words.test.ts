import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Mediator, type Decision, type Route } from '../src/core/mediator.ts';
import { jobTurn, type Waiting } from '../src/core/turn.ts';
import type { VoiceRequest } from '../src/core/adapter.ts';
import { settle, until } from './live-fake.ts';

// A mediator whose job delegation decides by `decide`, given the latest words it reads and what waited before them; quick timers.
function fixture(t: TestContext, decide: (latest: string, waiting: Waiting, call: number) => Decision) {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.close = () => { live.state = 'closed'; }; live.append = async () => {};
  const jobs: ({ latest: string } & Waiting)[] = [], deliveries: VoiceRequest[] = [], turns: string[] = [];
  const route: Route = {
    actions: async (_request, spoken) => { turns.push(spoken.at(-1)?.text ?? ''); return {}; },
    job: async (_request, spoken, _reply, _actions, waiting = {}) => { const latest = spoken.at(-1)?.text ?? ''; jobs.push({ latest, ...waiting }); return decide(latest, waiting, jobs.length); },
  };
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, route });
  Object.assign(m, { operatorQuietMs: 60, replyStartMs: 30, replyMs: 60, heldQuietMs: 60000, heldCapMs: 60000 });
  t.after(() => { m.stop(); observer.close(); });
  let at = 0;
  const say = (text: string) => { live.emit('event', { type: 'session.input_transcript.delta', delta: text, start_ms: at, end_ms: at + 500 }); at += 3000; };
  return { m, live, jobs, deliveries, turns, say };
}
const wait: Decision = { send: false, wait: true, needed: true };

test('words the operator has not finished wait undecided; the next reading takes them with what they add, and they go once, whole', async t => {
  const f = fixture(t, (_latest, _waiting, call) => call === 1 ? wait : { send: true });
  f.say('Make the header');
  await until(() => f.jobs.length === 1);
  await settle(100);
  assert.equal(f.deliveries.length, 0, 'not finished: nothing sent');
  assert.ok(f.m.undecided());
  f.say('blue, and the footer too.');
  await until(() => f.deliveries.length === 1);
  assert.match(f.jobs[1].latest, /^Make the header ?blue, and the footer too\.$/, "the job delegation's latest words are all of them since its last decision");
  assert.equal(f.turns[1], 'blue, and the footer too.', "the voice tool's own reading takes only the new words: a page command never runs twice for the same words");
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

test('speaking again before the decision sends nothing yet: the reading knows they went on, and the end of their turn reads it all', async t => {
  const f = fixture(t, (_latest, waiting) => waiting.continued ? { send: false, wait: true } : { send: true });
  f.m.replyStartMs = 1000;
  f.say('Actually, I like the soft shapes one, the');
  // Their turn is being read (the voice tool's own part is done) and the job delegation waits for GPT Live's reply.
  await until(() => f.turns.length === 1);
  f.say('rim is a bit too pronounced, so give me three variants.');
  await until(() => f.deliveries.length === 1);
  assert.deepEqual(f.jobs.map(j => Boolean(j.continued)), [true, false]);
  assert.match(f.jobs[1].latest, /soft shapes one, the ?rim is a bit too pronounced/);
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
  Object.assign(f.m, { heldCapMs: 300, replyStartMs: 1000 });
  f.say('Fix the import in the router.');
  await until(() => f.jobs.length === 1);
  assert.equal(f.jobs[0].overdue, false);
  await settle(400);
  f.say('And while that runs, about the deck');
  await until(() => f.turns.length === 2);
  // Past the cap, speaking again before the decision no longer puts it off.
  f.say('the third slide is fine.');
  await until(() => f.deliveries.length === 1);
  assert.equal(f.jobs.at(-1)!.overdue, true);
  assert.match(f.deliveries[0].content, /Fix the import in the router\./);
});

test("the job delegation's rule: sent once needed and finished; waits while unfinished or still being said; once needed, never dropped", async () => {
  const decide = async (needsAgent: number, ready: number, waiting: Waiting = {}) => {
    const bridge: any = { read: async () => ({ trigger: 'job', said: '', transcript: '', needsAgent, ready }), log: () => {} };
    const { send, wait, needed } = await jobTurn(bridge, { utterances: [], through: 0, seqs: [0], fresh: 'x' }, [], undefined, {}, waiting);
    return { send, wait, needed };
  };
  assert.deepEqual(await decide(.9, .9), { send: true, wait: false, needed: false }, 'a finished request goes');
  assert.deepEqual(await decide(.9, .1), { send: false, wait: true, needed: true }, 'an unfinished one waits');
  assert.deepEqual(await decide(.9, .9, { continued: true }), { send: false, wait: true, needed: true }, 'nothing goes while they are still speaking');
  assert.deepEqual(await decide(.9, .1, { overdue: true }), { send: true, wait: false, needed: false }, 'waited too long: it goes, finished or not');
  assert.deepEqual(await decide(.1, .9, { needed: true }), { send: true, wait: false, needed: false }, 'found needed before: a later reading of the whole stretch keeps it needed');
  assert.deepEqual(await decide(.1, .9), { send: false, wait: false, needed: false }, 'talk that needs nothing is kept');
  assert.deepEqual(await decide(.1, .9, { continued: true }), { send: false, wait: true, needed: false }, 'still being said: read again with the rest');
});
