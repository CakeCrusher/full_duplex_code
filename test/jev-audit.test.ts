// Every Jev call is recorded in the run's jev.jsonl: what fdc asked (configured and sent), what Jev answered, and what fdc
// did with it (jev-audit.ts).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JevAudit, type JevCall } from '../src/core/jev-audit.ts';
import type { StageView } from '../src/core/stage.ts';
import { harness, page, settle, turn, until } from './live-fake.ts';

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
  const job = { needs_agent: { noul: .8 }, ready: { noul: .9 } };
  const { h, lives, root, file, calls } = await audited(t, body => ({ answers: body.questions.needs_agent ? job : own }));
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  lives[0].say('operator', 'Fix the header, please.', 0);
  lives[0].say('intermediary', ` Got it, passing that on. ${KEY}`, 900);
  await until(() => delivered.length === 1 && calls().length === 2);
  const turnCall = calls().find(c => c.trigger === 'turn')!, jobCall = calls().find(c => c.trigger === 'job')!;
  assert.equal(jobCall.requestId, delivered[0].id, 'the request the words went to the agent by');
  assert.equal(turnCall.requestId, delivered[0].id);
  assert.deepEqual(jobCall.config, { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', timeoutMs: 3000, features: ['instructions'], thresholds: { needs_agent: .4, ready: .2 } });
  assert.equal(jobCall.state.latest, 'user: Fix the header, please.');
  assert.match(jobCall.state.setting, /^An operator talks by voice/);
  assert.match(jobCall.state.voice_reply, /^Got it, passing that on\. \[redacted\]$/, 'written without the secrets fdc knows');
  assert.match((jobCall.questions.needs_agent as any).instructions, /Do the latest words need the coding agent/);
  assert.deepEqual(jobCall.answers, job, 'the answers as returned');
  assert.equal(jobCall.status, 200);
  assert.ok(jobCall.ms >= 0);
  assert.deepEqual(jobCall.decision, { outcome: 'send', needed: true, finished: true });
  assert.deepEqual(turnCall.config.thresholds, { companion_only: .85, standby: .7, behave: .6, design_talk: .5 });
  assert.deepEqual(turnCall.answers, own);
  assert.deepEqual(turnCall.decision, { standby: false, companionOnly: false, learned: false }, "the voice tool's own actions, then the learner's");
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

test("the voice tool's own reading records what came of it: Standby, the instruction learned, the settings chosen", async t => {
  const { h, calls } = await audited(t, body => ({ answers: body.questions.needs_agent ? { needs_agent: { noul: .1 }, ready: { noul: .9 } }
    : { standby: { noul: .9 }, companion_only: { noul: .9 }, behave: { noul: .9 }, design_talk: { noul: .1 }, lasting: { choice: 'always' }, wakeThreshold: { choice: 'level_100', probabilities: { level_100: .8, level_50: .1 } } } }), { features: ['instructions', 'configuration'] });
  h.ask = async () => { throw new Error('no harness in tests'); };
  const decision = await turn(h, 'Stop waking up for every little thing from now on. Bye for now.');
  h.consider(decision.actions!.reading!);
  const turnCall = calls().find(c => c.trigger === 'turn')!;
  assert.deepEqual(turnCall.decision, { standby: true, companionOnly: true, learned: 'always', settings: [{ name: 'wakeThreshold', from: 50, to: 100 }] });
  assert.deepEqual(turnCall.config.features, ['instructions', 'configuration']);
  assert.ok('earlier_sessions' in turnCall.state && 'current_settings' in turnCall.state, "the tuner's state, as sent");
  assert.deepEqual(calls().find(c => c.trigger === 'job')!.decision, { outcome: 'keep', needed: false, finished: true });
});

test("the page command Jev chose for the voice's words is recorded, and so is none", async t => {
  const view: StageView = { tabId: 7, title: 'Briefing', url: 'http://localhost/b.html', about: null, where: 'section "Intro"',
    commands: [{ id: 'next_section', say: 'Go to the next section' }, { id: 'goto_options', say: 'Go to the section "Options"' }], parts: [] };
  let asked = 0;
  const { h, calls } = await audited(t, () => ({ answers: { page_command: ++asked === 1 ? { choice: 'goto_options', probabilities: { goto_options: .8, next_section: .1, none: .1 } } : { choice: 'none', probabilities: { none: .9, goto_options: .05, next_section: .05 } } } }));
  const ran: string[][] = [];
  h.stage = { tabId: 7, view, pages: new Map(), describe: async () => view, run: async (commands: string[]) => { ran.push(commands); return { done: [], onScreen: '' }; }, follow: async () => null, observe() {}, close() {} } as any;
  await h.presenter.judgedMove('the options');
  await h.presenter.judgedMove('the repeat visit');
  assert.deepEqual(ran, [['goto_options']]);
  assert.deepEqual(calls().map(c => [c.trigger, c.decision, c.config.thresholds]), [['cue', { command: 'goto_options' }, { page_command: .45 }], ['cue', { command: null }, { page_command: .45 }]]);
});

test('a reading fdc has not finished acting on is recorded as it is when fdc stops, or 30 s after the call', async t => {
  const { h, calls } = await audited(t, body => ({ answers: body.questions.needs_agent ? { needs_agent: { noul: .1 }, ready: { noul: .9 } } : { standby: { noul: .2 } } }));
  await turn(h, 'Just thinking out loud here.');
  assert.deepEqual(calls().map(c => c.trigger), ['job'], "the voice tool's own reading waits for the learner, which the mediator asks");
  await h.close();
  assert.deepEqual(calls().find(c => c.trigger === 'turn')?.decision, { standby: false, companionOnly: false });
  const file = path.join(h.runDir, 'unit.jsonl'), audit = new JevAudit({ file, waitMs: 20 });
  const call = (id: string, more: Partial<JevCall> = {}): JevCall => ({ id, at: 0, trigger: 'job', config: { url: '', model: '', timeoutMs: 0, features: [], thresholds: {} }, state: {}, questions: {}, ms: 0, answers: {}, ...more });
  audit.called(call('late'));
  audit.called(call('failed', { answers: undefined, error: 'timed out' }));
  assert.deepEqual(lines(file).map(c => c.id), ['failed'], 'a failed call at once');
  await settle(60);
  audit.decided('late', { outcome: 'send' }, true);
  assert.deepEqual(lines(file).map(c => [c.id, c.decision]), [['failed', undefined], ['late', undefined]], 'once written, a record is not written again');
});

test("words the operator goes on with before the job delegation decides wait for the rest, through fdc's own wiring", async t => {
  const { h, lives, calls } = await audited(t, body => ({ answers: body.questions.needs_agent ? { needs_agent: { noul: .9 }, ready: { noul: .9 } } : { standby: { noul: .05 } } }));
  const delivered: any[] = []; h.deliver = (request: any) => { delivered.push(request); };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const live = lives[0], mediator = h.voiceSessions.mediator!;
  Object.assign(mediator, { replyMs: 3000, replyStartMs: 1000, operatorQuietMs: 60000 });
  live.say('operator', 'Fix the header', 0);
  live.say('intermediary', ' Got it, the header', 900);
  await until(() => calls().some(c => c.trigger === 'turn'));
  live.say('operator', ' and the footer too.', 2500);
  await until(() => calls().some(c => c.trigger === 'job'));
  await settle(50);
  assert.equal(delivered.length, 0, 'not sent in pieces');
  assert.deepEqual(calls().find(c => c.trigger === 'job')!.decision, { outcome: 'wait', needed: true, finished: true, continued: true });
  mediator.replyStartMs = 50;
  mediator.turnEnded('turn');
  await until(() => delivered.length === 1);
  assert.match(delivered[0].content, /Fix the header.*and the footer too\./s, 'sent once, whole');
  assert.deepEqual(calls().filter(c => c.trigger === 'job').at(-1)!.decision, { outcome: 'send', needed: true, finished: true, neededBefore: true });
});
