// Standby: voice that stays quiet disconnects GPT Live and keeps listening; speech or agent news wakes it.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Activity, priceOf } from '../src/core/activity.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';
import { STANDBY } from '../src/core/voice-sessions.ts';
import { Timeline } from '../src/core/timeline.ts';
import { stripTypes } from '../src/core/page.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { CueTracker } from '../web/cues.ts';
import { harness, page, settle, until } from './live-fake.ts';

const WINDOW = 2000;
// The operator speaking for about this long, as the page's level reports (0.1 s each) say.
const speak = (h: any, reports: number) => { for (let i = 0; i < reports; i++) h.voiceSessions.heard({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008 }); };
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

test('speech wakes it, priced like everything else; the new session is seeded, not greeted, and told why', async t => {
  const { h, lives, sent, goQuiet } = await quiet(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 30 } });
  await goQuiet();
  speak(h, 1); h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, `a tenth of a second of sound is worth ${DEFAULT_TUNING.speechPrice}, under a threshold of 30`);
  speak(h, 1); h.voiceSessions.checkStandby();
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['operator']);
  // The page reconnects on the same microphone.
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[1]?.state === 'active' && !h.status().standby);
  assert.equal(lives[1].options.fork, undefined, 'never a slow fork');
  assert.ok(lives[1].options.input.some((item: any) => item.role === 'user' && /dark mode/.test(item.content[0].text)), 'seeded with the conversation');
  assert.equal(lives[1].greeting, undefined, 'no greeting');
  await until(() => lives[1].appended.some(([kind, text]) => kind === 'thinking' && /The conversation continues.*Don't greet.*The operator has started speaking/s.test(text)));
  assert.ok(!lives[1].appended.some(([kind]) => kind === 'commentary'), 'the operator speaking is the cue: nothing else is said first');
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
  const activity = new Activity(), now = 1_000_000;
  activity.add('tool', 1, now - 5000); activity.add('turn_end', 30, now - 1000);
  assert.equal(activity.value(2000, now), 30);
  assert.equal(activity.value(10000, now), 31);
  assert.equal(activity.latest(2000, now)?.source, 'turn_end');
  activity.add('text', 0, now); activity.add('event', priceOf(DEFAULT_TUNING, 'event'), now);
  assert.equal(activity.entries.length, 2, 'free events are not kept');
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
  assert.equal(cues.cue({ type: 'voice_started', sessionId: 'b' }), 'start');
  cues.cue({ type: 'voice_closed', standby: true });
  assert.equal(cues.cue({ type: 'voice_closed', standbyEnded: true }), 'end');
  assert.equal(cues.cue({ type: 'voice_closed' }), null);
});

// The worklet exactly as the page gets it.
function worklet() {
  let Processor: any; const context = vm.createContext({ AudioWorkletProcessor: class { port = { postMessage() {} }; }, registerProcessor: (_: string, type: any) => { Processor = type; }, sampleRate: 24000, currentTime: 0 });
  vm.runInContext(stripTypes(fs.readFileSync(new URL('../web/audio-worklet.ts', import.meta.url), 'utf8')), context);
  const processor = new Processor(), sent: number[] = [];
  const run = (value: number, blocks: number) => {
    for (let i = 0; i < blocks; i++) {
      const outgoing = new Float32Array(128);
      processor.process([[new Float32Array(128).fill(value)], [new Float32Array(128)]], [[outgoing], [new Float32Array(128)]]);
      sent.push(...outgoing);
    }
  };
  return { send: (data: any) => processor.port.onmessage({ data }), run, sent };
}

test('on Standby the microphone is held, its last 3 s kept; on waking all of it; once connected it goes out first, then the live microphone, skipping silence', () => {
  const w = worklet(), second = 24000 / 128;
  w.send({ type: 'gate', threshold: .008 });
  w.send({ type: 'hold' });
  w.run(.1, Math.round(5 * second));
  assert.ok(w.sent.every(x => x === 0), 'nothing goes out on Standby');
  w.send({ type: 'wake' }); w.run(.2, Math.round(2 * second));
  w.send({ type: 'replay' }); w.sent.length = 0;
  w.run(0, Math.round(6 * second)); w.run(.3, 10);
  const levels = [...new Set(w.sent.map(x => Math.round(x * 100) / 100))];
  assert.deepEqual(levels.filter(x => x > 0).slice(0, 2), [.4, .8], 'held speech first (boosted by the gain), then what was said while waking');
  const held = w.sent.filter(x => Math.abs(x - .4) < .01).length;
  assert.ok(Math.abs(held - 3 * 24000) < 1000, `about the last 3 s before the wake (${held})`);
  assert.ok(w.sent.slice(-128).every(x => x > .5), 'the live microphone follows, the silence between skipped');
});
