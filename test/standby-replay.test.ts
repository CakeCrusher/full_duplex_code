// The Standby chart's data: each run's compact activity log, and its replay for every quiet window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog, readActivity, replay, sweep } from '../src/core/standby-replay.ts';
import { DEFAULT_TUNING } from '../src/core/tuning.ts';
import { harness, page, until } from './live-fake.ts';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-activity-')), 'activity.jsonl');

test('the log counts sound per second and records events, only while voice is on', () => {
  const at = 1_000_000, log = new ActivityLog(file());
  log.count('speech', at); log.event('tool', at);
  log.voice(true, at);
  for (let i = 0; i < 9; i++) log.count('speech', at + 100 + i * 100);
  log.count('live', at + 950); log.count('words', at + 990);
  log.count('speech', at + 1200);
  log.event('turn_end', at + 1500);
  log.voice(false, at + 7000);
  const lines = fs.readFileSync(log.file!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines, [[at, 'on'], [at, 'n', 9, 1, 1], [at + 1000, 'n', 1, 0, 0], [at + 1500, 'turn_end'], [at + 7000, 'off']]);
  const [session] = readActivity(fs.readFileSync(log.file!, 'utf8'));
  assert.deepEqual([session.start, session.end, session.counts.length, session.events], [at, at + 7000, 2, [[at + 1500, 'turn_end']]]);
});

test('a replay follows Standby\'s rules: quiet for the window goes on Standby, news wakes it, sound with no words is noise', () => {
  const start = 0, session = { start, end: 120000, counts: [[1000, 20, 0, 3]] as [number, number, number, number][], events: [[70000, 'text'], [100000, 'tool']] as [number, any][] };
  // On Standby again by 101 s; at 110 s, sound with no words around it.
  session.counts.push([110000, 2, 0, 0]);
  const tuning = { ...DEFAULT_TUNING, wakeThreshold: 10 }, r = replay(session, tuning, 30000);
  // Live 0-31 s (its sound at 1 s keeps it on until it leaves the window), Standby until the message at 70 s, waking 1 s.
  assert.equal(r.wakes, 2, 'the message, then sound with no words');
  assert.equal(r.noise, 1);
  assert.ok(r.billedMs > 40000 && r.billedMs < 90000, String(r.billedMs));
  assert.equal(replay(session, tuning, 0).billedMs, 121000, 'a window of 0: Standby off, all of it billed');
});

test('the sweep covers every window from off to 300 s, saving more and waking more as the window shortens', async () => {
  const session = { start: 0, end: 3600000, counts: [] as [number, number, number, number][], events: [] as [number, any][] };
  for (let t = 0; t < 3600000; t += 90000) session.counts.push([t, 5, 5, 2]);
  const points = await sweep([session], DEFAULT_TUNING);
  assert.equal(points.length, 61);
  assert.deepEqual([points[0].windowS, points[0].saved, points[0].wakesPerHour], [0, 0, 0]);
  const at = (w: number) => points.find(p => p.windowS === w)!;
  assert.ok(at(20).saved > at(60).saved && at(60).saved > at(120).saved, 'shorter windows save more');
  assert.ok(at(20).wakesPerHour >= at(120).wakesPerHour);
});

test('the bridge records the conversation while voice is on, and the page gets the sweep', async t => {
  const { h } = await harness(t);
  const voicePage = page('voice-page');
  Object.assign(voicePage.ws, { terminate() {}, close() {}, on() {} });
  h.pages.all.set(voicePage.ws, voicePage);
  await h.startLive(undefined, voicePage, 'fresh');
  h.voiceSessions.heard({ at: Date.now(), inputRms: .05, rawInputRms: .05, gateThreshold: .008, outputRms: .05 } as any);
  (h.adapter.observations as any).observe({ session_id: h.sessionId, hook_event_name: 'Stop', last_assistant_message: 'Done.' });
  await h.live!.close('operator ended voice');
  await until(() => !h.activityLog.on);
  const kinds = fs.readFileSync(path.join(h.runDir, 'activity.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)[1]);
  assert.deepEqual(kinds, ['on', 'n', 'turn_end', 'off']);
  const response = await fetch(`${h.baseUrl}/api/standby?scope=run`, { headers: { Authorization: `Bearer ${h.browserToken}` } });
  const body = await response.json();
  assert.deepEqual([body.scope, body.windowS, body.threshold, body.points.length], ['run', 15, 50, 61]);
  assert.equal((await fetch(`${h.baseUrl}/api/standby?scope=run`)).status, 403, 'only with the page\'s token');
});
