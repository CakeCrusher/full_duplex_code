// Turning running companions' voices on and off by voice: Jev's reading of a request, carried out across companions.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Mediator, type Decision } from '../src/core/mediator.ts';
import type { Harness } from '../src/core/bridge.ts';
import { Jev, type Reading, type Session, type SessionsJudgment } from '../src/core/jev.ts';
import { handledNote } from '../src/core/prompts.ts';
import { decides, fakeJev, harness, turn, until } from './live-fake.ts';

// Two companions in their own folders, both registered under one root, as two fdc runs are.
async function pair(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-sessions-')), folder = (name: string) => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; };
  const a = await harness(t, { cwd: folder('alpha') }, root), b = await harness(t, { cwd: folder('beta') }, root);
  // Beta's open page starts voice when asked, as web/app.ts does.
  const ws = { readyState: 1, bufferedAmount: 0, send(text: string) { const event = JSON.parse(text); if (event.type === 'voice_on') void b.h.startLive(undefined, page, 'fresh'); }, on() {}, terminate() {}, close() {} } as any;
  const page = { id: 'beta-page', ws, via: 'local', alive: true, ready: { microphone: 'granted', clicked: true } } as any;
  b.h.pages.all.set(ws, page); b.h.pages.send = (p, event) => p.ws.send(JSON.stringify(event));
  a.h.sessionSwitch.goodbyeMs = 10; a.h.sessionSwitch.confirmMs = 3000;
  return { a, b };
}
// Jev's reading, given by the test: which of the listed sessions to turn on and off.
function judge(h: Harness, reading: (sessions: Session[]) => Partial<SessionsJudgment>, needsAgent = .1) {
  const seen: Session[][] = [];
  fakeJev(h, moment => {
    // The job delegation reads no sessions: only whether the words need the agent.
    if (moment.trigger === 'job') return { needsAgent };
    seen.push(moment.sessions!); return { sessions: { asked: .95, unlisted: 0, turnOn: [], turnOff: [], ...reading(moment.sessions!) } };
  });
  return seen;
}
const reading = (r: Partial<Reading>): Reading => ({ trigger: 'turn', said: '', transcript: '', needsAgent: null, ...r });
const id = (sessions: Session[], folder: string) => sessions.find(s => s.folder === folder)!.id;

test('"switch to beta": beta\'s voice starts, alpha is told, then alpha\'s voice ends; nothing reaches the harness', async t => {
  const { a, b } = await pair(t);
  const seen = judge(a.h, sessions => ({ turnOn: [id(sessions, 'beta')], turnOff: [id(sessions, 'alpha')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const decided = await turn(a.h, 'Switch to beta.');
  assert.deepEqual(seen[0].map(s => [s.folder, s.on, s.current]), [['alpha', true, true], ['beta', false, false]], 'Jev sees every running companion and whether its voice is on');
  // As the page's list shows each one: folder, agent, session ID and state, then what hovering it shows.
  assert.match(seen[0][0].shown, /^alpha · Claude Code · [0-9a-f]{8} · Voice on \(Claude Code .* open · started .*\)$/);
  assert.match(seen[0][1].shown, /^beta · Claude Code · [0-9a-f]{8} · Ready \(/);
  assert.equal(decided.send, false);
  assert.match(decided.told!, /changing voice sessions as the operator asked: Turning on the voice of beta \([0-9a-f]{8}\)\. Turning off the voice of this session once the others are on\./);
  await until(() => b.lives[0]?.state === 'active');
  await until(() => a.lives[0].state === 'closed');
  assert.ok(a.lives[0].appended.some(([kind, text]) => kind === 'thinking' && /Voice sessions: the voice of beta \([0-9a-f]{8}\) is on; this session's voice ends/.test(text)));
  assert.match(a.lives[0].closeReason!, /^Switched to beta \([0-9a-f]{8}\)$/);
});

test('Jev reads each session as the page lists it, so the operator can name one by its session ID', async t => {
  const { a } = await pair(t);
  let sent: any;
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers: {} }) }; } });
  const sessions = await a.h.sessionSwitch.sessions(), [alpha, beta] = sessions.map(s => s.sessionId);
  await jev.read({ trigger: 'delegation', latest: { role: 'operator', text: `Turn off the ${beta!.slice(0, 3).split('').join(' ')} session.` }, sessions });
  assert.match(sent.state.sessions, new RegExp(`^session_1 \\(the one the operator is speaking to now\\): alpha · Claude Code · ${alpha} · [^\\n]+ \\(Claude Code [^\\n]+ · started [^\\n]+\\)\\nsession_2: beta · Claude Code · ${beta} · Ready \\(`));
  assert.match(sent.state.setting, /a session ID by its first characters/);
  assert.match(sent.questions.session_2.instructions, new RegExp(`session_2 \\(beta \\(${beta}\\)\\)`));
  assert.match(sent.questions.session_2.criteria.turn_on, new RegExp(`clearly means beta \\(${beta}\\)`));
});

test('a companion that cannot start voice is reported, and this one stays on', async t => {
  const { a, b } = await pair(t);
  b.h.pages.all.clear();
  judge(a.h, sessions => ({ turnOn: [id(sessions, 'beta')], turnOff: [id(sessions, 'alpha')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  await turn(a.h, 'Switch to beta.');
  await until(() => a.lives[0].appended.some(([, text]) => /^Voice sessions:/.test(text)));
  const outcome = a.lives[0].appended.find(([, text]) => /^Voice sessions:/.test(text))![1];
  assert.match(outcome, /the voice of beta \([0-9a-f]{8}\) can't start: no page of it is open.*; this session stays on/);
  assert.equal(a.lives[0].state, 'active');
});

test('turning another companion off ends its voice', async t => {
  const { a, b } = await pair(t);
  await b.h.startLive(undefined, undefined, 'fresh');
  judge(a.h, sessions => ({ turnOff: [id(sessions, 'beta')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const decided = await turn(a.h, 'Turn off beta.');
  assert.match(decided.told!, /Turning off the voice of beta \([0-9a-f]{8}\)\./);
  await until(() => b.lives[0].state === 'closed');
  assert.equal(b.lives[0].closeReason, 'Turned off from alpha');
});

test('a session named that is not running changes nothing, even when Jev picks the nearest one; GPT Live hears which are running', async t => {
  const { a, b } = await pair(t);
  judge(a.h, sessions => ({ unlisted: .82, turnOn: [id(sessions, 'beta')], turnOff: [id(sessions, 'alpha')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const decided = await turn(a.h, 'Switch to gamma.');
  assert.match(decided.told!, /changing voice sessions as the operator asked: The operator named a session that is not running; running now: alpha · Claude Code · [0-9a-f]{8} · Voice on \(.*\), this one; beta · Claude Code · [0-9a-f]{8} · Ready \(.*\)\./);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(b.lives.length, 0); assert.equal(a.lives[0].state, 'active');
});

test('session changes asked together with work: the changes happen and the words still reach the harness', async t => {
  const { a, b } = await pair(t);
  judge(a.h, sessions => ({ only: .2, turnOn: [id(sessions, 'beta')] }), .9);
  await a.h.startLive(undefined, undefined, 'fresh');
  const decided = await turn(a.h, 'Start beta, and fix the failing parser test.');
  assert.equal(decided.send, true);
  assert.match(decided.told!, /changing voice sessions as the operator asked: Turning on the voice of beta/, 'GPT Live hears what changes');
  await until(() => b.lives[0]?.state === 'active');
});

test("words not about sessions reach the harness when Jev finds they need it, and stay with the voice when not", async t => {
  const { a } = await pair(t);
  judge(a.h, () => ({ asked: .05, only: .02 }), .9);
  await a.h.startLive(undefined, undefined, 'fresh');
  const work = await turn(a.h, 'Rename the parser.');
  assert.deepEqual([work.send, work.told, work.reading?.needsAgent], [true, undefined, .9]);
  judge(a.h, () => ({ asked: .05, only: .02 }), .1);
  const question = await turn(a.h, 'What did it rename?');
  assert.deepEqual([question.send, question.note], [false, undefined], 'kept with no note: the voice answers it');
});

// The mediator's side: words the voice tool handled never reach the harness, and GPT Live asking to pass them on hears
// what was done instead.
function mediator(t: TestContext, route: (request: any) => Promise<Decision>) {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  const appends: [string, string, string | null][] = []; live.append = async (kind: string, content: string, delegationId: string | null) => { appends.push([kind, content, delegationId]); };
  const deliveries: any[] = [], recorded: any[] = [];
  const audit = { record: (entry: any, needsAgent: number | null) => { recorded.push({ ...entry, judged: needsAgent }); } } as any;
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, audit, route: decides(route) });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Switch to beta.', start_ms: 0, end_ms: 800 });
  return { m, appends, deliveries, recorded };
}
const handled = (needsAgent = .1): Decision => ({ reading: reading({ needsAgent }), send: false, note: handledNote('companion'), told: 'Nothing was sent to Claude Code: …' });

test('speech fdc handled itself is not sent: the next request carries it, noted, with what came before and after', async t => {
  let asks = 0;
  const f = mediator(t, async () => ++asks === 1 ? handled() : { reading: reading({ needsAgent: .9 }), send: true });
  const say = (delta: string, start_ms: number, end_ms: number) => f.m.liveEvent({ type: 'session.input_transcript.delta', delta, start_ms, end_ms });
  // The fixture's first words stand for part A, unfinished; then a tangent fdc handles.
  say(' Oh, and stop waking up for every little thing.', 1000, 3000);
  f.m.decide('turn'); await until(() => f.appends.length);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.m.history.delegatedThrough, -1, 'nothing reached the agent');
  assert.deepEqual(f.recorded.map(r => [r.handOff, r.judged]), [['kept', .1]], 'what was kept is audited, where lost work would show');
  f.m.decide('turn');
  assert.equal(asks, 1, 'the same words are read once');
  say('And show what it would cost.', 9000, 11000);
  f.m.decide('turn'); await until(() => f.deliveries.length);
  assert.equal(asks, 2, 'Jev judges only the new words the second time');
  assert.match(f.deliveries[0].content, /voice tool has done that part\. Act on the rest/);
  assert.match(f.deliveries[0].content, /user: Switch to beta\. Oh, and stop waking up for every little thing\.\nuser: And show what it would cost\.$/);
  assert.equal(f.m.history.delegatedThrough, -1, 'not delegated until the agent has it');
  f.m.delivered(f.deliveries[0].id);
  assert.equal(f.m.history.delegatedThrough, 2);
  f.m.handOff('requested');
  assert.equal(f.deliveries.length, 1, 'nothing is left to hand off');
});

test('a request whose delivery was uncertain goes again with the next one, noted; one handled after voice ended goes at once', async t => {
  const f = mediator(t, async () => ({ reading: reading({ needsAgent: .9 }), send: true }));
  f.m.decide('turn'); await until(() => f.deliveries.length);
  f.m.undelivered(f.deliveries[0].id);
  f.m.liveEvent({ type: 'session.input_transcript.delta', delta: 'Then run the tests.', start_ms: 5000, end_ms: 6000 });
  f.m.decide('turn'); await until(() => f.deliveries.length === 2);
  assert.match(f.deliveries[1].content, /may have reached you already/);
  assert.match(f.deliveries[1].content, /user: Switch to beta\.\nuser: Then run the tests\.$/);
  let answer!: (decision: Decision) => void;
  const late = mediator(t, () => new Promise(resolve => { answer = resolve; }));
  late.m.decide('turn'); await until(() => answer);
  late.m.handOff('operator ended voice');
  assert.equal(late.deliveries.length, 0, 'the words Jev is still reading are not handed off twice');
  answer(handled());
  await until(() => late.deliveries.length);
  assert.match(late.deliveries[0].content, /^\[Voice session ended: operator ended voice\][^\n]*voice tool has done that part[^\n]*\n\nuser: Switch to beta\.$/);
});

test("the mediator: GPT Live asking to pass on handled words hears what was done; sent words carry Jev's judgment; Jev failing sends", async t => {
  const f = mediator(t, async () => handled());
  f.m.decide('delegation', 'd1'); await until(() => f.appends.length);
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(f.appends, [['thinking', 'Nothing was sent to Claude Code: …', 'd1']]);
  assert.match(f.m.history.request()!.notes!.join(' '), /voice tool has done that part/, 'its words are not delegated: they go with the next request, noted');
  f.m.decide('delegation', 'd2'); await until(() => f.appends.length === 2);
  assert.deepEqual(f.appends[1], ['thinking', 'Nothing was sent to Claude Code: …', 'd2'], 'asked again for words already read, it hears the same');
  const passed = mediator(t, async () => ({ reading: reading({ needsAgent: .8 }), send: true }));
  passed.m.decide('turn');
  await until(() => passed.recorded.length);
  assert.equal(passed.deliveries.length, 1);
  assert.deepEqual([passed.recorded[0].handOff, passed.recorded[0].judged], ['passed', .8], 'Jev is not asked a second time');
  const kept = mediator(t, async () => ({ reading: reading({ needsAgent: .2 }), send: false }));
  kept.m.decide('delegation', 'd3'); await until(() => kept.appends.length);
  assert.equal(kept.deliveries.length, 0);
  assert.match(kept.appends[0][1], /^Nothing was sent to Claude Code: the voice tool found the operator's words need nothing from Claude/);
  const failing = mediator(t, async () => { throw new Error('Jev returned HTTP 500'); });
  failing.m.decide('turn'); await until(() => failing.deliveries.length);
  assert.equal(failing.deliveries.length, 1, 'in doubt, it reaches the harness');
});

test('a tab that has not been clicked, or allowed the microphone, is reported at once instead of waited for', async t => {
  const { a, b } = await pair(t);
  const page = [...b.h.pages.all.values()][0];
  judge(a.h, sessions => ({ turnOn: [id(sessions, 'beta')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  page.ready = { microphone: 'granted', clicked: false };
  const started = Date.now();
  await turn(a.h, 'Turn on beta too.');
  await until(() => a.lives[0].appended.some(([, text]) => /^Voice sessions:/.test(text)));
  assert.match(a.lives[0].appended.find(([, text]) => /^Voice sessions:/.test(text))![1], /the voice of beta \([0-9a-f]{8}\) can't start: its page has not been clicked since it opened/);
  assert.ok(Date.now() - started < 2000);
  page.ready = { microphone: 'prompt', clicked: true };
  assert.match(b.h.status().voiceBlocked!, /not been allowed the microphone/);
  page.ready = { microphone: 'denied', clicked: true };
  assert.match(b.h.status().voiceBlocked!, /blocked from the microphone/);
  page.ready = { microphone: 'granted', clicked: true };
  assert.equal(b.h.status().voiceBlocked, null);
  assert.equal(b.lives.length, 0);
});

test("words only about how the companion behaves are handled by fdc: the harness never gets them, Jev learns and tunes from them", async t => {
  const { a } = await pair(t);
  fakeJev(a.h, () => ({ needsAgent: .2, companionOnly: .9, sessions: { asked: .05, unlisted: 0, turnOn: [], turnOff: [] } }));
  const decided = await turn(a.h, "Stop waking up for every little thing.");
  assert.equal(decided.send, false);
  assert.match(decided.told!, /The operator told you how you should behave/);
  assert.equal(decided.note, handledNote('companion'));
  // The mediator's side: the voice tool's own reading is considered for an instruction and the settings, once, and nothing
  // is delivered.
  const considered: Reading[] = [];
  const m = mediator(t, async () => decided);
  m.m.consider = r => considered.push(r);
  m.m.decide('turn'); await until(() => considered.length);
  assert.equal(m.deliveries.length, 0);
  assert.deepEqual(considered, [decided.actions!.reading]);
  fakeJev(a.h, () => ({ needsAgent: .9, companionOnly: .3, sessions: { asked: .05, unlisted: 0, turnOn: [], turnOff: [] } }));
  const sent = await turn(a.h, "Make the companion pause less in the code.");
  assert.equal(sent.send, true, 'in doubt, it reaches the harness');
});
