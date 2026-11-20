// Standby: voice that stays quiet disconnects GPT Live and keeps listening; speech or agent news wakes it.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { Activity, priceFor, priceOf } from '../src/core/activity.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';
import { STANDBY } from '../src/core/voice-sessions.ts';
import { attachPage } from '../src/core/browser-socket.ts';
import { Timeline } from '../src/core/timeline.ts';
import { stripTypes } from '../src/core/page.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { CueTracker } from '../web/cues.ts';
import { fakeJev, harness, learn, Live, page, settle, until } from './live-fake.ts';

const WINDOW = 2000;
// The operator speaking for about this long, as the page's level reports (0.1 s each) say.
// The operator's microphone, a tenth of a second to a report: one call goes on where the last one stopped, unless it says when.
let spokenTo = 0;
const speak = (h: any, reports: number, voiced?: number, at = Math.max(Date.now(), spokenTo)) => {
  for (let i = 0; i < reports; i++) h.voiceSessions.heard({ at: at + i * 100, inputRms: .05, rawInputRms: .05, gateThreshold: .008, voiced });
  spokenTo = at + reports * 100;
};
const agent = (h: any, data: Record<string, unknown>) => h.adapter.observations.observe({ session_id: h.sessionId, ...data });
const later = (ms: number) => Date.now() + ms;

async function quiet(t: TestContext, extra: Record<string, unknown> = {}) {
  const f = await harness(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 10, wakeVoiceMs: 300 }, ...extra });
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

test('after a long quiet the next one is usually long too: Standby comes after the shorter window, and only then', async t => {
  const { h, lives } = await quiet(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 10, wakeVoiceMs: 300, standbyQuickMs: 500, standbyQuickAfterMs: 5000 } });
  const logged: any[] = [], log = h.log.bind(h); h.log = (event: any) => { logged.push(event); log(event); };
  const now = Date.now();
  // Talk with short pauses: the full window applies.
  h.voiceSessions.spokeAt = now - 3000; speak(h, 3, undefined, now);
  assert.ok(h.voiceSessions.lastQuietMs >= 3000 && h.voiceSessions.lastQuietMs < 3100, 'the quiet before these words');
  h.voiceSessions.checkStandby(now + 900);
  assert.equal(lives[0].state, 'active', 'a short quiet before: the whole window');
  // The operator came back after a long quiet (reading): the next quiet ends in Standby after the shorter window.
  h.voiceSessions.spokeAt = Date.now() - 8000; speak(h, 3);
  assert.ok(h.voiceSessions.lastQuietMs >= 8000);
  h.voiceSessions.checkStandby(Date.now() + 300);
  assert.equal(lives[0].state, 'active', 'not before the shorter window');
  h.voiceSessions.checkStandby(Date.now() + 900);
  await until(() => lives[0].state === 'closed');
  assert.ok(logged.some(e => e.type === 'voice.standby' && e.quick && e.afterMs === 500));
});

test('their voice wakes it once it has lasted, and the paused session resumes: a fork, not greeted, with nothing added first', async t => {
  const { h, lives, sent, goQuiet } = await quiet(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 30, wakeVoiceMs: 300 } });
  await goQuiet();
  speak(h, 2); h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, 'their voice has not lasted the 0.3 s set here');
  assert.deepEqual(sent('wake_rising').map(e => Math.round(e.value * 100)), [33, 67], 'the page is told how far it has got');
  speak(h, 1);
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

test("on Standby their voice must last a second: pauses of half a second belong to it, a longer one starts it again, and the page hears it rise and fall", async t => {
  const { h, sent, goQuiet } = await quiet(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 30 } });
  assert.equal(h.tuning.wakeVoiceMs, 1000);
  const silence = (reports: number) => { for (let i = 0; i < reports; i++) h.voiceSessions.heard({ at: spokenTo + i * 100, inputRms: 0, rawInputRms: .001, gateThreshold: .008 }); spokenTo += reports * 100; };
  const rose = () => sent('wake_rising').map(e => Math.round(e.value * 100));
  speak(h, 15);
  await goQuiet();
  speak(h, 6);
  assert.equal(sent('voice_wake').length, 0, 'what they said before Standby does not count toward it');
  assert.equal(rose().at(-1), 60);
  silence(7);
  assert.equal(rose().at(-1), 0, 'a pause of more than half a second: it falls away');
  speak(h, 4); silence(2); speak(h, 3);
  h.voiceSessions.checkStandby(spokenTo);
  assert.equal(sent('voice_wake').length, 0, '0.9 s with a short pause inside is one stretch, not yet a second; and nothing of it is in the currency');
  assert.equal(rose().at(-1), 90);
  speak(h, 1);
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['operator'], 'a second: voice wakes');
  assert.equal(h.voiceSessions.activity.value(60000, priceFor(h.tuning), spokenTo, h.voiceSessions.standby!.since), 10 * h.tuning.speechPrice, 'and what woke it counts from then on, as it would have Live');
});

test("GPT Live's last words still playing when it goes on Standby don't wake it: its session is closed", async t => {
  const { h, sent, goQuiet } = await quiet(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 30, wakeVoiceMs: 300 } });
  await goQuiet();
  for (let i = 0; i < 10; i++) h.voiceSessions.heard({ at: Date.now(), inputRms: 0, outputRms: .05 });
  h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, 'its own tail is no activity');
  speak(h, 3); h.voiceSessions.checkStandby();
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['operator'], 'the operator still wakes it');
});

const PLAN = { tabId: 1, title: 'Plan', url: 'http://127.0.0.1:8765/plan.html', about: null, where: 'Goals', commands: [], parts: [{ name: 'Goals', text: 'Ship the dark mode toggle by Friday.' }] };
const toldPage = (live: Live) => live.appended.filter(([kind, text]) => kind === 'thinking' && /The page open beside the operator now/.test(text)).map(([, text]) => text);

test('a wake resumes the paused session whatever the page did meanwhile: the fork is told the page as it is now, once', async t => {
  const { h, lives, goQuiet } = await quiet(t);
  // The agent opened a page while voice was paused: the paused session was never told of it.
  h.stage.tabId = 1; h.stage.describe = async () => PLAN;
  await goQuiet();
  const wake = async (n: number) => { speak(h, 10); h.voiceSessions.checkStandby(); await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true); await until(() => lives[n]?.state === 'active'); };
  await wake(1);
  assert.equal(lives[1].options.fork, lives[0].id, 'a fork: the page is told in the conversation, never in its instructions');
  await until(() => toldPage(lives[1]).length === 1);
  assert.match(toldPage(lives[1])[0], /"Plan".*Goals: Ship the dark mode toggle by Friday\./s);
  // Quiet again, the page as it was: the next wake resumes, and the page isn't told again.
  h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[1].state === 'closed');
  await wake(2);
  assert.equal(lives[2].options.fork, lives[1].id);
  await settle(50);
  assert.deepEqual(toldPage(lives[2]), [], 'it knows the page: nothing added');
});

test('an instruction learned before a wake rides along in the fork; a trim of GPT Live\'s context makes fdc tell it the page and the instructions again; past 20% full, a wake seeds, the page last in its startup input', async t => {
  const { h, lives, goQuiet } = await quiet(t);
  h.stage.tabId = 1; h.stage.describe = async () => PLAN;
  const wake = async (n: number) => { speak(h, 10); h.voiceSessions.checkStandby(); await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true); await until(() => lives[n]?.state === 'active'); };
  const sleep = async (n: number) => { h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[n].state === 'closed'); };
  const usage = (live: Live, ratio: number) => live.emit('event', { type: 'session.usage.updated', usage: { seconds: 40 }, context_window: { usage_ratio: ratio } });
  await learn(h, 'Keep answers under two sentences.');
  await goQuiet(); await wake(1);
  assert.equal(lives[1].options.fork, lives[0].id, 'the instruction it was told carries over');
  await until(() => toldPage(lives[1]).length === 1);
  assert.ok(!lives[1].appended.some(([kind, text]) => kind === 'instructions' && /I1:/.test(text)), 'not told again');
  // Past 90%, GPT Live keeps its first instructions and the latest 8,192 tokens of the conversation.
  usage(lives[1], .9); usage(lives[1], .12);
  await until(() => lives[1].appended.some(([kind, text]) => kind === 'instructions' && /^I1: Keep answers under two sentences/.test(text)));
  await until(() => toldPage(lives[1]).length === 2);
  usage(lives[1], .25);
  await sleep(1); await wake(2);
  assert.equal(lives[2].options.fork, undefined, 'past 20%: a seeded session, which starts faster');
  assert.match(lives[2].options.instructions, /I1: Keep answers under two sentences/);
  assert.ok(!lives[2].options.instructions.includes('dark mode toggle'), 'no page in its instructions');
  const last = lives[2].options.input.at(-1);
  assert.ok(last.role === 'developer' && /The page open beside the operator now.*"Plan"/s.test(last.content[0].text), 'the page last in its startup input');
  assert.ok(lives[2].options.input.some((item: any) => item.role === 'user' && /dark mode/.test(item.content[0].text)), 'seeded with the conversation');
  await settle(50);
  assert.deepEqual(toldPage(lives[2]), [], 'it started with the page: nothing added');
  await sleep(2); await wake(3);
  assert.equal(lives[3].options.fork, lives[2].id);
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
  const from = Date.now() + 4000;
  for (let i = 0; i < 10; i++) speak(h, 2, 1, from + i * 800);
  h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, 'a word here and there, with more than half a second between: no stretch lasts');
  assert.ok(sent('wake_rising').filter(e => Math.round(e.value * 100) === 33).length >= 10, 'each time it starts again from the bottom');
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

test("a fork's answer that comes on Standby wakes it and arrives as it would have live: before the way back, and the main session's work only from there", async t => {
  const { h, lives, sent, goQuiet } = await quiet(t);
  // The main session has a conversation to fork, and the operator turned aside: the fork has their question.
  h.observer.observations.push({ kind: 'text', name: 'MessageDisplay', text: JSON.stringify({ hook_event_name: 'MessageDisplay', delta: 'Started on the toggle.' }), raw: {}, at: Date.now(), state: 'turn_finished', child: false });
  h.forks.open = () => 'Terminal'; h.forks.shut = async () => 'closed';
  await h.forks.start('By the way, why is the build slow?');
  const fork = (data: Record<string, unknown>) => (h.forks.adapter!.observations as any).observe({ session_id: 'fork-session', ...data });
  fork({ hook_event_name: 'SessionStart' });
  h.forks.asked = Date.now();
  await goQuiet();
  assert.equal(h.forks.focus, 'fork', 'its answer is on the way: the fork keeps the focus into Standby');
  // The main session works meanwhile: the voice hears none of it while the fork is in focus.
  agent(h, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm run lint' }, tool_response: { stdout: 'main session busy meanwhile' } });
  // The fork answers on Standby. Until Nov 20 that answer never reached the voice: 20 of 25 Codex forks' answers since Nov 19.
  fork({ hook_event_name: 'UserPromptSubmit', prompt: 'Why is the build slow?' });
  fork({ hook_event_name: 'MessageDisplay', message_id: 'f1', index: 0, final: true, delta: 'The build is slow because of the source maps.' });
  fork({ hook_event_name: 'Stop', last_assistant_message: 'The build is slow because of the source maps.' });
  h.voiceSessions.checkStandby();
  assert.equal(h.forks.focus, 'main', 'it has answered: back to the main session');
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['turn_end'], 'its answer wakes the voice');
  // From the way back, the main session's work is the voice's again.
  agent(h, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'main session after the fork' } });
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  await until(() => lives[1]?.state === 'active');
  await until(() => lives[1].appended.some(([, text]) => /main session after the fork/.test(text)));
  const appended = lives[1].appended.map(([kind, text]) => `${kind}: ${text}`), at = (pattern: RegExp) => appended.findIndex(a => pattern.test(a));
  const answer = at(/The build is slow because of the source maps/), back = at(/<fork ended> Back to the main session of Claude Code \(the conversation went quiet\)/), after = at(/main session after the fork/);
  assert.ok(answer >= 0, "the fork's answer reaches the voice");
  assert.ok(answer < back && back < after, `in the order it came: the answer, the way back, the main session's work since: ${appended.join(' | ')}`);
  assert.equal(at(/main session busy meanwhile/), -1, "the main session's work while the fork was in focus weighs nothing for the voice, as live");
  assert.match(appended.at(-1)!, /^commentary: Tell the operator now, in a sentence or two, what Claude has done since/, 'then the cue to report it');
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
  const off = await quiet(t, { tuning: { standbyAfterMs: 0, wakeThreshold: 10, wakeVoiceMs: 300 } });
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
  assert.equal(activity.value(2000, price, now), 50);
  assert.equal(activity.value(10000, price, now), 51);
  assert.equal(activity.latest(2000, price, now)?.source, 'turn_end');
  assert.equal(activity.value(2000, priceFor({ ...DEFAULT_TUNING, turnEndPrice: 45 }), now), 45, 'priced when read: a new price applies at once');
  // With nothing new, the window falls under 51 once the tool call leaves it, and under 1 once the turn end does.
  assert.equal(activity.stallAt(10000, 51, price, now), now - 5000 + 10000);
  assert.equal(activity.stallAt(10000, 50, price, now), now - 1000 + 10000);
  assert.deepEqual(['tool', 'text', 'turn_end', 'attention'].map(kind => priceOf({ ...DEFAULT_TUNING, messagePrice: 25 }, kind as any)), [1, 25, 50, 100], 'prices are settings');
});

test('at the defaults a finished turn wakes voice whatever the agent: Codex and Pi send their reply as one message, not in batches', () => {
  const now = 1_000_000, price = priceFor(DEFAULT_TUNING), { standbyAfterMs, wakeThreshold } = DEFAULT_TUNING;
  const reply = new Activity(); reply.add('text', now - 300); reply.add('turn_end', now);
  assert.ok(reply.value(standbyAfterMs, price, now) >= wakeThreshold);
  const bare = new Activity(); bare.add('turn_end', now);
  assert.ok(bare.value(standbyAfterMs, price, now) >= wakeThreshold, 'a turn end with no message too');
  const failed = new Activity(); failed.add('turn_failed', now);
  assert.ok(failed.value(standbyAfterMs, price, now) >= wakeThreshold, 'and a failed turn');
  const message = new Activity(); message.add('text', now);
  assert.ok(message.value(standbyAfterMs, price, now) < wakeThreshold, 'a message mid-turn alone does not');
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
  const processor = new Processor(), sent: number[] = [], counts = { ran: 0, mostAtOnce: 0 };
  const run = (value: number, blocks: number) => {
    for (let i = 0; i < blocks; i++) {
      const outgoing = new Float32Array(128), before = posted.length;
      processor.process([[new Float32Array(128).fill(value)], [new Float32Array(128)]], [[outgoing], [new Float32Array(128)]]);
      sent.push(...outgoing); counts.ran++;
      counts.mostAtOnce = Math.max(counts.mostAtOnce, posted.slice(before).filter(m => m.type === 'standby').length);
    }
  };
  return { send: (data: any) => processor.port.onmessage({ data }), run, sent, posted, counts };
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

test('on Standby the microphone goes on being recorded wherever there is sound, with the seconds around it; silence is let go, and a muted microphone is not recorded', () => {
  const w = worklet(), second = 24000 / 128, audit = () => w.posted.filter(m => m.type === 'standby' || m.type === 'playback');
  w.send({ type: 'gate', threshold: .008 }); w.send({ type: 'audit_start', sessionId: 'one' });
  w.run(.05, 10);
  assert.deepEqual([audit().length, audit().at(-1).type, audit().at(-1).offsetSamples], [10, 'playback', 9 * 128], 'connected: every block, played and heard');
  w.send({ type: 'hold' }); w.posted.length = 0;
  w.run(0, Math.round(20 * second));
  assert.equal(audit().length, 0, 'silence is not recorded, however long');
  // A quiet word, under the gate (it would not wake voice, nor reach GPT Live): on record, with 5 s before it and 5 s after.
  const spoken = 10 + Math.round(20 * second);
  w.run(.004, Math.round(second)); w.run(0, Math.round(20 * second));
  const blocks = audit(), first = blocks[0].offsetSamples / 128, word = blocks.filter(m => new Int16Array(m.microphone)[0] !== 0);
  assert.ok(blocks.every(m => m.type === 'standby' && m.sessionId === 'one' && !('pcm' in m)), "the microphone alone, in the track of the session that went on Standby");
  assert.ok(blocks.every((m, i) => m.offsetSamples === (first + i) * 128), "on that session's sample clock, without a break");
  assert.ok(Math.abs(spoken - first - 5 * second) <= 2 && Math.abs(blocks.length - 11 * second) <= 4, `5 s before the word, the word, 5 s after (${blocks.length} blocks from ${spoken - first} before it)`);
  assert.deepEqual([word.length, word[0].offsetSamples, new Int16Array(word[0].microphone)[0]], [Math.round(second), spoken * 128, Math.round(.004 * 32767)], 'the word as the microphone had it, where it was said');
  // All at once, the 5 s before the word were a burst the page took for a backlogged connection, and dropped part of.
  assert.ok(w.counts.mostAtOnce > 1 && w.counts.mostAtOnce <= 8, `what led up to the word goes out a few blocks at a time (${w.counts.mostAtOnce} at most)`);
  // Muted, nothing is recorded.
  w.posted.length = 0; w.send({ type: 'mute', muted: true }); w.run(.3, Math.round(2 * second)); w.send({ type: 'mute', muted: false });
  assert.equal(audit().length, 0);
  // Waking: everything from then on, up to the moment the next session's own audit takes over.
  w.send({ type: 'wake' }); w.run(0, 40);
  assert.ok(audit().length >= 40 && audit().every(m => m.type === 'standby'), 'the wait for the new connection is recorded whole');
  // The new connection is up before all of it has gone out: the rest goes first, still in the track it belongs to.
  w.send({ type: 'audit_start', sessionId: 'two' });
  const waited = audit(), from = waited[0].offsetSamples / 128;
  assert.ok(waited.every((m, i) => m.sessionId === 'one' && m.offsetSamples === (from + i) * 128) && from + waited.length === w.counts.ran, 'nothing of it is left behind, and nothing out of order');
  w.posted.length = 0; w.run(0, 3);
  assert.deepEqual(audit().map(m => [m.type, m.sessionId, m.offsetSamples]), [['playback', 'two', 0], ['playback', 'two', 128], ['playback', 'two', 256]]);
});

test("a voice session's microphone track goes on through the Standby that follows it, until the next session's audit takes over on the page", async t => {
  const { h, lives } = await harness(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 10, wakeVoiceMs: 300 } });
  const ws: any = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() {} });
  attachPage(h, ws, 'local');
  const voicePage = [...h.pages.all.values()].find(p => p.ws === ws)!;
  const from = (event: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify(event)), false);
  const pcm = (value: number) => Buffer.from(new Int16Array(128).fill(value).buffer).toString('base64');
  const track = (live: Live) => { const file = path.join(h.runDir, 'audio', live.reservation!, 'microphone.wav'); return fs.existsSync(file) ? new Int16Array(new Uint8Array(fs.readFileSync(file).subarray(44)).buffer) : new Int16Array(0); };
  await h.startLive(undefined, voicePage, 'fresh');
  lives[0].say('operator', 'Add a dark mode toggle.', 0); lives[0].say('intermediary', 'On it.', 1000);
  from({ type: 'playback_audio', voiceSessionId: lives[0].id, offsetSamples: 0, at: Date.now(), pcm: pcm(0), microphone: pcm(11) });
  assert.equal(track(lives[0]).length, 128);
  h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[0].state === 'closed');
  assert.ok(h.voiceSessions.standby);
  // Ten minutes into Standby the operator says something: it lands where it was said, the silence before it a gap.
  const said = 24000 * 600;
  from({ type: 'standby_audio', voiceSessionId: lives[0].id, offsetSamples: said, at: Date.now(), microphone: pcm(22) });
  assert.deepEqual([track(lives[0]).length, track(lives[0])[said], track(lives[0])[said - 1]], [said + 128, 22, 0]);
  // Their voice wakes it. While the new session connects, and until the page's audit moves to it, their words still go to the track they belong to.
  speak(h, 3); h.voiceSessions.checkStandby();
  await h.startLive(undefined, h.voiceSessions.standby!.page, 'resume', true);
  assert.equal(lives.length, 2);
  from({ type: 'standby_audio', voiceSessionId: lives[0].id, offsetSamples: said + 128, at: Date.now(), microphone: pcm(33) });
  assert.equal(track(lives[0])[said + 128], 33, 'said as the new session came up');
  from({ type: 'playback_audio', voiceSessionId: lives[1].id, offsetSamples: 0, at: Date.now(), pcm: pcm(0), microphone: pcm(44) });
  assert.deepEqual([track(lives[1])[0], h.voiceSessions.pastAudit], [44, null], "the new session's own track begins, and the one before it is complete");
  from({ type: 'standby_audio', voiceSessionId: lives[0].id, offsetSamples: said + 256, at: Date.now(), microphone: pcm(55) });
  assert.equal(track(lives[0]).length, said + 256, 'nothing is added to it afterwards');
  const gaps = fs.readFileSync(path.join(h.runDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"audio.audit_gap"')).map(line => JSON.parse(line));
  assert.deepEqual(gaps.map(g => [g.track, g.reason]), [['microphone', 'standby_quiet']], 'the silence of Standby is a gap the log names');
});

// Nov 16: a page's audio clock had stopped with its audio device, a second or two at a time, and ended 6 s behind. The
// bridge refused every level as stale: voice went on Standby mid-sentence, 15 s into each connection, and no voice woke it.
test("a page whose clock is far behind is still heard: the companion speaking keeps voice on, and the operator's voice wakes Standby", async t => {
  const { h, lives, published } = await harness(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 30, wakeVoiceMs: 300 } });
  const ws: any = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() {} });
  attachPage(h, ws, 'local');
  const voicePage = [...h.pages.all.values()].find(p => p.ws === ws)!;
  const BEHIND = 6243;
  const level = (sound: Record<string, number>, n: number) => { for (let i = 0; i < n; i++) ws.emit('message', Buffer.from(JSON.stringify({ type: 'audio_level', at: Date.now() - BEHIND + i * 107, durationMs: 107, inputRms: 0, outputRms: 0, gateThreshold: .008, ...sound })), false); };
  await h.startLive(undefined, voicePage, 'fresh');
  lives[0].say('operator', 'Walk me through step two.', 0);
  // Well past the window, the companion is still speaking.
  lives[0].startedAt = Date.now() - WINDOW - 1000;
  level({ outputRms: .05 }, 10);
  h.voiceSessions.checkStandby();
  assert.ok(lives[0].state === 'active' && !h.voiceSessions.standby, 'mid-sentence is not quiet');
  // Quiet for the window: Standby. Then the operator speaks.
  h.voiceSessions.checkStandby(later(WINDOW + 500)); await until(() => lives[0].state === 'closed');
  assert.ok(h.voiceSessions.standby);
  // Their voice, as it arrives: the bridge's clock times how long it lasts, since the page's can't be used.
  for (let i = 0; i < 4; i++) { level({ inputRms: .05, rawInputRms: .05, voiced: 1 }, 1); await new Promise(resolve => setTimeout(resolve, 105)); }
  assert.deepEqual(published.filter(p => p.event.type === 'voice_wake').map(p => p.event.reason), ['operator'], 'their voice wakes it');
  const levels = fs.readFileSync(path.join(h.runDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"audio_level"')).map(line => JSON.parse(line));
  assert.ok(levels.length === 14 && levels.every(e => Math.abs(e.at - Date.now()) < 1000 && e.at - e.pageAt > BEHIND - 1000), "each is on record at the bridge's time, with the page's own");
});

test("the page keeps its audio clock on the wall clock: a clock that stopped with the audio device is fitted again within a second or two, and a busy page is not mistaken for one", async () => {
  const { AudioIO } = await import('../web/audio-io.ts');
  const audio = new AudioIO(); let now = 1_000_000, clock = 0; audio.audioEpoch = now;
  // A level every 107 ms of audio, read 5 ms after it, give or take.
  const levels = (n: number, read = () => 5 + Math.random() * 10) => { let moved = 0; for (let i = 0; i < n; i++) { now += 107; clock += .107; moved += audio.fit(clock, now + read()); } return moved; };
  assert.equal(levels(100), 0, "nothing moves while the clocks agree: the page's delay in reading a level is not the clock");
  // The audio device stops for 2.2 s: the audio clock stands still, and stays behind.
  now += 2200;
  const moved = levels(30);
  assert.ok(Math.abs(moved - 2200) < 30 && Math.abs(audio.audioEpoch - (1_000_000 + 2200)) < 30, `fitted again, by the 2.2 s it stopped (${Math.round(moved)} ms)`);
  // Twice more, as on Nov 16: stamps stay right however often it stops.
  now += 1400; levels(30); now += 2200; levels(30);
  assert.ok(Math.abs(audio.audioEpoch - (1_000_000 + 5800)) < 30, 'and again each time');
  // The page is busy for 3 s, then reads 28 levels at once: all late but the last, which the fit goes by.
  const before = audio.audioEpoch;
  for (let i = 0; i < 28; i++) { now += 107; clock += .107; assert.equal(audio.fit(clock, now + (27 - i) * 107), 0); }
  assert.equal(levels(30), 0); assert.equal(audio.audioEpoch, before, 'a busy page moves nothing');
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

// GPT Live speaking for about this long, as the page's level reports say.
const answer = (h: any, reports = 5, at = Date.now()) => { for (let i = 0; i < reports; i++) h.voiceSessions.heard({ at, inputRms: 0, outputRms: .05 }); };

test("Standby on Jev's word: once the voice companion has had its say, Jev reads the quiet, once; sure that no meaningful exchange is about to begin, voice goes on Standby at once, not after the window", async t => {
  const { h, lives, sent } = await quiet(t, { tuning: { standbyAfterMs: 60000, wakeThreshold: 30, wakeVoiceMs: 300 } });
  const moments = fakeJev(h, () => ({ standby: .9 })), quiets = () => moments.filter(m => m.trigger === 'quiet');
  const logged: any[] = [], log = h.log.bind(h); h.log = ((event: any) => { logged.push(event); log(event); }) as typeof h.log;
  lives[0].startedAt = Date.now() - 20000;
  speak(h, 5); answer(h);
  h.voiceSessions.checkStandby(later(1000));
  assert.equal(quiets().length, 0, 'the companion has only just stopped speaking');
  h.voiceSessions.checkStandby(later(2500)); h.voiceSessions.checkStandby(later(3500));
  await until(() => lives[0].state === 'closed');
  assert.equal(lives[0].closeReason, STANDBY);
  assert.equal(quiets().length, 1, 'one reading for a quiet');
  assert.equal(quiets()[0].unanswered, false);
  assert.match(`${quiets()[0].history}\n${quiets()[0].latest?.text}`, /dark mode toggle[\s\S]*On it\./, 'Jev reads the conversation as the voice has it, the answer included');
  const went = logged.filter(e => e.type === 'voice.standby').at(-1);
  assert.deepEqual([went.jev, went.from], [.9, .5], "the record says it was Jev's reading, and what it had to pass");
  h.voiceSessions.checkStandby();
  assert.equal(sent('voice_wake').length, 0, "what was said before Standby doesn't wake it");
  speak(h, 3); h.voiceSessions.checkStandby();
  assert.deepEqual(sent('voice_wake').map(e => e.reason), ['operator'], 'speaking again does');
});

test('the quiet reading asks Jev one question, says whether the companion answered, and records the threshold in force', async () => {
  const { Jev } = await import('../src/core/jev.ts');
  const bodies: any[] = [], calls: any[] = [];
  const jev = new Jev({ apiKey: 'k', log: () => {}, record: (call: any) => calls.push(call), fetch: async (_url: string, init: any) => { bodies.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({ answers: { standby: { noul: .8 } } }) }; } } as any);
  const latest = { role: 'intermediary' as const, text: "That's with Claude now. I'll stay quiet." };
  const reading = await jev.read({ trigger: 'quiet', latest, history: 'user: Refactor the queue, take your time.', instructions: ['I1: be brief'], goal: 'none set', thresholds: { standby: .4 } });
  assert.equal(reading.standby, .8);
  assert.deepEqual(Object.keys(bodies[0].questions), ['standby']);
  assert.match(bodies[0].questions.standby.instructions, /Will the next 15 seconds pass without a meaningful exchange/);
  assert.match(bodies[0].state.why, /the voice companion finished speaking a moment ago/);
  assert.deepEqual([bodies[0].state.latest, bodies[0].state.goal, bodies[0].state.operator_instructions], ["voice assistant: That's with Claude now. I'll stay quiet.", 'none set', 'I1: be brief']);
  assert.deepEqual(calls[0].config.thresholds, { standby: .4 });
  await jev.read({ trigger: 'quiet', latest: { role: 'operator', text: 'Hello?' }, unanswered: true });
  assert.match(bodies[1].state.why, /the voice companion has not answered/);
  assert.deepEqual(calls[1].config.thresholds, { standby: .5 }, 'the default');
});

test("Standby on Jev's word waits for the companion's answer, takes no for an answer, and gives way to anyone who speaks while Jev reads", async t => {
  const { h, lives } = await quiet(t, { tuning: { standbyAfterMs: 60000, wakeThreshold: 30, wakeVoiceMs: 300 } });
  let sure = .9, during = () => {};
  const moments = fakeJev(h, moment => { if (moment.trigger === 'quiet') during(); return { standby: sure }; }), quiets = () => moments.filter(m => m.trigger === 'quiet');
  lives[0].startedAt = Date.now() - 20000;
  // The operator spoke last and GPT Live gave no answer: it may still be coming, so Jev is asked only after 6 s.
  speak(h, 5);
  h.voiceSessions.checkStandby(later(3000));
  assert.equal(quiets().length, 0, 'an answer may still come');
  // They go on speaking while Jev reads: the reading is overtaken, voice stays on.
  await new Promise(resolve => setTimeout(resolve, 5));
  during = () => speak(h, 3, undefined, later(50));
  h.voiceSessions.checkStandby(later(6500));
  await settle(); await settle();
  assert.deepEqual([quiets().length, quiets()[0].unanswered, lives[0].state], [1, true, 'active']);
  // The next quiet is read again; Jev not sure enough: the window decides, and that quiet is not read twice.
  during = () => {}; sure = .3;
  answer(h);
  h.voiceSessions.checkStandby(later(2500)); h.voiceSessions.checkStandby(later(4000));
  await settle(); await settle();
  assert.deepEqual([quiets().length, lives[0].state], [2, 'active']);
  // How sure Jev must be is a setting (standbyFrom): lower it and the same reading is enough; 1 never asks.
  h.setTuning({ ...h.tuning, standbyFrom: 1 });
  answer(h);
  h.voiceSessions.checkStandby(later(2500));
  await settle();
  assert.equal(quiets().length, 2, 'set to 1, Jev is not asked');
  h.setTuning({ ...h.tuning, standbyFrom: .25 });
  h.voiceSessions.checkStandby(later(2500));
  await until(() => lives[0].state === 'closed');
  assert.equal(quiets().length, 3);
});

test("Standby on Jev's word never begins with a request on its way to the agent, a turn still being decided, before anyone has spoken in the session, or in the 15 s every session is billed", async t => {
  const { h, lives } = await quiet(t, { tuning: { standbyAfterMs: 60000, wakeThreshold: 30, wakeVoiceMs: 300 } });
  const moments = fakeJev(h, () => ({ standby: .9 })), quiets = () => moments.filter(m => m.trigger === 'quiet');
  h.voiceSessions.checkStandby(later(20000));
  await settle();
  assert.equal(quiets().length, 0, 'nobody has spoken in this session yet');
  speak(h, 5); answer(h);
  h.voiceSessions.checkStandby(later(2500));
  await settle();
  assert.equal(quiets().length, 0, "a session's first 15 s are billed whatever happens: Standby then saves nothing");
  lives[0].startedAt = Date.now() - 20000;
  h.voiceSessions.mediator!.pending++;
  h.voiceSessions.checkStandby(later(2500));
  await settle();
  assert.equal(quiets().length, 0, 'the turn is still being decided: its request may be about to go');
  h.voiceSessions.mediator!.pending--;
  h.outbox.set('r1', { id: 'r1', content: 'Add a legend.', state: 'queued' } as any);
  h.voiceSessions.checkStandby(later(2500));
  await settle();
  assert.deepEqual([quiets().length, lives[0].state], [0, 'active'], 'a request on its way keeps voice on');
  h.outbox.delete('r1');
  h.voiceSessions.checkStandby(later(2500));
  await until(() => lives[0].state === 'closed');
});

test("words the job delegation put off because the operator hadn't finished go to the agent when Standby comes, rather than at the next wake", async t => {
  const { fakeJev } = await import('./live-fake.ts');
  const f = await harness(t, { tuning: { standbyAfterMs: WINDOW, wakeThreshold: 10, wakeVoiceMs: 300 } });
  fakeJev(f.h, m => m.made === 'quiet' ? { needsAgent: .9, ready: .05 } : {});
  const voicePage = page('voice-page');
  Object.assign(voicePage.ws, { terminate() {}, close() {}, on() {} });
  f.h.pages.all.set(voicePage.ws, voicePage);
  await f.h.startLive(undefined, voicePage, 'fresh');
  f.h.voiceSessions.mediator!.quietMs = 50;
  const delivered: any[] = []; f.h.deliver = (request: any) => { delivered.push(request); };
  f.lives[0].say('operator', 'Add a dark mode toggle, and also', 0);
  await until(() => f.h.voiceSessions.mediator!.undecided());
  assert.equal(delivered.length, 0, 'not finished: it waits');
  f.h.voiceSessions.checkStandby(later(WINDOW + 500));
  await until(() => delivered.length === 1);
  assert.match(delivered[0].content, /stopped partway through this.*may be unfinished[\s\S]*user: Add a dark mode toggle, and also/);
});
