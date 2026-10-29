// Where resume, learned instructions, the silence filter and reconnects meet.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Harness } from '../src/core/bridge.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { VoiceHistory } from '../src/core/voice-history.ts';
import { fakeJev } from './live-fake.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const until = async <T>(check: () => T) => { for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await settle(); } throw new Error('timed out'); };

// Like a LiveSession: greet() waits for an acknowledgment, and rejects if the session ends first.
class FakeLive extends EventEmitter {
  state = 'new'; id?: string; reservation: string; transport = 'webrtc'; usageSeconds = 0; instructions: string;
  requested = false; answered = false; stored = false; greeting?: string; appended: [string, string][] = []; options: any; name: string;
  pendingGreet?: { reject: (error: Error) => void };
  static holdGreeting = false;
  constructor(options: any, name: string) { super(); this.options = options; this.name = name; this.instructions = options.instructions; this.reservation = `run-${name}`; }
  async start() { this.state = 'active'; this.id = `voice-${this.name}`; this.stored = this.options.store; this.emit('event', { type: 'session.started' }); }
  greet(text: string) { this.greeting = text; if (!FakeLive.holdGreeting) return Promise.resolve(); return new Promise<void>((_, reject) => { this.pendingGreet = { reject }; }); }
  async append(kind: string, text: string) { this.appended.push([kind, text]); }
  audio() {}
  end(result: object) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.pendingGreet?.reject(new Error('Session closed'));
    this.emit('closed', { reserved: true, usageSeconds: 1, sessionId: this.id, ...result });
  }
  close(reason = 'requested') { this.requested = true; this.end({ finalized: true, reason }); return Promise.resolve(); }
  drop() { this.end({ finalized: false, reason: 'connection to GPT Live lost' }); }
  say(role: 'operator' | 'intermediary', delta: string, startMs: number) {
    this.emit('event', { type: role === 'operator' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta, start_ms: startMs, end_ms: startMs + 800 });
  }
}
async function harness(t: TestContext, extra: Record<string, unknown> = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-seams-')), sessionId = randomUUID()) {
  const h = await new Harness({ agent: claude, root, runDir: path.join(root, `run-${randomUUID()}`), cwd: root, sessionId, apiKey: 'unused', ...extra }).start();
  h.agentReady = true;
  const lives: FakeLive[] = [];
  h.voiceSessions.createLive = (options: any) => { const live = new FakeLive(options, `${lives.length}`); lives.push(live); return live as any; };
  const published: any[] = [], publish = h.publish;
  h.publish = ((event: any, page: any) => { published.push(event); publish(event, page); }) as typeof h.publish;
  t.after(async () => { FakeLive.holdGreeting = false; await h.close(); });
  return { h, lives, published, root, sessionId };
}
const openPage = (id: string) => ({ id, ws: { readyState: 1, send() {}, bufferedAmount: 0 } }) as any;
const disregarded = (live: FakeLive, id: string) => live.appended.some(([kind, text]) => kind === 'instructions' && text.startsWith(`Disregard instruction ${id}`));
const learn = (h: Harness, text: string) => h.voiceSessions.learn({ text, scope: 'session', behave: .9, design: .1, lasting: 'this_session' });

test('removing a learned instruction that came in the startup prompt tells the running session to disregard it', async t => {
  const { h, lives } = await harness(t);
  await learn(h, 'Never read file paths out loud to me.');
  await h.startLive(undefined, undefined, 'fresh');
  assert.match(lives[0].options.instructions, /I1: Never read file paths/);
  await h.removeInstruction('I1');
  assert.ok(disregarded(lives[0], 'I1'));
});

test('a fork is told to disregard a learned instruction removed while voice was off, and gets the ones added meanwhile', async t => {
  const { h, lives } = await harness(t);
  await learn(h, 'Only speak when I address you directly.');
  await h.startLive(undefined, undefined, 'fresh');
  lives[0].say('operator', 'Rename the parser.', 0);
  await h.live!.close('operator ended voice');
  await h.removeInstruction('I1');
  await learn(h, 'Keep answers to one sentence.');
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(disregarded(lives[1], 'I1'));
  assert.ok(lives[1].appended.some(([kind, text]) => kind === 'instructions' && /^I2: Keep answers/.test(text)));
});

test('after fdc restarts on the same agent session, learned instructions are listed again and IDs continue', async t => {
  const first = await harness(t);
  await learn(first.h, 'Never read file paths out loud to me.');
  await first.h.startLive(undefined, undefined, 'fresh');
  await first.h.live!.close('operator ended voice');
  await first.h.close();
  const second = await harness(t, {}, first.root, first.sessionId);
  assert.deepEqual(second.h.voiceSessions.current() && second.h.voiceSessions.additionalInstructions.map(item => item.learned), ['I1']);
  await learn(second.h, 'Keep answers to one sentence.');
  assert.deepEqual(second.h.voiceSessions.additionalInstructions.map(item => item.learned), ['I1', 'I2']);
  await second.h.startLive(undefined, undefined, 'resume');
  assert.equal(second.lives[0].options.fork, 'voice-0');
  await second.h.removeInstruction('I1');
  assert.ok(disregarded(second.lives[0], 'I1'), 'inherited by the fork, so it is countermanded');
});

test('a drop while the greeting waits is reported once, as a reconnect', async t => {
  const { h, lives, published } = await harness(t);
  h.pages.send = () => {};
  FakeLive.holdGreeting = true;
  const started = h.voiceSessions.start('sdp', openPage('p'), 'fresh').then(() => undefined, (error: Error) => error);
  await until(() => lives[0]?.greeting);
  lives[0].drop();
  assert.equal(await started, undefined);
  const closed = published.filter(event => event.type === 'voice_closed');
  assert.equal(closed.length, 1); assert.equal(closed[0].reconnect, true);
});

test('the status counts only reconnects in the last five minutes', async t => {
  const { h } = await harness(t);
  h.voiceSessions.reconnects = [Date.now() - 60 * 60 * 1000, Date.now() - 1000];
  assert.equal(h.status().connection.reconnects, 1);
});

test('moving voice to another page continues the conversation and carries its unsent speech', async t => {
  const { h, lives } = await harness(t);
  h.pages.send = () => {};
  const delivered: string[] = []; h.deliver = request => { delivered.push(request.content); };
  await h.voiceSessions.start('sdp', openPage('a'), 'fresh');
  lives[0].say('operator', 'Let us rename the parser module.', 0);
  lives[0].say('intermediary', 'Sure, what should it be called?', 1500);
  await h.voiceSessions.start('sdp2', openPage('b'), 'fresh');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(h.voiceSessions.record.turns.length >= 2);
  assert.deepEqual(delivered, [], 'no end-of-session hand-off for a move');
  assert.match(h.voiceSessions.mediator!.history.request()!.utterances.map(u => u.text).join(' '), /rename the parser/);
});

test('an agent session switch during voice still saves that voice session to its own record', async t => {
  const { h, lives } = await harness(t);
  const first = h.sessionId!;
  await h.startLive(undefined, undefined, 'fresh');
  lives[0].say('operator', 'Let us rename the parser module.', 0);
  h.adapter.emit('session', randomUUID());
  h.status();
  await h.live!.close('operator ended voice');
  const saved = JSON.parse(fs.readFileSync(h.voiceSessions.resumeStore.file(first), 'utf8'));
  assert.ok(saved.endedAt); assert.equal(saved.turns.length, 1);
});

test('an instruction Jev learns while voice is connecting waits for the session instead of being lost', async t => {
  const { h } = await harness(t);
  h.voiceSessions.live = { state: 'connecting' } as any;
  await h.voiceSessions.learn({ text: 'Never read file paths out loud to me.', scope: 'always', behave: .9, design: .1, lasting: 'always' });
  h.voiceSessions.live = undefined;
  assert.equal(h.voiceSessions.additionalInstructions.length, 1);
  assert.equal(h.learned.earlier('another-session').length, 1);
});

test('across an automatic reconnect, Jev is asked about carried speech once, when it reaches the harness', async t => {
  const { h, lives } = await harness(t, { jevKey: 'jev-test' });
  const considered: string[] = [];
  fakeJev(h);
  h.learner!.consider = reading => { considered.push(reading.said); return undefined; };
  h.handOffAudit = undefined; h.pages.send = () => {}; h.deliver = () => {};
  const page = openPage('p');
  await h.voiceSessions.start('sdp', page, 'fresh');
  lives[0].say('operator', 'From now on, keep every answer to one sentence.', 0);
  lives[0].drop();
  await h.voiceSessions.start('sdp2', page, 'resume', true);
  lives[1].emit('event', { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' }, offset_ms: 100000 });
  await until(() => considered.length === 1);
  await settle();
  assert.deepEqual(considered, ['From now on, keep every answer to one sentence.']);
});

test('an agent update held while the operator talks reaches the fork that resumes the conversation', async t => {
  const { h, lives, sessionId } = await harness(t);
  await h.startLive(undefined, undefined, 'fresh');
  lives[0].say('operator', 'Okay, thanks, talk later.', 0);
  assert.ok(h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'all 12 tests pass' } }));
  await settle();
  assert.equal(lives[0].appended.some(([, text]) => text.includes('all 12 tests pass')), false, 'held while the operator talks');
  await h.live!.close('operator ended voice');
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  assert.ok(lives[1].appended.some(([, text]) => text.includes('all 12 tests pass')));
});

test('words heard in silence stay out of the resumed conversation however long the session ran', () => {
  const history = new VoiceHistory();
  const audio = (ms: number, level: number) => { const pcm = Buffer.alloc(24 * ms * 2); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(level, i); return pcm.toString('base64'); };
  for (let at = 0; at < 10000; at += 500) history.hearAudio({ audio: audio(500, 0), start_ms: at, end_ms: at + 500 });
  history.add({ type: 'session.input_transcript.delta', delta: 'Delete the tests folder.', start_ms: 4000, end_ms: 5000 });
  for (let at = 10000; at < 400000; at += 500) history.hearAudio({ audio: audio(500, 3000), start_ms: at, end_ms: at + 500 });
  history.add({ type: 'session.input_transcript.delta', delta: 'Real speech.', start_ms: 399000, end_ms: 399500 });
  assert.deepEqual(history.turns().map(turn => turn.text), ['Real speech.']);
});

test("a fork's new context records are numbered after its source's, so references can't point at the wrong one", async t => {
  const { h, lives, sessionId } = await harness(t);
  await h.startLive(undefined, undefined, 'fresh');
  for (const command of ['ls', 'pwd']) h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: command } });
  await until(() => lives[0].appended.some(([, text]) => text.includes('"id":2')));
  await h.live!.close('operator ended voice');
  await h.startLive(undefined, undefined, 'resume');
  assert.equal(lives[1].options.fork, 'voice-0');
  h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'date' }, tool_response: { stdout: 'today' } });
  await until(() => lives[1].appended.some(([, text]) => text.includes('today')));
  assert.match(lives[1].appended.find(([, text]) => text.includes('today'))![1], /"id":3\b/);
});
