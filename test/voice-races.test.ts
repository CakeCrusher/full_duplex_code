// Voice sessions under real event order: moves during a greeting, removals while a session
// starts or ends, carried speech, what a fork catches up on and Jev's tuning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Harness } from '../src/core/bridge.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { ClaudeObserver } from '../src/adapters/claude/observer.ts';
import { Mediator } from '../src/core/mediator.ts';
import { Live, page, harness, learn, disregarded, settle, until } from './live-fake.ts';

test('moving voice while a resumed session greets creates only the moved session, and leaves it in charge', async t => {
  const { h, lives, published } = await harness(t);
  const A = page('A'), B = page('B');
  await h.voiceSessions.start('sdp-A0', A, 'fresh');
  lives[0].say('operator', 'Rename the parser module please.', 0);
  await h.live!.close('operator ended voice');
  Live.hold = kind => kind === 'commentary';
  const startA = h.voiceSessions.start('sdp-A1', A, 'resume').then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);
  await until(() => lives[1]?.greeting);
  assert.equal(lives[1].options.fork, 'voice-0');
  Live.deferStart.add('2');
  const startB = h.voiceSessions.start('sdp-B', B, 'resume');
  await settle(100);
  assert.equal(await startA, 'resolved');
  Live.hold = () => false;
  lives[2].begin(); await startB; await settle(20);
  assert.equal(lives.length, 3, "only page B's session");
  assert.equal(h.live, lives[2] as any); assert.equal(h.voiceSessions.page, B); assert.equal(h.mediator!.live, lives[2] as any);
  assert.ok(!published.some(p => p.page === 'A' && p.event.type === 'fault'));
});

test('moving voice while a fresh session greets tells the first page once, that voice moved', async t => {
  const { h, lives, published } = await harness(t, { store: false });
  const A = page('A'), B = page('B');
  Live.hold = kind => kind === 'commentary';
  const startA = h.voiceSessions.start('sdp-A0', A, 'fresh').then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);
  await until(() => lives[0]?.greeting);
  Live.deferStart.add('1');
  h.voiceSessions.start('sdp-B', B, 'resume').catch(() => {});
  assert.equal(await startA, 'resolved');
  assert.equal(lives.length, 2);
  const closedA = published.filter(p => p.page === 'A' && p.event.type === 'voice_closed');
  assert.equal(closedA.length, 1); assert.equal(closedA[0].event.moved, true);
});

test('a learned instruction removed while a fresh session connects is countermanded once it starts', async t => {
  const { h, lives } = await harness(t);
  await learn(h, 'Never read file paths out loud to me.');
  Live.deferStart.add('0');
  const started = h.voiceSessions.start('sdp', page('A'), 'fresh');
  await settle(10);
  assert.match(lives[0].options.instructions, /I1: Never read file paths/);
  await h.removeInstruction('I1');
  lives[0].begin(); await started;
  assert.ok(disregarded(lives[0], 'I1'));
  assert.deepEqual(h.voiceSessions.record.inForce, []);
});

test('a learned instruction removed while voice ends is countermanded in the fork that continues it', async t => {
  const { h, lives } = await harness(t);
  await learn(h, 'Never read file paths out loud to me.');
  await h.startLive(undefined, undefined, 'fresh');
  const closing = h.live!.close('operator ended voice');
  await h.removeInstruction('I1');
  await closing;
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(disregarded(lives[1], 'I1'));
});

test('after a restart, learned IDs continue even past removed ones', async t => {
  const first = await harness(t);
  await learn(first.h, 'Never read file paths out loud to me.');
  await learn(first.h, 'Keep answers to one sentence.');
  await first.h.startLive(undefined, undefined, 'fresh');
  await first.h.live!.close('operator ended voice');
  await first.h.removeInstruction('I2');
  await first.h.close();
  const second = await harness(t, {}, first.root, first.sessionId);
  second.h.status();
  await learn(second.h, 'Speak more slowly.');
  assert.equal(second.h.voiceSessions.additionalInstructions.at(-1)!.learned, 'I3');
});

test('an instruction removed before GPT Live acknowledged it is out of force for other sessions, with no late cue', async t => {
  const { h, lives, published } = await harness(t);
  await h.startLive(undefined, undefined, 'fresh');
  Live.hold = (kind, text) => kind === 'instructions' && text.startsWith('I1:');
  const learning = learn(h, 'Never read file paths out loud to me.');
  await until(() => lives[0].pending.size);
  await h.removeInstruction('I1');
  lives[0].ack();
  await learning; await settle(10);
  assert.deepEqual(h.learned.earlier('another-session'), []);
  const events = published.map(p => p.event.type).filter(type => type.startsWith('instruction_'));
  assert.deepEqual(events, ['instruction_learned', 'instruction_removed']);
  assert.ok(disregarded(lives[0], 'I1'), 'acknowledged after its removal, so countermanded at once');
});

test('a drop while a fork is told to disregard an instruction is reported once, as its close', async t => {
  const { h, lives, published } = await harness(t);
  const A = page('A');
  await learn(h, 'Never read file paths out loud to me.');
  await h.voiceSessions.start('sdp0', A, 'fresh');
  await h.live!.close('operator ended voice');
  await h.removeInstruction('I1');
  Live.hold = (kind, text) => kind === 'instructions' && text.startsWith('Disregard');
  const resumed = h.voiceSessions.start('sdp1', A, 'resume');
  await until(() => lives[1]?.pending.size);
  const before = published.length;
  lives[1].drop();
  await resumed; await settle(10);
  assert.ok(!published.slice(before).some(p => p.event.type === 'fault'));
});

test('after /clear, removing an instruction learned before it takes it out of force for other sessions', async t => {
  const { h } = await harness(t);
  await learn(h, 'Never read file paths out loud to me.');
  h.adapter.emit('session', 'cleared-session');
  await h.removeInstruction('I1');
  assert.deepEqual(h.learned.earlier('x'), []);
});

test("carried speech reaches the agent once, even if the replacement takes longer to start than the hand-off's wait", async t => {
  const { h, lives } = await harness(t);
  const delivered: string[] = []; h.deliver = request => { delivered.push(request.content); };
  const A = page('A');
  await h.voiceSessions.start('sdp', A, 'fresh');
  lives[0].say('operator', 'Please merge the branch.', 0);
  lives[0].drop();
  Live.deferStart.add('1');
  const restarted = h.voiceSessions.start('sdp2', A, 'resume', true);
  await settle(10);
  // What the hand-off's timer would do, while the replacement is still connecting.
  if (h.voiceSessions.carried) clearTimeout(h.voiceSessions.carried.timer);
  assert.equal(delivered.length, 0, 'the replacement holds it while it starts');
  lives[1].begin(); await restarted;
  lives[1].emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 100000 });
  await until(() => delivered.length >= 1);
  await settle(50);
  assert.equal(delivered.filter(content => content.includes('merge the branch')).length, 1);
});

test('after a context append fails, the fork gets the update GPT Live never acknowledged', async t => {
  const { h, lives, sessionId } = await harness(t);
  await h.startLive(undefined, undefined, 'fresh');
  Live.hold = (kind, text) => kind === 'thinking' && text.includes('all 12 tests pass');
  h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'all 12 tests pass' } });
  await until(() => lives[0].pending.size);
  lives[0].rejectHeld();
  await until(() => lives[0].state === 'closed');
  Live.hold = () => false;
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(lives[1].appended.some(([, text]) => text.includes('all 12 tests pass')));
});

test("a fork that ends before its catch-up went out leaves that work for the next fork", async t => {
  const { h, lives, sessionId } = await harness(t);
  await h.startLive(undefined, undefined, 'fresh');
  await h.live!.close('operator ended voice');
  h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: { stdout: 'pushed to origin/feature-x' } });
  const pushed = h.adapter.history().at(-1)!; pushed.at -= 60000; h.voiceSessions.record.endedAt! -= 120000; h.voiceSessions.record.deliveredThrough! -= 120000;
  Live.deferStart.add('1');
  const resumed = h.startLive(undefined, undefined, 'resume');
  await settle(10);
  lives[1].say('operator', 'Hold on, I need to go.', 0);
  lives[1].begin(); await resumed;
  await h.live!.close('operator ended voice');
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[2].options.fork, 'voice-1');
  assert.ok(lives[1].appended.some(([, x]) => x.includes('feature-x')) || lives[2].appended.some(([, x]) => x.includes('feature-x')));
});

test('after fdc restarts, a fork is not told that work from before its source ended is new', async t => {
  const first = await harness(t);
  await first.h.startLive(undefined, undefined, 'fresh');
  const transcript = path.join(first.root, `${first.sessionId}.jsonl`), written = new Date().toISOString();
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'u1', sessionId: first.sessionId, timestamp: written, message: { content: 'Rename the parser module to tokenizer.' } },
    { type: 'assistant', sessionId: first.sessionId, timestamp: written, message: { id: 'm1', content: [{ type: 'text', text: 'Renamed parser.ts to tokenizer.ts and updated 14 imports; all tests pass.' }] } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  await settle(5);
  await first.h.live!.close('operator ended voice');
  await first.h.close();
  const second = await harness(t, {}, first.root, first.sessionId);
  second.h.observer.hook({ session_id: first.sessionId, hook_event_name: 'SessionStart', transcript_path: transcript });
  await second.h.startLive(undefined, undefined, 'resume');
  assert.equal(second.lives[0].options.fork, 'voice-0');
  const catchUp = second.lives[0].appended.find(([, x]) => x.startsWith('This voice connection continues'))?.[1] ?? '';
  assert.ok(!catchUp.includes('14 imports'));
});

test('instructions restored after a restart bring back the settings Jev chose for them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-retune-')), sessionId = randomUUID();
  const make = () => {
    const h = new Harness({ agent: claude, root, runDir: path.join(root, `run-${randomUUID()}`), cwd: root, sessionId, apiKey: 'unused', jevKey: 'k', features: ['instructions', 'configuration'] });
    // Jev picks the longest hold for an operator who talks at length.
    h.jev = { read: async (moment: any) => ({ trigger: moment.trigger, said: '', transcript: '', needsAgent: null, tuning: moment.instructions.some((i: string) => /talk at length/.test(i)) ? { holdLongestMs: { choice: 'level_20000' } } : {} }) } as any;
    return h;
  };
  const first = make(); await first.start(); first.agentReady = true;
  await learn(first, 'I talk at length, never cut in while I am talking.');
  await settle(1300);
  assert.equal(first.tuning.holdLongestMs, 20000);
  await first.close();
  const second = make(); await second.start(); t.after(() => second.close());
  second.status();
  await settle(1300);
  assert.equal(second.tuning.holdLongestMs, 20000);
});

test('with the transcript observed, text held behind a later hook at the end of voice reaches the fork', async t => {
  const { h, lives, sessionId } = await harness(t, { observation: 'transcript' });
  await h.startLive(undefined, undefined, 'fresh');
  const writtenAt = Date.now();
  await settle(30);
  h.observer.hook({ session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  (h.observer as any).record({ type: 'assistant', sessionId, timestamp: new Date(writtenAt).toISOString(), message: { id: 'm1', content: [{ type: 'text', text: 'Found it: the tokenizer drops trailing commas, fixing now.' }] } });
  await h.live!.close('operator ended voice');
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(lives[1].appended.some(([, text]) => text.includes('trailing commas')));
});

test('with the transcript observed, text written before voice ended but read after it reaches the fork', async t => {
  const { h, lives, sessionId } = await harness(t, { observation: 'transcript' });
  await h.startLive(undefined, undefined, 'fresh');
  const writtenAt = Date.now();
  await settle(30);
  await h.live!.close('operator ended voice');
  await settle(30);
  (h.observer as any).record({ type: 'assistant', sessionId, timestamp: new Date(writtenAt).toISOString(), message: { id: 'm2', content: [{ type: 'text', text: 'Pushed the fix to origin/feature-commas.' }] } });
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(lives[1].appended.some(([, text]) => text.includes('feature-commas')));
});
