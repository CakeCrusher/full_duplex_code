import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { Harness } from '../src/core/bridge.ts';
import { Pages } from '../src/core/pages.ts';
import { AudioAudit } from '../src/core/audio-audit.ts';
import { LiveSession } from '../src/core/live-session.ts';
import { UsageLedger } from '../src/core/usage-ledger.ts';
import { MEDIA_STALLED, VoiceSessions } from '../src/core/voice-sessions.ts';
import { forkable, planFor, seedInput, wakePlanFor, INPUT_MESSAGES, INPUT_TOKENS, RECORDING_MS } from '../src/core/voice-resume.ts';
import { estimatedTokens } from '../src/core/text-fragments.ts';
import { claude } from '../src/adapters/claude/index.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const until = async <T>(check: () => T) => { for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await settle(); } throw new Error('timed out'); };
async function harness(t: TestContext, root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-resume-')), sessionId = randomUUID(), removeRoot = true) {
  const h = await new Harness({ agent: claude, root, runDir: path.join(root, 'run', randomUUID()), cwd: root, sessionId, apiKey: 'unused-test-key' }).start();
  h.agentReady = true;
  t.after(async () => { await h.close(); if (removeRoot) fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

// A voice connection that starts at once, or refuses a fork, and can drop without being asked.
class FakeLive extends EventEmitter {
  static failFork = false;
  state = 'new'; id?: string; reservation: string; transport = 'webrtc'; usageSeconds = 0; instructions: string;
  requested = false; answered = false; stored = false; greeting?: string; closedFor?: string; options: any; name: string;
  constructor(options: any, name: string) { super(); this.options = options; this.name = name; this.instructions = options.instructions; this.reservation = `run-${name}`; }
  async start() {
    if (this.options.fork && FakeLive.failFork) {
      this.state = 'closed'; this.emit('closed', { finalized: false, reserved: true, usageSeconds: 0, reason: 'connection to GPT Live lost' });
      throw new Error('OpenAI voice connection failed (HTTP 400: The stored session was not found.).');
    }
    this.state = 'active'; this.id = `voice-${this.name}`; this.stored = this.options.store;
    this.emit('event', { type: 'session.started' });
  }
  async greet(text: string) { this.greeting = text; }
  async append() {}
  audio() {}
  end(result: object) { if (this.state !== 'closed') { this.state = 'closed'; this.emit('closed', { reserved: true, usageSeconds: 1, sessionId: this.id, ...result }); } }
  close(reason = 'requested') { this.requested = true; this.closedFor = reason; this.end({ finalized: true, reason }); return Promise.resolve(); }
  drop() { this.end({ finalized: false, reason: 'connection to GPT Live lost' }); }
  say(role: 'operator' | 'intermediary', delta: string, startMs: number) {
    this.emit('event', { type: role === 'operator' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta, start_ms: startMs, end_ms: startMs + 800 });
  }
}
function fakeLives(h: Harness) {
  const lives: FakeLive[] = [];
  h.voiceSessions.createLive = options => { const live = new FakeLive(options, `${lives.length}`); lives.push(live); return live as any; };
  return lives;
}
async function openPage(t: TestContext, h: Harness) {
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${h.browserToken}` } });
  t.after(() => ws.terminate());
  const events: any[] = [];
  ws.on('message', (data, isBinary) => { if (!isBinary) events.push(JSON.parse(data.toString())); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await until(() => events.find(e => e.type === 'page'));
  return { ws, of: (type: string) => events.filter(e => e.type === type), send: (event: object) => ws.send(JSON.stringify(event)) };
}
const texts = (input: any[]) => input.map(m => [m.role, m.content[0].text]);

test('Resume forks a stored session (a dropped one once OpenAI has stored it); otherwise it seeds the conversation; Start fresh does neither', () => {
  const now = Date.now(), turns = [{ role: 'operator' as const, text: 'Hi' }];
  const stored = { liveSessionId: 'live_1', stored: true, finalized: true, endedAt: now - 1000, turns };
  assert.equal(planFor(stored, 'resume'), 'fork');
  assert.equal(planFor(stored, 'fresh'), 'fresh');
  assert.equal(planFor({ ...stored, finalized: false }, 'resume'), 'seed', 'just dropped: OpenAI is still storing it');
  assert.equal(planFor({ ...stored, finalized: false, endedAt: now - 10000 }, 'resume'), 'fork', 'a dropped stored session is forkable seconds later');
  assert.equal(planFor({ ...stored, stored: false }, 'resume'), 'seed', 'storage off or refused');
  assert.equal(planFor({ ...stored, endedAt: now - RECORDING_MS - 1 }, 'resume'), 'seed', 'recordings are kept 30 days');
  assert.equal(planFor({ ...stored, stored: false, turns: [] }, 'resume'), 'fresh', 'nothing to resume');
  assert.equal(forkable({ ...stored, liveSessionId: undefined }), false);
});

test('the seed keeps the startup input and the newest turns within 128 messages and 8,192 tokens', () => {
  const startup = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Attached to Claude Code.' }] }];
  const many = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? 'intermediary' as const : 'operator' as const, text: `turn ${i}` }));
  const short = seedInput(startup, many);
  assert.equal(short.length, INPUT_MESSAGES);
  assert.deepEqual(short[0], startup[0], 'the startup note stays first');
  assert.deepEqual(texts(short.slice(-2)), [['user', 'turn 298'], ['assistant', 'turn 299']], 'newest turns, oldest first');
  assert.equal(short.at(-1).content[0].type, 'output_text', 'GPT Live turns are assistant output');
  const long = Array.from({ length: 40 }, (_, i) => ({ role: 'operator' as const, text: `${i} ${'word '.repeat(700)}` }));
  const seeded = seedInput(startup, long);
  const total = seeded.reduce((n, m) => n + estimatedTokens(m.content[0].text), 0);
  assert.ok(total < INPUT_TOKENS - 256, `${total} tokens`); assert.ok(seeded.length > 2 && seeded.length < 40);
  assert.match(seeded.at(-1).content[0].text, /^…?39 /, 'the newest turn is kept');
});

test('Resume works after fdc restarts on the same agent session, and falls back to the conversation when a fork is refused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-resume-')), sessionId = randomUUID();
  const first = await harness(t, root, sessionId, false), lives = fakeLives(first);
  assert.equal(first.status().resume.plan, 'fresh');
  await first.startLive(undefined, undefined, 'fresh');
  assert.equal(lives[0].options.store, true, 'stored by default');
  lives[0].say('operator', 'Let us rename the parser module.', 0);
  lives[0].say('intermediary', 'Sure, what should it be called?', 1500);
  await first.live!.close('operator ended voice');
  const file = path.join(root, '.runs', 'voice-resume', `${sessionId}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  await first.close();

  const second = await harness(t, root, sessionId), again = fakeLives(second);
  assert.deepEqual(second.status().resume, { plan: 'fork', fork: true, turns: 2, store: true });
  await second.startLive(undefined, undefined, 'resume');
  assert.equal(again[0].options.fork, 'voice-0'); assert.deepEqual(again[0].options.input, [], 'a fork inherits its input');
  assert.match(again[0].greeting!, /conversation continues/);
  await second.live!.close('operator ended voice');

  FakeLive.failFork = true; t.after(() => { FakeLive.failFork = false; });
  await second.startLive(undefined, undefined, 'resume');
  assert.equal(again.length, 3); assert.equal(again[1].options.fork, again[0].id, 'the last session, itself a fork, is the one forked');
  const seeded = again[2];
  assert.equal(seeded.options.fork, undefined); assert.equal(seeded.state, 'active');
  assert.deepEqual(texts(seeded.options.input.slice(-2)), [['user', 'Let us rename the parser module.'], ['assistant', 'Sure, what should it be called?']]);
  assert.equal(seeded.options.input[0].role, 'developer', 'the startup note stays');
  await second.live!.close('operator ended voice');
  FakeLive.failFork = false;

  await second.startLive(undefined, undefined, 'fresh');
  assert.equal(again[3].options.fork, undefined); assert.equal(again[3].options.input.length, 1, 'Start fresh: no conversation');
  await second.live!.close('operator ended voice');
  assert.equal(second.status().resume.turns, 0, 'Start fresh begins a new conversation');
});

test('voice that drops reconnects by itself at most twice in 5 minutes, without a hand-off until it gives up', async t => {
  const h = await harness(t), lives = fakeLives(h), page = await openPage(t, h);
  page.send({ type: 'start', sdp: 'offer', mode: 'fresh' });
  await until(() => page.of('voice_started').length === 1);
  lives[0].say('operator', 'Please add a test for the parser.', 0);
  lives[0].drop();
  await until(() => page.of('voice_closed').length === 1);
  assert.equal(page.of('voice_closed')[0].reconnect, true);
  assert.equal([...h.outbox.values()].length, 0, 'no hand-off while reconnecting');
  assert.equal(h.status().connection.lastDrop?.reason, 'connection to GPT Live lost');

  for (const n of [2, 3]) {
    page.send({ type: 'start', sdp: `offer ${n}`, mode: 'resume', automatic: true });
    await until(() => page.of('voice_started').length === n);
    assert.equal(page.of('voice_started').at(-1).automatic, true);
    assert.match(lives[n - 1].greeting!, /reconnected/);
    assert.equal(lives[n - 1].options.fork, undefined, 'a dropped session is seeded');
    assert.ok(lives[n - 1].options.input.some((m: any) => /test for the parser/.test(m.content[0].text)));
    lives[n - 1].drop();
    await until(() => page.of('voice_closed').length === n);
  }
  const last = page.of('voice_closed').at(-1);
  assert.equal(last.reconnect, undefined); assert.equal(last.dropped, true, 'a third drop within 5 minutes is not reconnected');
  const sent = [...h.outbox.values()];
  assert.equal(sent.length, 1, 'the unsent speech reaches the agent once');
  assert.match(sent[0].content, /user: Please add a test for the parser\.$/);

  // Ending voice, or another page taking it, never reconnects.
  h.voiceSessions.reconnects = [];
  page.send({ type: 'start', sdp: 'offer 4', mode: 'resume' });
  await until(() => page.of('voice_started').length === 4);
  page.send({ type: 'stop' });
  await until(() => page.of('voice_closed').length === 4);
  assert.equal(page.of('voice_closed').at(-1).reconnect, undefined);
});

test('the watchdog does not count startup, and names a stalled GPT Live stream apart from a silent microphone', async t => {
  const voice = new VoiceSessions({ root: os.tmpdir() } as any);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  t.after(() => { clearInterval(voice.audioWatchdog); t.mock.timers.reset(); });
  const watched = (name: string) => { const live = new FakeLive({ instructions: '' }, name); live.state = 'active'; voice.live = live as any; voice.watch(live as any); return live; };
  voice.lastAudioAt = 0; voice.pageAudioAt = 0;
  const first = watched('a');
  t.mock.timers.tick(14000);
  assert.equal(first.state, 'active', 'the first audio gets 15 s after GPT Live starts');
  voice.lastAudioAt = Date.now();
  t.mock.timers.tick(3000); voice.pageAudioAt = Date.now();
  t.mock.timers.tick(3000);
  assert.equal(first.closedFor, MEDIA_STALLED, 'the page still sends microphone audio');
  const second = watched('b'); voice.lastAudioAt = Date.now();
  t.mock.timers.tick(6000);
  assert.equal(second.closedFor, 'Microphone audio stream stopped');
});

test('a backlogged page keeps voice: its audit gap is recorded, and its heartbeat counts late messages', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-audit-gap-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log: any[] = [], errors: Error[] = [];
  const audit = new AudioAudit({ dir, log: event => log.push(event), onError: error => errors.push(error) });
  audit.write('playback', Buffer.alloc(960), { offsetSamples: 0 });
  audit.allowGap('playback');
  audit.write('playback', Buffer.alloc(960), { offsetSamples: 24000 * 60 });
  assert.deepEqual(errors, []);
  assert.equal(log.find(e => e.type === 'audio.audit_gap').reason, 'audit_paused');
  audit.write('playback', Buffer.alloc(960), { offsetSamples: 24000 * 120 });
  assert.match(String((errors as Error[])[0]?.message), /discontinuity/, 'an unexplained gap still fails the audit (not voice)');

  const pages = new Pages({ log: () => {}, heartbeatMs: 60000 });
  const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, terminated: false, ping() {}, terminate() { this.terminated = true; } });
  pages.add(socket as any, 'tunnel');
  pages.check(); socket.emit('message', Buffer.from('{}'));
  pages.check(); assert.equal(socket.terminated, false, 'messages behind a backlog still arrive');
  pages.check(); assert.equal(socket.terminated, true);
  pages.close();
});

test('a fork asks only for storage, over WebSocket and WebRTC, and the Live close code is logged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-fork-'));
  const requests: { url?: string; body: any }[] = [], starts: { url?: string; event: any }[] = [], logs: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ session: { id: 'live_child' }, transport: { type: 'webrtc', sdp: 'answer' } }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (ws, req) => {
    if (req.url?.endsWith('/attach')) ws.send(JSON.stringify({ type: 'session.started', session: { id: 'live_child', store: true, instructions: 'inherited' } }));
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); starts.push({ url: req.url, event });
      if (event.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started', session: { id: 'live_ws_child', store: false } }));
      if (event.type === 'session.close') ws.close(4000, 'test close');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/live/sessions`, budget = new UsageLedger(path.join(dir, 'budget.json'));

  const ws = new LiveSession({ apiKey: 'k', budget, url, store: true, fork: 'live_parent', instructions: 'ignored', input: [{ ignored: true }], log: event => logs.push(event) });
  await ws.start();
  assert.equal(starts[0].url, '/v1/live/sessions/live_parent/fork');
  assert.deepEqual(starts[0].event.session, { store: true, audio: { format: { type: 'audio/pcm', rate: 24000 } } });
  assert.equal(ws.stored, false, 'OpenAI says whether it stored the session');
  const result = await ws.close();
  assert.equal(result.closeCode, 4000);
  assert.deepEqual(logs.filter(e => e.type === 'bridge.live_socket_closed').map(e => [e.code, e.reason]), [[4000, 'test close']]);

  const rtc = new LiveSession({ apiKey: 'k', budget, url, store: true, fork: 'live_parent' });
  let answer; rtc.on('answer', sdp => answer = sdp);
  await rtc.start('offer');
  assert.equal(requests[0].url, '/v1/live/sessions/live_parent/fork');
  assert.deepEqual(requests[0].body, { session: { store: true }, transport: { type: 'webrtc', sdp: 'offer' } });
  assert.equal(answer, 'answer'); assert.equal(rtc.answered, true);
  assert.equal(rtc.instructions, 'inherited', 'the prompt shown is the one the fork inherited');
  rtc.abort('test done');
});

test("a wake resumes the paused session while its first instructions are the ones in force and its context has room", () => {
  const page = (slide: number, total = '1.2 million') => `What the page "Since your feedback" says:\n## Header\nSince your feedback${slide} / 30\n## Cost\nStandby saved ${total} seconds of voice this month, about a quarter of it.`;
  const record = { liveSessionId: 'live_1', stored: true, finalized: true, endedAt: Date.now() - 20000, turns: [{ role: 'operator' as const, text: 'Next.' }], prompt: 'aaa', firstInstructions: 'all1', pageText: page(12), context: .3 };
  const now = { prompt: 'aaa', instructions: 'all1', pageText: page(12) };
  assert.deepEqual(wakePlanFor(record, now), ['fork']);
  assert.deepEqual(wakePlanFor(record, { ...now, pageText: page(13) }), ['fork'], 'the deck moved on a slide: its counter changed, nothing else');
  assert.deepEqual(wakePlanFor(record, { ...now, pageText: undefined }), ['fork'], "a page that can't be read in time doesn't stop it");
  assert.deepEqual(wakePlanFor(record, { ...now, pageText: page(12, '3.4 thousand') }), ['seed', 'the page changed'], 'its first instructions hold other words: a new session gets these');
  assert.deepEqual(wakePlanFor(record, { ...now, pageText: '' }), ['seed', 'the page changed'], 'the page closed');
  assert.deepEqual(wakePlanFor({ ...record, pageText: undefined }, { ...now, pageText: '' }), ['fork'], 'no page then, none now');
  assert.deepEqual(wakePlanFor(record, { ...now, instructions: 'all2' }), ['seed', 'the instructions changed'], 'an instruction learned since would only be appended conversation in a fork');
  assert.deepEqual(wakePlanFor({ ...record, context: .62 }, now), ['seed', 'its context reached 62%'], 'GPT Live compacts at 90%, keeping only the first instructions');
  assert.deepEqual(wakePlanFor(record, now, true), ['seed', 'a fork failed lately']);
  assert.deepEqual(wakePlanFor(record, { ...now, prompt: 'bbb' }), ['seed', 'not forkable'], "fdc's own instructions changed");
  assert.deepEqual(wakePlanFor({ ...record, stored: false, turns: [] }, now), ['fresh', 'not forkable']);
});

test("a session that started under other instructions of fdc's own is rebuilt from its text, not forked: a fork keeps its first instructions", () => {
  const record = { liveSessionId: 'live_1', stored: true, finalized: true, endedAt: Date.now() - 60000, turns: [{ role: 'operator' as const, text: 'Next.' }], prompt: 'aaa' };
  assert.equal(planFor(record, 'resume', 'aaa'), 'fork');
  assert.equal(planFor(record, 'resume', 'bbb'), 'seed', 'instructions changed since');
  assert.equal(planFor({ ...record, prompt: undefined }, 'resume', 'aaa'), 'seed', 'from before fdc kept track');
});
