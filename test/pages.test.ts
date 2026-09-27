import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Harness } from '../src/core/bridge.ts';
import { Pages } from '../src/core/pages.ts';
import { claude } from '../src/adapters/claude/index.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-pages-'));
  const harness = await new Harness({ agent: claude, root, runDir: path.join(root, 'run'), cwd: root, sessionId: randomUUID(), apiKey: 'unused-test-key' }).start();
  t.after(async () => { await harness.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return harness;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const until = async <T>(check: () => T) => { for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await settle(); } throw new Error('timed out'); };
const logged = (h: Harness, type: string) => fs.readFileSync(path.join(h.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === type);

// A companion page as the bridge sees it: a /voice socket and what it receives.
async function openPage(t: TestContext, h: Harness, token = h.browserToken) {
  const ws = new WebSocket(h.baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => ws.terminate());
  const events: any[] = [];
  ws.on('message', (data, isBinary) => { if (!isBinary) events.push(JSON.parse(data.toString())); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const id: string = (await until(() => events.find(e => e.type === 'page'))).id;
  return { ws, events, id, of: (type: string) => events.filter(e => e.type === type) };
}

// A voice connection that answers at once and records what the bridge asks of it.
class FakeLive extends EventEmitter {
  state = 'new'; id?: string; reservation: string; transport = 'webrtc'; usageSeconds = 0;
  frames = 0; closedFor?: string; result?: object; name: string;
  constructor(name: string) { super(); this.name = name; this.reservation = `run-${name}`; }
  async start(sdp: string) { this.state = 'active'; this.id = `voice-${this.name}`; this.emit('answer', `answer to ${sdp}`); this.emit('event', { type: 'session.started' }); }
  async greet() {}
  async append() {}
  audio() { this.frames++; }
  close(reason = 'requested') {
    if (this.state !== 'closed') { this.closedFor = reason; this.state = 'closed'; this.result = { finalized: true, reserved: true, usageSeconds: 0, sessionId: this.id }; this.emit('closed', this.result); }
    return Promise.resolve(this.result);
  }
}

test('any number of pages connect, each told who it is; one leaving does not affect the others', async t => {
  const h = await fixture(t);
  const laptop = await openPage(t, h), phone = await openPage(t, h);
  assert.notEqual(laptop.id, phone.id);
  for (const page of [laptop, phone]) assert.deepEqual(page.events.slice(0, 4).map(e => e.type), ['page', 'status', 'timeline_history', 'history']);
  h.publish({ type: 'agent_status', state: 'working', detail: 'Claude is working' });
  await until(() => laptop.of('agent_status').length && phone.of('agent_status').length);
  laptop.ws.close();
  await until(() => h.pages.size === 1);
  h.publish({ type: 'agent_status', state: 'idle', detail: 'Ready' });
  await until(() => phone.of('agent_status').length === 2);
  assert.equal(h.status().pages, 1);
  assert.deepEqual(logged(h, 'page.connected').map(e => e.page), [laptop.id, phone.id]);
  assert.deepEqual(logged(h, 'page.closed').map(e => e.page), [laptop.id]);
});

test('a link from an earlier start, and pages beyond the limit, are refused and logged', async t => {
  const h = await fixture(t);
  await assert.rejects(openPage(t, h, 'an-old-token'), /403/);
  const pages = [];
  for (let i = 0; i < Pages.LIMIT; i++) pages.push(await openPage(t, h));
  await assert.rejects(openPage(t, h), /403/);
  assert.deepEqual(logged(h, 'page.refused').map(e => e.reason), ['token', 'too many pages']);
});

test('voice belongs to the page that started it; Start on another page moves it there', async t => {
  const h = await fixture(t); h.agentReady = true;
  const lives: FakeLive[] = [];
  h.voiceSessions.createLive = () => { const live = new FakeLive(`${lives.length}`); lives.push(live); return live as any; };
  const laptop = await openPage(t, h), phone = await openPage(t, h);
  laptop.ws.send(JSON.stringify({ type: 'start', sdp: 'laptop offer' }));
  await until(() => laptop.of('voice_started').length);
  assert.deepEqual(laptop.of('voice_answer').map(e => e.sdp), ['answer to laptop offer']);
  assert.equal(phone.of('voice_answer').length + phone.of('voice_started').length, 0, 'the other page gets no voice events');
  h.publish(h.status()); await until(() => phone.of('status').at(-1)?.voicePage === laptop.id);
  // Only the page running voice is heard.
  phone.ws.send(Buffer.alloc(320)); laptop.ws.send(Buffer.alloc(320)); await settle();
  assert.equal(lives[0].frames, 1);

  phone.ws.send(JSON.stringify({ type: 'start', sdp: 'phone offer' }));
  await until(() => phone.of('voice_started').length);
  assert.equal(lives[0].closedFor, 'voice moved to another page');
  assert.deepEqual(laptop.of('voice_closed').map(e => e.moved), [true], 'the laptop is told its voice moved');
  assert.deepEqual(phone.of('voice_answer').map(e => e.sdp), ['answer to phone offer']);
  assert.equal(h.status().voicePage, phone.id);
  assert.deepEqual(logged(h, 'voice.moved').map(e => [e.from, e.to]), [[laptop.id, phone.id]]);
  laptop.ws.send(JSON.stringify({ type: 'stop' })); await settle();
  assert.equal(lives[1].state, 'active', 'a page without voice cannot end it');

  // The page running voice leaving ends it; another page leaving does not.
  laptop.ws.close(); await until(() => h.pages.size === 1);
  assert.equal(lives[1].state, 'active');
  phone.ws.close(); await until(() => lives[1].state === 'closed');
  assert.equal(lives[1].closedFor, 'voice client disconnected');
  assert.equal(h.status().voicePage, null);
});

test('a page that stops answering pings is closed', () => {
  const log: any[] = [];
  const pages = new Pages({ log: event => log.push(event), heartbeatMs: 60000 });
  const socket = () => Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, pings: 0, terminated: false, ping() { this.pings++; }, terminate() { this.terminated = true; } });
  const answering = socket(), silent = socket();
  pages.add(answering as any, 'local'); pages.add(silent as any, 'tunnel');
  pages.check(); answering.emit('pong');
  pages.check();
  assert.equal(silent.terminated, true); assert.equal(answering.terminated, false);
  assert.deepEqual(log.filter(e => e.type === 'page.unresponsive').map(e => e.via), ['tunnel']);
  pages.close();
});
