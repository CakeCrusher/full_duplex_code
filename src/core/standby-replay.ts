// What Standby would have saved: each run records a compact log of its voice conversation (who made
// sound each second, the agent's events, requests), and the page's Standby chart replays those logs
// through Standby's rules (activity.ts, voice-sessions.ts) for every quiet window, with the current
// prices and threshold: the share of voice time not billed, and how often voice would have woken.
import fs from 'node:fs';
import path from 'node:path';
import { priceOf } from './activity.ts';
import type { ObservationKind } from './adapter.ts';
import type { Tuning } from './tuning.ts';

/** One line of a run's activity.jsonl: voice on or off, a second's sound counts, or one event. */
export type ActivityLine = [at: number, kind: 'on' | 'off'] | [at: number, kind: 'n', speech: number, live: number, words: number] | [at: number, kind: ObservationKind | 'request'];

// Records a run's voice conversation while voice is on (Standby keeps it on): the page's level reports
// of the operator's sound and GPT Live's audio, and GPT Live's transcript words, counted per second;
// the agent's events and requests as they happen.
export class ActivityLog {
  file?: string; on = false; second = -1;
  counts = { speech: 0, live: 0, words: 0 };
  constructor(file?: string) { this.file = file; }
  write(line: ActivityLine) {
    if (!this.file) return;
    try { fs.appendFileSync(this.file, JSON.stringify(line) + '\n', { mode: 0o600 }); } catch {}
  }
  voice(on: boolean, at = Date.now()) {
    if (on === this.on) return;
    this.flush(); this.on = on; this.write([at, on ? 'on' : 'off']);
  }
  count(kind: keyof ActivityLog['counts'], at = Date.now()) {
    if (!this.on) return;
    const second = Math.floor(at / 1000) * 1000;
    if (second !== this.second) { this.flush(); this.second = second; }
    this.counts[kind]++;
  }
  event(kind: ObservationKind | 'request', at = Date.now()) { if (this.on) { this.flush(); this.write([at, kind]); } }
  flush() {
    const { speech, live, words } = this.counts;
    if (speech || live || words) this.write([this.second, 'n', speech, live, words]);
    this.counts = { speech: 0, live: 0, words: 0 };
  }
}

/** A stretch of voice being on, with what happened in it. */
export interface ActivitySession { start: number; end: number; counts: [at: number, speech: number, live: number, words: number][]; events: [at: number, kind: ObservationKind | 'request'][] }

export function readActivity(text: string): ActivitySession[] {
  const sessions: ActivitySession[] = [];
  let open: ActivitySession | undefined;
  for (const line of text.split('\n')) {
    let entry: ActivityLine;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(entry) || typeof entry[0] !== 'number') continue;
    const [at, kind] = entry;
    if (kind === 'on') { if (open) open.end = at; open = { start: at, end: at, counts: [], events: [] }; sessions.push(open); continue; }
    if (!open) continue;
    open.end = Math.max(open.end, at);
    if (kind === 'off') { open = undefined; continue; }
    if (kind === 'n') { const [, , speech, live, words] = entry as [number, 'n', number, number, number]; open.counts.push([at, speech, live, words]); }
    else open.events.push([at, kind]);
  }
  // A session never turned off (voice still on, or fdc stopped) ends at its last record.
  return sessions.filter(session => session.end - session.start >= 5000);
}

// The page reports levels about every 0.107 s (128-sample blocks, 20 per report, at 24 kHz).
const REPORT_MS = 2560 / 24;
// Seeded wakes connected in 0.56-1.88 s on Oct 18 (median 0.77 s).
const WAKE_MS = 1000;
/** Billed time, wakes (and those for sound with no words), GPT Live's audio it would not have played, and the agent's turn ends that arrived on Standby without waking it. */
export interface Replayed { billedMs: number; wakes: number; noise: number; missedMs: number; quietTurnEnds: number }

/** One session through Standby's rules, a second at a time: the same rules as VoiceSessions.checkStandby. */
export function replay(session: ActivitySession, tuning: Tuning, windowMs = tuning.standbyAfterMs): Replayed {
  const queue: [at: number, value: number, kind: string][] = [];
  let head = 0, sum = 0, c = 0, e = 0, mode: 'live' | 'standby' | 'waking' = 'live', liveFrom = session.start;
  const result: Replayed = { billedMs: 0, wakes: 0, noise: 0, missedMs: 0, quietTurnEnds: 0 };
  let turnEndsNow = 0;
  const add = (at: number, value: number, kind: string) => { if (value > 0) { queue.push([at, value, kind]); sum += value; } };
  const words = session.counts.filter(([, , , w]) => w > 0).map(([at]) => at);
  let w = 0;
  for (let t = session.start; t <= session.end; t += 1000) {
    for (; c < session.counts.length && session.counts[c][0] <= t; c++) {
      const [at, speech, live] = session.counts[c];
      add(at, speech * tuning.speechPrice, 'speech');
      // GPT Live's audio only exists while it is connected.
      if (mode === 'live') add(at, live * tuning.liveSpeechPrice, 'live'); else result.missedMs += live * REPORT_MS;
    }
    turnEndsNow = 0;
    for (; e < session.events.length && session.events[e][0] <= t; e++) {
      const [at, kind] = session.events[e];
      add(at, kind === 'request' ? tuning.requestPrice : priceOf(tuning, kind), kind);
      if (kind === 'turn_end' && mode === 'standby') turnEndsNow++;
    }
    if (windowMs > 0) while (head < queue.length && queue[head][0] <= t - windowMs) sum -= queue[head++][1];
    if (sum < 1e-9) sum = 0;
    if (mode === 'waking' && t >= liveFrom) mode = 'live';
    if (windowMs > 0) {
      if (mode === 'live' && t - liveFrom >= windowMs && sum < tuning.wakeThreshold) mode = 'standby';
      else if (mode === 'standby' && sum >= tuning.wakeThreshold) {
        result.wakes++;
        // Woken by sound with no transcribed words a second before to five after: noise.
        if (queue.at(-1)?.[2] === 'speech') {
          while (w < words.length && words[w] < t - 1000) w++;
          if (!(w < words.length && words[w] <= t + 5000)) result.noise++;
        }
        mode = 'waking'; liveFrom = t + WAKE_MS;
      }
    }
    // A turn end on Standby that did not wake it: GPT Live tells the operator only once something else wakes it.
    if (mode === 'standby') result.quietTurnEnds += turnEndsNow;
    if (mode === 'live') result.billedMs += 1000;
  }
  return result;
}

export interface SweepPoint { windowS: number; saved: number; wakesPerHour: number; noisePerHour: number; wakes: number; noise: number; savedUsd: number }
export const WINDOWS_S = Array.from({ length: 61 }, (_, i) => i * 5);

/** Every quiet window from off to 300 s over these sessions, with the other settings as they are; it yields between windows. */
export async function sweep(sessions: ActivitySession[], tuning: Tuning, windowsS = WINDOWS_S): Promise<SweepPoint[]> {
  const connectedMs = sessions.reduce((n, s) => n + (s.end - s.start), 0), hours = connectedMs / 3600000;
  const points: SweepPoint[] = [];
  for (const windowS of windowsS) {
    let billedMs = 0, wakes = 0, noise = 0;
    for (const session of sessions) { const r = replay(session, tuning, windowS * 1000); billedMs += Math.min(r.billedMs, session.end - session.start); wakes += r.wakes; noise += r.noise; }
    points.push({ windowS, saved: connectedMs ? 100 - 100 * billedMs / connectedMs : 0, wakesPerHour: hours ? wakes / hours : 0, noisePerHour: hours ? noise / hours : 0, wakes, noise, savedUsd: (connectedMs - billedMs) / 60000 * .05 });
    await new Promise(resolve => setImmediate(resolve));
  }
  return points;
}

// Recorded runs, read once each: a finished run's log no longer changes.
const cache = new Map<string, { mtimeMs: number; sessions: ActivitySession[] }>();
/** The activity logs of this run, or of every run kept in `.runs`. */
export function recordedSessions(root: string, runDir: string, scope: 'run' | 'all'): ActivitySession[] {
  const files = scope === 'run' ? [path.join(runDir, 'activity.jsonl')]
    : fs.readdirSync(path.join(root, '.runs'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, '.runs', entry.name, 'activity.jsonl'));
  if (scope === 'all' && !files.includes(path.join(runDir, 'activity.jsonl'))) files.push(path.join(runDir, 'activity.jsonl'));
  return files.flatMap(file => {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return []; }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.sessions;
    const sessions = readActivity(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs: stat.mtimeMs, sessions });
    return sessions;
  });
}
