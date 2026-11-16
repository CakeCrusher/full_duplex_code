// What Jev reads as each moment's history: what GPT Live perceived, word for word and in order (perceived.ts). Also the
// operator's instructions in every reading, and Jev's optional features (features.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claude } from '../src/adapters/claude/index.ts';
import { HISTORY_BYTES, Jev } from '../src/core/jev.ts';
import { beginPerceived, perceive, perceivedText } from '../src/core/perceived.ts';
import { agentsOwn, catchUp, liveInstructions } from '../src/core/prompts.ts';
import { DEFAULT_FEATURES, featuresFrom } from '../src/core/features.ts';
import { ResumeStore, type ResumeRecord } from '../src/core/voice-resume.ts';
import { fakeJev, harness, learn, page, settle, turn } from './live-fake.ts';

const HOW: Record<string, string> = { thinking: 'as silent context', commentary: 'for the companion to say', instructions: 'as an instruction' };
/** The end of a label that says how long before the latest words the thing was sent. */
const AGE = /, \d+ (s|min) earlier\]/g;

test("Jev's history is what GPT Live was sent and heard, word for word and in order: its startup input, each append, the conversation; nothing from the latest words on", async t => {
  const { h, lives, sessionId } = await harness(t);
  const moments = fakeJev(h);
  const hook = (command: string) => h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok' } });
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const live = lives[0], mediator = h.voiceSessions.mediator!;
  mediator.operatorQuietMs = 60000;
  hook('npm test'); mediator.feed.flush();
  await settle();
  live.say('intermediary', 'Tests are running.', 1000);
  await settle(5);
  live.say('operator', 'Then commit it.', 5000);
  await settle(5);
  const before = live.appended.length;
  hook('git commit'); mediator.feed.flush();
  await settle();
  await h.read({ trigger: 'job', spoken: mediator.history.spoken() });
  const { history, latest } = moments.at(-1)!;
  assert.equal(latest!.text, 'Then commit it.');
  const startup = live.options.input.map((item: any) => `[sent by fdc at the start of the voice connection]\n${item.content[0].text}`);
  const appended = live.appended.slice(0, before).map(([kind, text]) => `[sent by fdc ${HOW[kind]}]\n${text}`);
  assert.ok(appended.some(text => /^\[sent by fdc as silent context\]\n\[Claude hooks; part 1\/1\]\n.*npm test/s.test(text)), "the agent's work as the feed sent it");
  // Each label also says how long before the latest words it was sent; without that, the text is what GPT Live got.
  assert.equal(history!.replace(AGE, ']'), [...startup, ...appended, 'voice assistant: Tests are running.'].join('\n'));
  assert.equal(history!.match(AGE)?.length, startup.length + appended.length, 'every thing fdc sent says how long before the latest words');
  assert.doesNotMatch(history!, /git commit/, 'nothing GPT Live got after the latest words began');
});

test('a fork of the last voice session continues what GPT Live perceived; a new session starts it again from its own startup input', async t => {
  const { h, lives } = await harness(t);
  const moments = fakeJev(h);
  const read = async () => { await h.read({ trigger: 'job', spoken: h.voiceSessions.mediator!.history.spoken() }); return moments.at(-1)!.history!; };
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  h.voiceSessions.mediator!.operatorQuietMs = 60000;
  lives[0].say('operator', 'Keep the soft shapes one in mind for later.', 0);
  await settle(5);
  await lives[0].close('operator ended voice');
  await h.startLive(undefined, page('p'), 'resume');
  assert.equal(h.voiceSessions.run!.plan, 'fork');
  h.voiceSessions.mediator!.operatorQuietMs = 60000;
  lives[1].say('operator', 'Go back to that one.', 0);
  await settle(5);
  const forked = await read();
  assert.match(forked, /^\[sent by fdc at the start of the voice connection, \d+ s earlier\]\nYou are attached to Claude Code/, "the first session's startup input, which the fork has");
  assert.match(forked, /\nuser: Keep the soft shapes one in mind for later\.\n/, 'the conversation before the fork');
  assert.match(forked, /\[sent by fdc for the companion to say, \d+ s earlier\]\nVoice connection reopened/, "the fork's own greeting");
  await lives[1].close('operator ended voice');
  await h.startLive(undefined, page('p'), 'fresh');
  h.voiceSessions.mediator!.operatorQuietMs = 60000;
  lives[2].say('operator', 'Start over.', 0);
  await settle(5);
  const fresh = await read();
  assert.doesNotMatch(fresh, /soft shapes|reopened/, 'a new session perceives none of it');
  assert.match(fresh, /^\[sent by fdc at the start of the voice connection, \d+ s earlier\]\nYou are attached to Claude Code/);
});

test("a request to the agent leaves out the agent's own work, which the voice was sent too; Jev still reads all of it", async t => {
  const { h, lives, sessionId } = await harness(t);
  await h.voiceSessions.start('sdp', page('p'), 'fresh');
  const live = lives[0], mediator = h.voiceSessions.mediator!, record = h.voiceSessions.run!.record;
  h.observer.hook({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }); mediator.feed.flush();
  await settle();
  // A voice connection that continues an earlier one starts with the agent's work since: the agent's own, too.
  perceive(record, { at: Date.now(), kind: 'thinking', text: `${catchUp(claude, '/repo', 'working')}Recorded Claude context only. This is not a new user request:\nClaude Code observation (history):\nran the linter` });
  perceive(record, { at: Date.now(), kind: 'thinking', text: 'The operator moved the page themselves; they are looking at the chart.' });
  live.say('intermediary', 'Tests are running.', 1000);
  await settle(5);
  live.say('operator', 'Then commit it.', 5000);
  await settle(5);
  mediator.send('commit', [], null);
  const request = h.outbox.get('commit')!.content;
  assert.match(request, /your own events, which it was sent too, are left out/);
  assert.doesNotMatch(request, /Claude hooks|npm test|ran the linter|continues an earlier one/, "none of the agent's own work comes back to it");
  assert.match(request, /\[sent by fdc as silent context[^\]]*\]\nThe operator moved the page themselves; they are looking at the chart\.\n[\s\S]*voice assistant: Tests are running\.\n[\s\S]*user: Then commit it\./, 'what the voice tool told the voice, and the conversation, in order');
  const all = perceivedText(record, mediator.history.spoken(), Date.now(), HISTORY_BYTES);
  assert.match(all, /\[Claude hooks; part 1\/1\]\n.*npm test/s); assert.match(all, /ran the linter/);
  const own = agentsOwn(claude);
  assert.deepEqual([own('[Claude hooks; part 2/3]\n{"id":4}'), own('[Codex events; part 1/1]\n{}'), own('The request has been delivered to Claude Code.'), own('<fork started> A fork is open.')], [true, false, false, false]);
});

test('each thing fdc sent says how long before the latest words it was sent: Jev has no other sense of time', () => {
  const record: ResumeRecord = { stored: false, finalized: false, turns: [] };
  beginPerceived(record, 'fresh', [{ at: 0, kind: 'start', text: 'You are attached.' }], 1_000);
  perceive(record, { at: 400_000, kind: 'thinking', text: 'An agent update.' });
  perceive(record, { at: 597_000, kind: 'thinking', text: 'The operator\'s words were sent to Claude Code, which has them now: "launch it"' });
  const text = perceivedText(record, [{ role: 'operator', text: 'Okay', at: 600_000 }], 600_000, HISTORY_BYTES);
  assert.equal(text, [
    '[sent by fdc at the start of the voice connection, 10 min earlier]', 'You are attached.',
    '[sent by fdc as silent context, 3 min earlier]', 'An agent update.',
    '[sent by fdc as silent context, 3 s earlier]', 'The operator\'s words were sent to Claude Code, which has them now: "launch it"',
    'user: Okay'].join('\n'));
  assert.doesNotMatch(perceivedText(record, [], Infinity, HISTORY_BYTES), /earlier/, 'no latest words to count from, no ages');
});

test('Jev reads the latest 14 KB of it: whole entries, the oldest that fits only in part cut to its end under its label', () => {
  const record: ResumeRecord = { stored: false, finalized: false, turns: [] };
  beginPerceived(record, 'fresh', [{ at: 0, kind: 'start', text: 'S'.repeat(6000) }], 1000);
  for (let i = 0; i < 5; i++) perceive(record, { at: 2000 + i, kind: 'thinking', text: `update ${i}\n${'x'.repeat(3000)}` });
  const text = perceivedText(record, [{ role: 'operator', text: 'And now?', at: 3000 }], Infinity, HISTORY_BYTES);
  assert.ok(Buffer.byteLength(text) <= HISTORY_BYTES);
  assert.match(text, /\nupdate 4\nx+\nuser: And now\?$/, 'the newest last, whole');
  assert.match(text, /^\[sent by fdc as silent context\]\n…x+\n/, 'the oldest, cut');
  assert.doesNotMatch(text, /SSSS/, 'the startup input is older than the latest 14 KB');
  assert.equal(perceivedText(record, [], 2001, HISTORY_BYTES).match(/update/g)?.length, 2, 'only what came by `until`');
});

test('what GPT Live perceived is kept with the resume record across restarts; a damaged copy is dropped, not the record', () => {
  const store = new ResumeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-perceived-')));
  const record: ResumeRecord = { stored: true, finalized: true, turns: [], perceived: [{ at: 1, kind: 'thinking', text: 'Tests pass.' }], perceivedSince: 1 };
  store.save('kept', record);
  assert.deepEqual(store.load('kept')!.perceived, record.perceived);
  fs.writeFileSync(store.file('damaged'), JSON.stringify({ ...record, perceived: [{ text: 5 }] }));
  const loaded = store.load('damaged')!;
  assert.equal(loaded.perceived, undefined);
  assert.equal(loaded.stored, true);
});

test("every reading of Jev has the operator's instructions to the companion in force, as GPT Live has them; the job delegation reads no settings", async t => {
  const { h } = await harness(t);
  const moments = fakeJev(h);
  await h.voiceSessions.appendInstruction("Don't pass on questions you can answer yourself.");
  await learn(h, 'Talk me through the results yourself.');
  await h.read({ trigger: 'job', spoken: [{ role: 'operator', text: 'Explain the chart.', at: Date.now() }] });
  assert.deepEqual(moments.at(-1)!.instructions, ["Don't pass on questions you can answer yourself.", 'I1: Talk me through the results yourself.']);
  assert.ok(h.voiceSessions.instructions().includes("Additional operator instructions:\nDon't pass on questions you can answer yourself.\n\nI1: Talk me through the results yourself."), "GPT Live's");
  let sent: any;
  const jev = new Jev({ apiKey: 'k', log: () => {}, fetch: async (_url, init) => { sent = JSON.parse(String(init.body)); return { ok: true, status: 200, json: async () => ({ answers: {} }) }; } });
  await jev.read({ trigger: 'job', latest: { role: 'operator', text: 'Explain the chart.' }, instructions: ['I1: Talk me through the results yourself.'] });
  assert.equal(sent.state.operator_instructions, 'I1: Talk me through the results yourself.');
  assert.equal(sent.state.current_settings, undefined);
  assert.match(sent.state.setting, /`operator_instructions` are the operator's instructions to the companion in force now; they hold for your reading too/);
});

test('features: a name turns one on, "no-" turns it off, the rest keep their defaults; an unknown one is refused', () => {
  assert.deepEqual([...featuresFrom(DEFAULT_FEATURES)], ['instructions']);
  assert.deepEqual([...featuresFrom(DEFAULT_FEATURES, 'orchestration', 'no-instructions')], ['orchestration']);
  assert.deepEqual([...featuresFrom(['instructions', 'configuration'], undefined, ' no-configuration ')], ['instructions']);
  assert.throws(() => featuresFrom(DEFAULT_FEATURES, 'tuner'), /Unknown feature "tuner"/);
});

test("with orchestration off (the default), Jev isn't asked about sessions, none are listed, and neither GPT Live nor Jev is told the voice tool turns them on or off", async t => {
  const { h } = await harness(t);
  let listed = 0;
  h.sessionSwitch.sessions = async () => { listed++; return []; };
  const moments = fakeJev(h, m => m.trigger === 'job' ? { needsAgent: .1, ready: .9 } : {});
  await turn(h, 'Turn off this session.');
  assert.equal(listed, 0);
  assert.equal(moments.find(m => m.trigger === 'turn')!.sessions, undefined);
  assert.doesNotMatch(liveInstructions(claude, { jev: true, features: h.features }), /voice sessions on or off/);
  assert.doesNotMatch(new Jev({ apiKey: 'k', log: () => {}, agent: claude, features: h.features }).setting, /voice sessions on or off/);
  assert.match(liveInstructions(claude, { jev: true, features: new Set(['orchestration']) }), /it also turns voice sessions on or off and pauses the companion/);
});

test("with instructions and configuration off, nothing learns the operator's standing instructions or changes the settings, and nobody is told it does", async t => {
  const { h } = await harness(t, { jevKey: 'k', features: [] });
  assert.equal(h.learner, undefined);
  assert.equal(h.jevTuning, false);
  const moments = fakeJev(h);
  await h.read({ trigger: 'turn', spoken: [{ role: 'operator', text: 'From now on, talk less.', at: Date.now() }] });
  assert.equal(moments[0].learn, undefined);
  assert.equal(moments[0].tune, undefined);
  const text = liveInstructions(claude, { jev: true, features: h.features });
  assert.doesNotMatch(text, /standing instructions|adjusts the companion's settings/);
  assert.match(text, /it also pauses the companion when the conversation is over for now\./);
  assert.match(liveInstructions(claude, { jev: true }), /it also keeps the operator's standing instructions to the companion and pauses the companion/);
});
