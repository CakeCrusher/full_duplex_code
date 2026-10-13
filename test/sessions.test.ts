// Turning running companions' voices on and off by voice: Jev's reading of a request, carried out across companions.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Mediator, type Screened } from '../src/core/mediator.ts';
import type { Harness } from '../src/core/bridge.ts';
import type { Judgment, Session } from '../src/core/delegation-audit.ts';
import { harness, until } from './live-fake.ts';

// Two companions in their own folders, both registered under one root, as two fdc runs are.
async function pair(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-sessions-')), folder = (name: string) => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; };
  const a = await harness(t, { cwd: folder('alpha') }, root), b = await harness(t, { cwd: folder('beta') }, root);
  // Beta's open page starts voice when asked, as web/app.ts does.
  const ws = { readyState: 1, bufferedAmount: 0, send(text: string) { const event = JSON.parse(text); if (event.type === 'voice_on') void b.h.startLive(undefined, page, 'fresh'); }, on() {}, terminate() {}, close() {} } as any;
  const page = { id: 'beta-page', ws, via: 'local', alive: true } as any;
  b.h.pages.all.set(ws, page); b.h.pages.send = (p, event) => p.ws.send(JSON.stringify(event));
  a.h.sessionSwitch.goodbyeMs = 10; a.h.sessionSwitch.confirmMs = 3000;
  return { a, b };
}
// Jev's reading, given by the test: which of the listed sessions to turn on and off.
function judge(h: Harness, reading: (sessions: Session[]) => Partial<NonNullable<Judgment['sessions']>>) {
  const seen: Session[][] = [];
  h.handOffAudit = { judge: async (_said: string, sessions: Session[]) => { seen.push(sessions); return { needsAgent: .1, sessions: { asked: .95, only: .95, unlisted: 0, turnOn: [], turnOff: [], ...reading(sessions) } }; } } as any;
  return seen;
}
const id = (sessions: Session[], folder: string) => sessions.find(s => s.folder === folder)!.id;

test('"switch to beta": beta\'s voice starts, alpha is told, then alpha\'s voice ends; nothing reaches the harness', async t => {
  const { a, b } = await pair(t);
  const seen = judge(a.h, sessions => ({ turnOn: [id(sessions, 'beta')], turnOff: [id(sessions, 'alpha')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const screened = await a.h.sessionSwitch.screen('Switch to beta.', 'r1');
  assert.deepEqual(seen[0].map(s => [s.folder, s.on, s.current]), [['alpha', true, true], ['beta', false, false]], 'Jev sees every running companion and whether its voice is on');
  assert.match(screened.handled!, /Nothing was sent to Claude Code.*Turning on the voice of beta\. Turning off the voice of this session once the others are on\./);
  await until(() => b.lives[0]?.state === 'active');
  await until(() => a.lives[0].state === 'closed');
  assert.ok(a.lives[0].appended.some(([kind, text]) => kind === 'thinking' && /Voice sessions: beta's voice is on; this session's voice ends/.test(text)));
  assert.equal(a.lives[0].closeReason, 'Switched to beta');
});

test('a companion that cannot start voice is reported, and this one stays on', async t => {
  const { a, b } = await pair(t);
  b.h.pages.all.clear();
  judge(a.h, sessions => ({ turnOn: [id(sessions, 'beta')], turnOff: [id(sessions, 'alpha')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  await a.h.sessionSwitch.screen('Switch to beta.', 'r1');
  await until(() => a.lives[0].appended.some(([, text]) => /^Voice sessions:/.test(text)));
  const outcome = a.lives[0].appended.find(([, text]) => /^Voice sessions:/.test(text))![1];
  assert.match(outcome, /beta's voice did not start: no page of it is open; this session stays on/);
  assert.equal(a.lives[0].state, 'active');
});

test('turning another companion off ends its voice', async t => {
  const { a, b } = await pair(t);
  await b.h.startLive(undefined, undefined, 'fresh');
  judge(a.h, sessions => ({ turnOff: [id(sessions, 'beta')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const screened = await a.h.sessionSwitch.screen('Turn off beta.', 'r1');
  assert.match(screened.handled!, /Turning off the voice of beta\./);
  await until(() => b.lives[0].state === 'closed');
  assert.equal(b.lives[0].closeReason, 'Turned off from alpha');
});

test('a session named that is not running changes nothing, even when Jev picks the nearest one; GPT Live hears which are running', async t => {
  const { a, b } = await pair(t);
  judge(a.h, sessions => ({ unlisted: .82, turnOn: [id(sessions, 'beta')], turnOff: [id(sessions, 'alpha')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const screened = await a.h.sessionSwitch.screen('Switch to gamma.', 'r1');
  assert.match(screened.handled!, /Nothing was sent.*The operator named a session that is not running; running now: alpha \(this one, voice on\), beta \(voice off\)\./);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(b.lives.length, 0); assert.equal(a.lives[0].state, 'active');
});

test('session changes asked together with work: the changes happen and the request still reaches the harness', async t => {
  const { a, b } = await pair(t);
  judge(a.h, sessions => ({ only: .2, turnOn: [id(sessions, 'beta')] }));
  await a.h.startLive(undefined, undefined, 'fresh');
  const screened = await a.h.sessionSwitch.screen('Start beta, and fix the failing parser test.', 'r1');
  assert.equal(screened.handled, undefined);
  assert.ok(a.lives[0].appended.some(([kind, text]) => kind === 'thinking' && /Turning on the voice of beta/.test(text)));
  await until(() => b.lives[0]?.state === 'active');
});

test('a request not about sessions goes on, with Jev\'s judgment of whether it needed the harness', async t => {
  const { a } = await pair(t);
  judge(a.h, () => ({ asked: .05, only: .02 }));
  await a.h.startLive(undefined, undefined, 'fresh');
  assert.deepEqual(await a.h.sessionSwitch.screen('Rename the parser.', 'r1'), { needsAgent: .1 });
});

// The mediator's side: a handled request never reaches the harness, and GPT Live's delegation gets fdc's answer instead.
function mediator(t: TestContext, screen: (said: string) => Promise<Screened>) {
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => {};
  const appends: [string, string, string | null][] = []; live.append = async (kind: string, content: string, delegationId: string | null) => { appends.push([kind, content, delegationId]); };
  const deliveries: any[] = [], recorded: any[] = [];
  const audit = { record: async (entry: any, judged?: number | null) => { recorded.push({ ...entry, judged }); return judged ?? null; } } as any;
  const m = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, audit, screen });
  t.after(() => { m.stop(); observer.close(); });
  live.emit('event', { type: 'session.input_transcript.delta', delta: 'Switch to beta.', start_ms: 0, end_ms: 800 });
  return { m, appends, deliveries, recorded };
}

test('the mediator: a handled request is answered to GPT Live\'s delegation and not sent; others are sent with Jev\'s judgment; a failed check sends', async t => {
  const handled = mediator(t, async () => ({ needsAgent: .1, handled: 'Nothing was sent to Claude Code: …' }));
  await handled.m.screened('r1', handled.m.history.request(Infinity)!, 'content', 'd1');
  assert.equal(handled.deliveries.length, 0);
  assert.deepEqual(handled.appends, [['thinking', 'Nothing was sent to Claude Code: …', 'd1']]);
  assert.equal(handled.m.history.request(Infinity), null, 'its words are not sent later, when voice ends');
  const passed = mediator(t, async () => ({ needsAgent: .8 }));
  await passed.m.screened('r2', passed.m.history.request(Infinity)!, 'content', 'd2');
  assert.equal(passed.deliveries.length, 1);
  await until(() => passed.recorded.length);
  assert.equal(passed.recorded[0].judged, .8, 'Jev is not asked a second time');
  const failing = mediator(t, async () => { throw new Error('Jev returned HTTP 500'); });
  await failing.m.screened('r3', failing.m.history.request(Infinity)!, 'content', 'd3');
  assert.equal(failing.deliveries.length, 1, 'in doubt, it reaches the harness');
});
