// Standby: voice that stays quiet disconnects GPT Live and keeps listening; speech or agent news wakes it.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Activity, priceFor, priceOf } from '../src/core/activity.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';
import { STANDBY } from '../src/core/voice-sessions.ts';
import { Timeline } from '../src/core/timeline.ts';
import { stripTypes } from '../src/core/page.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { CueTracker } from '../web/cues.ts';
import { harness, learn, Live, page, settle, until } from './live-fake.ts';

const WINDOW = 2000;
// The operator speaking for about this long, as the page's level reports (0.1 s each) say.
const speak = (h: any, reports: number, voiced?: number, at = Date.now()) => { for (let i = 0; i < reports; i++) h.voiceSessions.heard({ at, inputRms: .05, rawInputRms: .05, gateThreshold: .008, voiced }); };
const agent = (h: any, data: Record<string, unknown>) => h.adapter.observations.observe({ session_id: h.sessionId, ...data });
const later = (ms: number) => Date.now() + ms;

async function quiet(t: TestContext, extra: Record<string, unknown> = {}) {
  const f = await harness(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 10 }, ...extra });
  const voicePage = page('voice-page');
  Object.assign(voicePage.ws, { terminate() {}, close() {}, on() {} });
  f.h.pages.all.set(voicePage.ws, voicePage);
  await f.h.startLive(undefined, voicePage, 'fresh');
  f.lives[0].say('operator', 'Add a dark mode toggle.', 0); f.lives[0].say('intermediary', 'On it.', 1000);
  const sent = (type: string) => f.published.filter(p => p.event.type === type && p.page === 'voice-page').map(p => p.event);
  // Quiet for the whole window: Standby.
  const goQuiet = async () => { f.h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => f.lives.at(-1)!.state === 'closed'); };
  return { ...f, voicePage, sent, goQuiet };
}

test('a quiet conversation goes on Standby: GPT Live closes, voice stays on, and the page keeps listening', async t => {
  const { h, lives, voicePage, sent, goQuiet } = await quiet(t);
  h.voiceSessions.checkStandby(later(WINDOW - 500));
  assert.equal(lives[0].state, 'active', 'a session gets the whole window first');
  await goQuiet();
  assert.equal(lives[0].closeReason, STANDBY);
  assert.deepEqual(sent('voice_closed').map(e => e.standby), [true], 'the page is told to keep its microphone');
  assert.ok(h.voiceSessions.listensTo(voicePage) && h.status().standby, 'voice is on Standby, listening to that page');
  assert.equal(h.status().voicePage, 'voice-page', 'other pages see voice as on here');
  assert.equal(h.outbox.size, 0, 'nothing was handed to the agent: the conversation continues');
  assert.equal(lives.length, 1);
});

test('speech wakes it, priced like everything else, and the paused session resumes: a fork, not greeted, with nothing added first', async t => {
  const { h, lives, sent, goQuiet } = await quiet(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 30 } });
  await goQuiet();
  speak(h, 2); h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, `a voice's first tenth of a second only starts it; the next is worth ${DEFAULT_TUNING.speechPrice}, under a threshold of 30`);
  speak(h, 1); h.voiceSessions.checkStandby();
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['operator']);
  // The page reconnects on the same microphone.
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[1]?.state === 'active' && !h.status().standby);
  assert.equal(lives[1].options.fork, lives[0].id, 'a fork of the paused session: GPT Live keeps everything it had');
  assert.equal(lives[1].greeting, undefined, 'no greeting');
  await new Promise(resolve => setTimeout(resolve, 50));
  // Appends right after a wake took GPT Live's timeline from the operator's words.
  assert.deepEqual(lives[1].appended, [], 'the operator speaking is the cue: nothing is added or said first');
});

test("a wake starts a new session with the page in it when the paused one doesn't hold the page as it is now; once it does, wakes resume it", async t => {
  const { h, lives, goQuiet } = await quiet(t);
  const view = { tabId: 1, title: 'Plan', url: 'http://127.0.0.1:8765/plan.html', about: null, where: 'Goals', commands: [], parts: [{ name: 'Goals', text: 'Ship the dark mode toggle by Friday.' }] };
  // The agent opened a page while voice was paused: the paused session never had its text.
  h.voiceSessions.stageNow = async () => view;
  await goQuiet();
  const wake = async (n: number) => { speak(h, 10); h.voiceSessions.checkStandby(); await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true); await until(() => lives[n]?.state === 'active'); };
  await wake(1);
  assert.equal(lives[1].options.fork, undefined, 'not a fork: a fork keeps its source\'s first instructions, without this page');
  assert.ok(lives[1].options.instructions.includes('Ship the dark mode toggle by Friday.'), 'the page in it from its start');
  assert.ok(lives[1].options.input.some((item: any) => item.role === 'user' && /dark mode/.test(item.content[0].text)), 'seeded with the conversation');
  // Told at the start, not by an append: appends right after a wake took GPT Live's timeline from the operator's words.
  assert.ok(lives[1].options.input.some((item: any) => item.role === 'developer' && /The conversation continues.*Don't greet.*Sound from the operator woke it.*If no words of theirs arrive, say nothing/s.test(item.content[0].text)), 'told why in its startup input');
  const starting = fs.readFileSync(`${h.runDir}/events.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'voice.starting').at(-1);
  assert.equal(starting.seeded, 'the page changed', 'logged why it did not resume');
  // Quiet again, the page as it was: the next wake resumes, and the page isn't told again.
  h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[1].state === 'closed');
  await wake(2);
  assert.equal(lives[2].options.fork, lives[1].id);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(lives[2].appended, [], 'it knows the page: nothing added');
});

test('a wake starts afresh, all its instructions in its startup, after one was learned or once the context is past 60%; the next one resumes', async t => {
  const { h, lives, goQuiet } = await quiet(t);
  const wake = async (n: number) => { speak(h, 10); h.voiceSessions.checkStandby(); await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true); await until(() => lives[n]?.state === 'active'); };
  const sleep = async (n: number) => { h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[n].state === 'closed'); };
  await learn(h, 'Keep answers under two sentences.');
  await goQuiet(); await wake(1);
  assert.equal(lives[1].options.fork, undefined, 'a fork would hold it only as appended conversation, which a later instruction can displace');
  assert.match(lives[1].options.instructions, /I1: Keep answers under two sentences/);
  await sleep(1); await wake(2);
  assert.equal(lives[2].options.fork, lives[1].id, 'its instructions are the ones in force: it resumes');
  // GPT Live compacts a conversation at 90%, keeping only its first instructions and about 8,000 tokens of the rest.
  lives[2].emit('event', { type: 'session.usage.updated', usage: { seconds: 40 }, context_window: { usage_ratio: .65 } });
  await sleep(2); await wake(3);
  assert.equal(lives[3].options.fork, undefined, 'past 60%: afresh');
  await sleep(3); await wake(4);
  assert.equal(lives[4].options.fork, lives[3].id);
});

test("a wake's fork that never starts gives way to a seeded session on the same microphone, and wakes seed for a while after", async t => {
  const { h, lives, sent, goQuiet } = await quiet(t);
  await goQuiet();
  // OpenAI answers the fork but never starts it.
  Live.deferStart.add('1');
  speak(h, 10); h.voiceSessions.checkStandby();
  const starting = h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[1]?.state === 'connecting');
  assert.equal(lives[1].options.fork, lives[0].id);
  lives[1].answered = true; lives[1].abort('session startup timed out');
  await starting;
  const closed = sent('voice_closed').at(-1);
  assert.deepEqual([closed.reconnect, closed.waking], [true, true], 'the page starts again, still waking, and keeps the words it holds');
  assert.ok(h.status().standby, 'voice is still waking from Standby');
  assert.equal(new CueTracker().cue(closed), null, 'no end sound: voice is still waking');
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[2]?.state === 'active' && !h.status().standby);
  assert.equal(lives[2].options.fork, undefined, 'seeded instead');
  h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[2].state === 'closed');
  speak(h, 10); h.voiceSessions.checkStandby();
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[3]?.state === 'active');
  assert.equal(lives[3].options.fork, undefined, 'after a fork failed, wakes seed rather than wait on another');
});

test("the operator's held words still going in after a wake hold the agent's updates, as their talking does", async t => {
  const { h } = await quiet(t);
  const floor = h.voiceSessions.mediator!.floor;
  floor.heardAt = -Infinity;
  h.voiceSessions.mediator!.hear({ at: Date.now(), inputRms: 0, backlogMs: 0 });
  assert.equal(floor.held(), false);
  h.voiceSessions.mediator!.hear({ at: Date.now(), inputRms: 0, backlogMs: 2400 });
  assert.equal(floor.held(), true);
});

test("chewing, typing and knocks don't wake it: only a voice that lasts does", async t => {
  const { h, sent, goQuiet } = await quiet(t);
  await goQuiet();
  speak(h, 30, 0); h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, 'loud, but no voice in it (chewing, typing)');
  for (let i = 0; i < 10; i++) speak(h, 1, 1, Date.now() - 10000 + i * 700);
  h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, 'a knock rings through one window at a time');
  speak(h, 4, 1); h.voiceSessions.checkStandby();
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['operator'], 'a voice that lasts wakes it');
});

test("the agent's news wakes it, a few tool calls don't, and what it did meanwhile arrives as it would have live", async t => {
  const { h, lives, sent, goQuiet } = await quiet(t);
  await goQuiet();
  for (let i = 0; i < 3; i++) agent(h, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `npm test ${i}` } });
  h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, `three tool calls are worth ${3 * DEFAULT_TUNING.toolPrice}`);
  agent(h, { hook_event_name: 'MessageDisplay', message_id: 'm1', index: 0, final: true, delta: 'Dark mode is in; the tests pass.' });
  agent(h, { hook_event_name: 'Stop', last_assistant_message: 'Dark mode is in; the tests pass.' });
  h.voiceSessions.checkStandby();
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['turn_end'], 'its message and turn end wake it');
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[1]?.state === 'active');
  await until(() => lives[1].appended.some(([kind, text]) => kind === 'thinking' && /Dark mode is in; the tests pass/.test(text)));
  const startup = JSON.stringify(lives[1].options.input);
  assert.ok(!/Dark mode is in/.test(startup), 'not buried in the startup history, where it would not be reported');
  // After the work it missed, the cue to report it (real GPT Live, Oct 18: 5 of 5 reported the result, without a greeting).
  const appended = lives[1].appended.map(([kind, text]) => `${kind}: ${text}`), news = appended.findIndex(a => /Dark mode is in/.test(a));
  assert.match(appended.at(-1)!, /^commentary: Tell the operator now, in a sentence or two, what Claude has done since/);
  assert.ok(news >= 0 && news < appended.length - 1, 'the cue comes after the work it is about');
});

test('ten tool calls in the window add up to a wake', async t => {
  const { h, sent, goQuiet } = await quiet(t);
  await goQuiet();
  for (let i = 0; i < 10; i++) agent(h, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `/a/${i}` }, tool_response: 'x' });
  h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 1);
});

test('ending voice on Standby hands the unsent speech to the agent, as ending voice does, and nothing wakes it after', async t => {
  const { h, sent, goQuiet } = await quiet(t);
  await goQuiet();
  h.voiceSessions.endStandby('operator ended voice');
  assert.equal(h.status().standby, null);
  assert.deepEqual(sent('voice_closed').map(e => e.standbyEnded), [undefined, true]);
  const [request] = [...h.outbox.values()];
  assert.match(request.content, /\[Voice session ended: operator ended voice\][\s\S]*user: Add a dark mode toggle/);
  speak(h, 20); h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0);
});

test('without Standby, or with a request on its way to the agent, voice stays Live', async t => {
  const off = await quiet(t, { tuning: { standbyAfterMs: 0, wakeThreshold: 10 } });
  off.h.voiceSessions.checkStandby(later(600000));
  assert.equal(off.lives[0].state, 'active');
  const on = await quiet(t);
  on.h.agentReady = false;
  on.h.deliver({ id: 'r1', content: 'Rename the parser.', delegationId: 'd1', voiceSessionId: on.lives[0].id, queuedAt: Date.now() });
  on.h.voiceSessions.checkStandby(later(WINDOW + 500));
  assert.equal(on.lives[0].state, 'active', 'the request waits for the agent; voice waits with it');
});

test('another companion turning it off ends Standby; turning it on wakes it', async t => {
  const { h, sent, goQuiet } = await quiet(t);
  await goQuiet();
  assert.deepEqual(h.sessionSwitch.remote('on', 'video-editing'), { ok: true, state: 'waking' });
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['turned on from video-editing']);
  assert.deepEqual(h.sessionSwitch.remote('off', 'video-editing'), { ok: true, state: 'turning off' });
  assert.equal(h.status().standby, null);
});

test('a page that never reconnects ends Standby rather than leave voice half on', async t => {
  const { h, sent, goQuiet } = await quiet(t);
  await goQuiet();
  speak(h, 10); h.voiceSessions.checkStandby();
  h.voiceSessions.checkStandby(later(11000));
  assert.equal(sent('voice_wake').length, 2, 'asked again');
  h.voiceSessions.checkStandby(later(31000));
  assert.equal(h.status().standby, null);
  assert.equal(sent('voice_closed').at(-1).standbyEnded, true);
});

test('the activity window counts only what happened inside it', () => {
  const activity = new Activity(), now = 1_000_000, price = priceFor(DEFAULT_TUNING);
  activity.add('tool', now - 5000); activity.add('turn_end', now - 1000);
  assert.equal(activity.value(2000, price, now), 30);
  assert.equal(activity.value(10000, price, now), 31);
  assert.equal(activity.latest(2000, price, now)?.source, 'turn_end');
  assert.equal(activity.value(2000, priceFor({ ...DEFAULT_TUNING, turnEndPrice: 45 }), now), 45, 'priced when read: a new price applies at once');
  // With nothing new, the window falls under 31 once the tool call leaves it, and under 1 once the turn end does.
  assert.equal(activity.stallAt(10000, 31, price, now), now - 5000 + 10000);
  assert.equal(activity.stallAt(10000, 30, price, now), now - 1000 + 10000);
  assert.deepEqual(['tool', 'text', 'turn_end', 'attention'].map(kind => priceOf({ ...DEFAULT_TUNING, messagePrice: 25 }, kind as any)), [1, 25, 30, 100], 'prices are settings');
});

test('the timeline draws a Standby stretch from when it began to when it ended', () => {
  const timeline = new Timeline(0, claude);
  const [item] = timeline.add({ type: 'standby', state: 'on', at: 1000 });
  assert.deepEqual([item.track, item.start, item.active], ['standby', 1000, true]);
  timeline.add({ type: 'standby', state: 'off', at: 5000, reason: 'operator' });
  assert.deepEqual([item.end, item.active, item.reason], [5000, false, 'operator']);
});

test('cues: Standby has its own sound, waking plays the start cue, and voice going off from Standby the end cue', () => {
  const cues = new CueTracker();
  cues.cue({ type: 'voice_started', sessionId: 'a' });
  assert.equal(cues.cue({ type: 'voice_closed', standby: true }), 'standby');
  assert.equal(cues.cue({ type: 'voice_closed', reconnect: true, waking: true }), null, "a wake's session that never started: still waking");
  assert.equal(cues.cue({ type: 'voice_started', sessionId: 'b' }), 'start');
  cues.cue({ type: 'voice_closed', standby: true });
  assert.equal(cues.cue({ type: 'voice_closed', standbyEnded: true }), 'end');
  assert.equal(cues.cue({ type: 'voice_closed' }), null);
});

// The worklet exactly as the page gets it.
function worklet() {
  let Processor: any; const posted: any[] = [];
  const context = vm.createContext({ AudioWorkletProcessor: class { port = { postMessage: (message: any) => posted.push(message) }; }, registerProcessor: (_: string, type: any) => { Processor = type; }, sampleRate: 24000, currentTime: 0 });
  vm.runInContext(stripTypes(fs.readFileSync(new URL('../web/audio-worklet.ts', import.meta.url), 'utf8')), context);
  const processor = new Processor(), sent: number[] = [];
  const run = (value: number, blocks: number) => {
    for (let i = 0; i < blocks; i++) {
      const outgoing = new Float32Array(128);
      processor.process([[new Float32Array(128).fill(value)], [new Float32Array(128)]], [[outgoing], [new Float32Array(128)]]);
      sent.push(...outgoing);
    }
  };
  return { send: (data: any) => processor.port.onmessage({ data }), run, sent, posted };
}

test('on Standby the microphone is held; waking, it goes back to where the operator started talking; once connected it goes out first, then the live microphone, skipping silence', () => {
  const w = worklet(), second = 24000 / 128;
  w.send({ type: 'gate', threshold: .008 });
  w.send({ type: 'hold' });
  // Earlier sound, a quiet of 2 s, then the operator talking for 5 s before the wake heard them.
  w.run(.05, Math.round(3 * second)); w.run(0, Math.round(2 * second)); w.run(.1, Math.round(5 * second));
  assert.ok(w.sent.every(x => x === 0), 'nothing goes out on Standby');
  w.send({ type: 'wake' }); w.run(.2, Math.round(2 * second));
  w.send({ type: 'replay' }); w.sent.length = 0;
  w.run(0, Math.round(8 * second)); w.run(.3, 10);
  const levels = [...new Set(w.sent.map(x => Math.round(x * 100) / 100))];
  assert.deepEqual(levels.filter(x => x > 0).slice(0, 2), [.4, .8], 'held speech first (boosted by the gain), then what was said while waking; nothing from before the quiet');
  const held = w.sent.filter(x => Math.abs(x - .4) < .01).length;
  assert.ok(Math.abs(held - 5 * 24000) < 1000, `all 5 s the operator spoke before the wake (${held})`);
  assert.ok(w.sent.slice(-128).every(x => x > .5), 'the live microphone follows, the silence between skipped');
});

test("waking, the page reports the held words still going out, and when they all have", () => {
  const w = worklet(), second = 24000 / 128;
  w.send({ type: 'gate', threshold: .008 }); w.send({ type: 'hold' });
  w.run(.1, Math.round(4 * second));
  w.send({ type: 'wake' }); w.send({ type: 'replay' });
  w.run(.1, 40);
  const backlog = w.posted.filter(m => m.type === 'level').at(-1).backlogMs;
  assert.ok(backlog > 3500, `about 4 s still to go out (${backlog} ms)`);
  assert.ok(!w.posted.some(m => m.type === 'replayed'));
  w.run(0, Math.round(6 * second));
  assert.equal(w.posted.filter(m => m.type === 'replayed').length, 1, 'once the held words are out and only silence is left');
  assert.equal(w.posted.filter(m => m.type === 'level').at(-1).backlogMs, 0);
});
