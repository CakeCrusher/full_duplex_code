// Voice notes: the operator's spoken notes on the run's timeline (notes.ts), and the chord that records one from
// anywhere on the Mac (hotkey.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceNotes, NOTE_LIMITS } from '../src/core/notes.ts';
import { NoteHotkey } from '../src/core/hotkey.ts';
import { Timeline } from '../src/core/timeline.ts';
import { claude } from '../src/adapters/claude/index.ts';

function bridge() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-notes-')), timeline = new Timeline(0, claude), logged: any[] = [], published: any[] = [];
  return { runDir, timeline, logged, published, log: (event: any) => logged.push(event), publish: (event: any) => { published.push(event); timeline.add(event); } };
}
const piece = (text: string) => Buffer.from(text).toString('base64');

test("a note is the audio of the stretch it covers, saved in the run's notes folder, on its own track", () => {
  const b = bridge(), notes = new VoiceNotes(b), page = { id: 'p1' }, at = Date.now();
  notes.start(page, 'key-0001', at, 'audio/webm;codecs=opus');
  const item = () => b.timeline.snapshot().items.find(i => i.track === 'notes')!;
  assert.equal(item().active, true, 'it records');
  notes.audio(page, 'key-0001', piece('first '));
  notes.audio(page, 'key-0001', piece('second'));
  notes.end(page, 'key-0001', at + 1500);
  assert.equal(fs.readFileSync(path.join(b.runDir, 'notes', 'note-1.webm'), 'utf8'), 'first second', 'the pieces in order');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.runDir, 'notes.json'), 'utf8')), [{ id: 'note-1', start: at, end: at + 1500, file: 'notes/note-1.webm', type: 'audio/webm;codecs=opus', bytes: 12 }]);
  assert.deepEqual([item().start, item().end, item().active], [at, at + 1500, false]);
  assert.match(item().text, /1\.5 s of your voice, saved as notes\/note-1\.webm/);
  assert.deepEqual(b.logged.map(e => e.type), ['note.started', 'note.saved']);
  assert.equal(b.timeline.snapshot().items.length, 1, 'one item, updated as it grows');
});

test('only the page recording a note adds to it; a far-off clock, an odd key or an oversized piece is refused', () => {
  const b = bridge(), notes = new VoiceNotes(b), at = Date.now();
  notes.start({ id: 'p1' }, 'bad key!', at, 'audio/webm');
  notes.start({ id: 'p1' }, 'key-0002', at - NOTE_LIMITS.clock - 1000, 'audio/webm');
  assert.equal(notes.notes.length, 0);
  notes.start({ id: 'p1' }, 'key-0003', at, 'audio/ogg;codecs=opus');
  notes.audio({ id: 'p2' }, 'key-0003', piece('not mine'));
  notes.audio({ id: 'p1' }, 'key-0003', 'A'.repeat(Math.ceil(NOTE_LIMITS.piece / 3) * 4 + 4));
  notes.end({ id: 'p2' }, 'key-0003', at + 10);
  assert.equal(notes.notes[0].bytes, 0); assert.equal(notes.notes[0].recording, true, "another page can't end it");
  assert.equal(notes.notes[0].file, 'notes/note-1.ogg');
});

test('a page that goes away mid-note leaves the note ending at its last audio', () => {
  const b = bridge(), notes = new VoiceNotes(b), at = Date.now() - 2000;
  notes.start({ id: 'p1' }, 'key-0004', at, 'audio/webm');
  notes.audio({ id: 'p1' }, 'key-0004', piece('words'));
  notes.closePage({ id: 'p1' });
  const [saved] = JSON.parse(fs.readFileSync(path.join(b.runDir, 'notes.json'), 'utf8'));
  assert.ok(saved.end > at && saved.end <= Date.now()); assert.equal(saved.bytes, 5);
  assert.equal(notes.open.size, 0);
});

// A stand-in for a running fdc's bridge: its pages, the one running voice, what it sent them.
function companion(name: string, { voice = false, pages = 1 } = {}) {
  const sent: [string, any][] = [], open = Array.from({ length: pages }, (_, i) => ({ id: `${name}-${i + 1}` }));
  return { sent, fake: { stopping: false, log: () => {}, publish: () => {}, status: () => ({ type: 'status' }),
    pages: { all: new Map(open.map((page, i) => [i, page])), send: (page: any, event: any) => sent.push([page.id, event]) }, voiceSessions: { page: voice ? open[0] : undefined } } as any };
}
const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

test('the chord held anywhere records on the page that runs voice, else the page opened last, with a sound at the start and the release', async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-chord-')), 'note-chord.lock'), sounds: string[] = [];
  const { sent, fake } = companion('a', { voice: true, pages: 2 });
  const hotkey = new NoteHotkey(fake, { sound: name => sounds.push(name), lock, waits: { page: 20, none: 40 } });
  // A stand-in listener: ready, the chord held and let go, then it waits for fdc to close its input.
  const listener = path.join(path.dirname(lock), 'listener');
  fs.writeFileSync(listener, '#!/bin/sh\necho ready\nsleep 0.1\necho down\nsleep 0.2\necho up\ncat >/dev/null\n', { mode: 0o755 });
  await hotkey.start(listener);
  for (let i = 0; i < 100 && sent.length < 2; i++) await settle(20);
  assert.equal(hotkey.state, 'ready');
  assert.deepEqual(sent, [['a-1', { type: 'note_hotkey', down: true }], ['a-1', { type: 'note_hotkey', down: false }]]);
  assert.deepEqual(sounds, ['down', 'up']);
  assert.equal(fs.existsSync(lock), false, 'the release frees the claim');
  // Without voice, the page opened last.
  fake.voiceSessions.page = undefined; hotkey.line('down'); await settle(); hotkey.line('up');
  assert.deepEqual(sent.slice(2).map(([page]) => page), ['a-2', 'a-2']);
  hotkey.close();
});

test('with several fdc running, one answers each press: the one running voice, else one with a page, else one sound that nothing records', async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-chord-')), 'note-chord.lock'), sounds: string[] = [];
  const press = async (...all: NoteHotkey[]) => { for (const h of all) h.line('down'); await settle(); for (const h of all) h.line('up'); };
  const make = (c: ReturnType<typeof companion>) => new NoteHotkey(c.fake, { sound: name => sounds.push(name), lock, waits: { page: 20, none: 40 } });
  const idle = companion('idle'), talking = companion('talking', { voice: true });
  await press(make(idle), make(talking));
  assert.deepEqual([idle.sent.length, talking.sent.map(([page, e]) => `${page} ${e.down}`)], [0, ['talking-1 true', 'talking-1 false']]);
  const one = companion('one'), two = companion('two');
  await press(make(one), make(two));
  assert.equal(one.sent.length + two.sent.length, 2, 'one of the two answers, start and release');
  sounds.length = 0;
  await press(make(companion('x', { pages: 0 })), make(companion('y', { pages: 0 })));
  assert.deepEqual(sounds, ['nowhere'], 'no page anywhere: one sound says so');
  // A claim left by an fdc that has gone is taken over.
  fs.writeFileSync(lock, '999999'); const after = companion('after');
  await press(make(after));
  assert.equal(after.sent.length, 2);
});

test("macOS refusing the keys leaves the button: the page is told why", () => {
  const states: string[] = [];
  const fake: any = { log: () => {}, publish: () => states.push(hotkey.state), status: () => ({}) };
  const hotkey = new NoteHotkey(fake, { sound: () => {} });
  hotkey.line('denied');
  assert.deepEqual(states, ['denied']);
});
