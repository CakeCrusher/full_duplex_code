// Every Jev call is recorded in the run's jev.jsonl: what fdc asked (configured and sent), what Jev answered, and what fdc
// did with it (jev-audit.ts).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JevAudit, type JevCall } from '../src/core/jev-audit.ts';
import type { StageView } from '../src/core/stage.ts';
import { harness, page, settle, turn, until } from './live-fake.ts';
import { quietTurn } from '../src/core/turn.ts';

const KEY = 'tsk-test-secret-0123456789';
const lines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
/** A harness whose Jev is the real one, answering from `respond` (by what it is asked) over a stand-in for TypeSafe. */
async function audited(t: TestContext, respond: (body: any) => { status?: number; answers?: unknown }, extra: Record<string, unknown> = {}) {
  const made = await harness(t, { jevKey: KEY, ...extra });
  made.h.jev!.fetch = async (_url, init) => { const { status = 200, answers } = respond(JSON.parse(String(init.body))); return { ok: status === 200, status, json: async () => ({ answers }) }; };
  const file = path.join(made.h.runDir, 'jev.jsonl');
  return { ...made, file, calls: (): JevCall[] => lines(file) };
}
const own = { standby: { noul: .1 }, companion_only: { noul: .2 }, behave: { noul: .1 }, design_talk: { noul: .3 }, lasting: { choice: 'this_moment' } };

test('each Jev call of a turn is recorded with what fdc asked, what Jev answered and what fdc did with it', async t => {
  const job = { needs_agent: { noul: .8 }, ready: { noul: .9 } }, all = { ...job, ...own };
  const { h, lives, root, file, calls } = await audited(t, () => ({ answers: all }));
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  // GPT Live begins to answer within the quiet time: the turn's request is made then, for the page, and at the quiet.
  h.voiceSessions.mediator!.quietMs = 1000;
  lives[0].say('operator', 'Fix the header, please.', 0);
  lives[0].say('intermediary', ` Got it, passing that on. ${KEY}`, 900);
  await until(() => delivered.length === 1 && calls().length === 2);
  const turnCall = calls().find(c => c.made === 'ended')!, jobCall = calls().find(c => c.made === 'quiet')!;
  assert.equal(jobCall.requestId, delivered[0].id, 'the request the words went to the agent by');
  assert.ok(turnCall.requestId && turnCall.requestId !== jobCall.requestId, "the first request's own: the quiet's is cut from all that was said by then");
  assert.deepEqual(jobCall.config, { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', timeoutMs: 3000, features: ['instructions'], thresholds: { needs_agent: .35, ready: .2, companion_only: .85, goal: .6, behave: .6, design_talk: .5 } }, 'no fork question: the session has no conversation of its own to fork yet');
  assert.deepEqual([turnCall.trigger, jobCall.trigger], ['turn', 'turn'], 'one request, made as GPT Live began to answer and again once the conversation had gone quiet');
  assert.deepEqual(turnCall.questions, jobCall.questions, 'the same questions both times');
  assert.deepEqual({ ...turnCall.state, voice_reply: '', why: '' }, { ...jobCall.state, voice_reply: '', why: '' }, 'over the same state, but for what the companion had said by then, and why it is asked');
  assert.equal(jobCall.state.latest, 'user: Fix the header, please.');
  assert.match(jobCall.state.setting, /^An operator talks by voice/);
  assert.match(jobCall.state.voice_reply, /^Got it, passing that on\. \[redacted\]$/, 'written without the secrets fdc knows');
  assert.match((jobCall.questions.needs_agent as any).instructions, /Do the latest words need the coding agent/);
  assert.deepEqual(jobCall.answers, all, 'the answers as returned');
  assert.equal(jobCall.status, 200);
  assert.ok(jobCall.ms >= 0);
  assert.deepEqual(jobCall.decision, { outcome: 'send', needed: true, companionOnly: false, finished: true, learned: false }, "from the quiet's request, whether the words went, the voice tool's own actions and the learner's");
  assert.deepEqual(turnCall.config, jobCall.config);
  assert.deepEqual(turnCall.answers, all);
  assert.deepEqual(turnCall.decision, {}, 'from the first, only the page: here there is none');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(KEY) && !text.includes('Bearer'));
  assert.deepEqual(lines(path.join(h.runDir, 'events.jsonl')).filter(e => e.type === 'jev.read').map(e => e.id).sort(), [turnCall.id, jobCall.id].sort(), "events.jsonl's line for each call has its ID");
  assert.equal(lines(path.join(root, '.runs', 'delegation-audit.jsonl')).at(-1).jevCall, jobCall.id, 'the hand-off audit names the call it judged by');
});

test('a call that fails is recorded at once with why; the words still go to the agent, and their reading says how they went', async t => {
  let asked = 0;
  const { h, lives, calls } = await audited(t, () => ++asked === 1 ? { status: 503 } : { answers: { needs_agent: { noul: .7 }, behave: { noul: .1 }, design_talk: { noul: .1 }, lasting: { choice: 'this_moment' } } });
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  lives[0].say('operator', 'Run the tests again.', 0);
  lives[0].say('intermediary', ' Okay, the tests.', 900);
  await until(() => delivered.length === 1 && calls().length === 2);
  const [failed, unsent] = calls();
  assert.equal(failed.trigger, 'turn');
  assert.equal(failed.status, 503);
  assert.equal(failed.error, 'Jev returned HTTP 503');
  assert.equal(failed.answers, undefined);
  assert.ok(failed.state && failed.questions, 'what was asked, all the same');
  assert.equal(unsent.trigger, 'unsent');
  assert.equal(unsent.handOff, 'passed', 'Jev failing, the words went to the agent without its reading');
  assert.equal(unsent.requestId, delivered[0].id);
  assert.deepEqual(unsent.decision, { learned: false });
});

test("the quiet's request records what the voice tool did itself: the instruction learned, the settings chosen", async t => {
  const { h, calls } = await audited(t, () => ({ answers: { needs_agent: { noul: .1 }, ready: { noul: .9 },
    standby: { noul: .9 }, companion_only: { noul: .9 }, behave: { noul: .9 }, design_talk: { noul: .1 }, lasting: { choice: 'always' }, wakeThreshold: { choice: 'level_100', probabilities: { level_100: .8, level_50: .1 } } } }), { features: ['instructions', 'configuration'] });
  h.ask = async () => { throw new Error('no harness in tests'); };
  await turn(h, 'Stop waking up for every little thing from now on. Bye for now.');
  const quietCall = calls().find(c => c.made === 'quiet')!;
  assert.deepEqual(quietCall.decision, { outcome: 'keep', needed: false, companionOnly: true, finished: true, learned: 'always', settings: [{ name: 'wakeThreshold', from: 50, to: 100 }] }, "only about how the companion behaves: not the agent's, whatever the job delegation reads; the learner and the tuner act on it");
  assert.deepEqual(quietCall.config.features, ['instructions', 'configuration']);
  assert.ok('earlier_sessions' in quietCall.state && 'current_settings' in quietCall.state, "the tuner's state, as sent");
  assert.deepEqual(calls().find(c => c.made === 'ended')!.decision, {}, 'the same questions as GPT Live began to answer, acted on only for the page');
});

test("the page command Jev chose for the voice's words is recorded, and so is none", async t => {
  const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"',
    commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }], parts: [] };
  let asked = 0;
  const { h, calls } = await audited(t, () => ({ answers: { page_command: ++asked === 1 ? { choice: 'goto_options', probabilities: { goto_options: .8, next_section: .1, none: .1 } } : { choice: 'none', probabilities: { none: .9, goto_options: .05, next_section: .05 } }, page_more: { noul: .1 } } }));
  const ran: string[][] = [];
  h.stage = { tabId: 7, view, pages: new Map(), describe: async () => view, run: async (commands: string[]) => { ran.push(commands); return { done: [], onScreen: '' }; }, follow: async () => null, observe() {}, close() {} } as any;
  await h.presenter.show('The options are where it gets interesting.');
  await h.presenter.show('The repeat visit is a separate story.');
  assert.deepEqual(ran, [['goto_options']]);
  assert.deepEqual(calls().map(c => [c.trigger, c.decision, c.config.thresholds]), [['cue', { command: 'goto_options', step: 0, more: false }, { page_command: .45, page_more: .5 }], ['cue', { command: null, step: 0 }, { page_command: .45, page_more: .5 }]]);
});

test('a reading fdc has not finished acting on is recorded as it is when fdc stops, or 30 s after the call', async t => {
  const { h, calls } = await audited(t, () => ({ answers: { needs_agent: { noul: .1 }, ready: { noul: .9 }, standby: { noul: .2 } } }));
  const said = 'Just thinking out loud here.';
  await quietTurn(h, { utterances: [{ role: 'operator', text: said, endMs: 0 }], through: 0, seqs: [0], fresh: said }, [{ role: 'operator', text: said, at: Date.now() }], undefined);
  assert.deepEqual(calls(), [], "the quiet's request waits for the learner, which the mediator asks");
  await h.close();
  assert.deepEqual(calls().find(c => c.made === 'quiet')?.decision, { outcome: 'keep', needed: false, companionOnly: false, finished: true });
  const file = path.join(h.runDir, 'unit.jsonl'), audit = new JevAudit({ file, waitMs: 20 });
  const call = (id: string, more: Partial<JevCall> = {}): JevCall => ({ id, at: 0, trigger: 'turn', made: 'quiet', config: { url: '', model: '', timeoutMs: 0, features: [], thresholds: {} }, state: {}, questions: {}, ms: 0, answers: {}, ...more });
  audit.called(call('late'));
  audit.called(call('failed', { answers: undefined, error: 'timed out' }));
  assert.deepEqual(lines(file).map(c => c.id), ['failed'], 'a failed call at once');
  await settle(60);
  audit.decided('late', { outcome: 'send' }, true);
  assert.deepEqual(lines(file).map(c => [c.id, c.decision]), [['failed', undefined], ['late', undefined]], 'once written, a record is not written again');
});

test("words the operator goes on with while the quiet's request is read wait for the rest, through fdc's own wiring", async t => {
  const { h, lives, calls } = await audited(t, () => ({ answers: { needs_agent: { noul: .9 }, ready: { noul: .9 }, standby: { noul: .05 } } }));
  // The first quiet's reading takes a while, and the operator goes on meanwhile.
  let reading = false;
  const answer = h.jev!.fetch;
  h.jev!.fetch = async (url, init) => { if (/neither the operator nor the voice companion has spoken/.test(String(init.body)) && !reading) { reading = true; await settle(300); } return answer(url, init); };
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const live = lives[0], mediator = h.voiceSessions.mediator!;
  mediator.quietMs = 150;
  live.say('operator', 'Fix the header', 0);
  live.say('intermediary', ' Got it, the header', 900);
  await until(() => reading);
  live.say('operator', ' and the footer too.', 2500);
  await until(() => delivered.length === 1);
  await settle(100);
  assert.deepEqual(calls().find(c => c.made === 'quiet')!.decision, { outcome: 'wait', needed: true, companionOnly: false, finished: true, continued: true, learned: false }, 'what was read went on meanwhile: it waits');
  assert.equal(delivered.length, 1, 'not sent in pieces');
  assert.match(delivered[0].content, /Fix the header.*and the footer too\./s, 'sent once, whole, at the next quiet');
  assert.deepEqual(calls().filter(c => c.made === 'quiet').at(-1)!.decision, { outcome: 'send', needed: true, companionOnly: false, finished: true, neededBefore: true, learned: false });
});
