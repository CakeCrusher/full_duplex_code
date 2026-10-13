import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Mediator } from '../src/core/mediator.ts';
import { DelegationAudit } from '../src/core/delegation-audit.ts';
import type { VoiceRequest } from '../src/core/adapter.ts';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const observer = new ClaudeObserver({ sessionId: 'test' });
  const live: any = new EventEmitter(); live.state = 'active'; live.id = 'live_1'; live.close = () => { live.state = 'closed'; };
  live.append = async () => {};
  const deliveries: VoiceRequest[] = [], recorded: any[] = [];
  const audit = { record: async (entry: any) => { recorded.push(entry); } } as unknown as DelegationAudit;
  const mediator = new Mediator({ live, observer, deliver: task => deliveries.push(task), log: () => {}, publish: () => {}, clean: String, hold: null, audit });
  t.after(() => { mediator.stop(); observer.close(); });
  const say = (delta: string, start_ms: number) => live.emit('event', { type: 'session.input_transcript.delta', delta, start_ms, end_ms: start_ms + 800 });
  const settle = async (ms: number) => { t.mock.timers.tick(ms); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { live, mediator, deliveries, recorded, say, settle };
}

test('speech GPT Live kept is recorded as answered only when voice ends and it reaches the harness', async t => {
  const f = fixture(t);
  f.say('Oh, definitely. Just go ahead and merge it.', 0);
  await f.settle(20000);
  assert.equal(f.recorded.length, 0, 'a pause alone records nothing'); assert.equal(f.deliveries.length, 0, 'the audit never sends');
  f.mediator.handOff('operator ended voice');
  await f.settle(10);
  assert.equal(f.deliveries.length, 1, 'the ordinary hand-off when voice ends');
  assert.deepEqual(f.recorded.map(r => [r.handOff, r.said, r.requestId]), [['answered', 'Oh, definitely. Just go ahead and merge it.', f.deliveries[0].id]]);
});

test('a request GPT Live passed on is recorded as passed, and not again as answered', async t => {
  const f = fixture(t);
  f.say('Add a test for the parser.', 0);
  f.live.emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 900 });
  await f.settle(9000);
  assert.equal(f.deliveries.length, 1, 'the ordinary request');
  assert.deepEqual(f.recorded.map(r => [r.handOff, r.said, r.delegationId, r.requestId]), [['passed', 'Add a test for the parser.', 'd1', f.deliveries[0].id]]);
});

test('the record keeps the words, what GPT Live did and Jev\'s judgment, owner-only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-audit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'delegation-audit.jsonl');
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ answers: { needs_agent: { noul: 0.91 } } }) });
  const audit = new DelegationAudit({ apiKey: 'k', file, log: () => {}, fetch });
  await audit.record({ handOff: 'answered', said: 'Merge it.', voiceSessionId: 'live_1' });
  const [entry] = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entry.handOff, 'answered'); assert.equal(entry.said, 'Merge it.'); assert.equal(entry.needsAgent, 0.91);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const failing = new DelegationAudit({ apiKey: 'k', file, log: () => {}, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await failing.record({ handOff: 'passed', said: 'Fix it.' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[1]).needsAgent, null, 'a failed judgment is still recorded');
});
