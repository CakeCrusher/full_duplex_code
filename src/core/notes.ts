import fs from 'node:fs';
import path from 'node:path';
import type { BridgeEvent } from './status.ts';

// The operator's voice notes: their own speech, recorded from the page (web/voice-notes.ts) to label how fdc did. Each
// is an audio file in the run's notes folder with the stretch it covers, on the run's clock, drawn on its own timeline
// track. They are the operator's alone: while one records, the page's session microphone sends the voice silence, and
// nothing of a note reaches the voice, Jev or the agent. notes.json lists the run's notes; events.jsonl has each one's
// start and end.

/** A piece of audio, a run's notes in all (a minute at the page's bitrate is about half a megabyte), and how far the
 *  page's clock may be from the bridge's. */
export const NOTE_LIMITS = { piece: 1 << 20, run: 500 << 20, clock: 5000 };
const EXTENSIONS: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

export interface Note { id: string; start: number; end: number; file: string; type: string; bytes: number; page: string; recording: boolean }
type Bridge = { runDir: string; log(event: BridgeEvent): void; publish(event: BridgeEvent): void };

export class VoiceNotes {
  bridge: Bridge;
  notes: Note[] = [];
  /** Notes recording now, by the key their page gave them. */
  open = new Map<string, Note>();
  bytes = 0;
  constructor(bridge: Bridge) { this.bridge = bridge; }
  /** A page started recording at `at` (its clock): the audio follows in pieces, under the page's key. */
  start(page: { id: string }, key: string, at: number, type: string) {
    if (!/^[\w-]{8,64}$/.test(key) || this.open.has(key) || !Number.isFinite(at) || Math.abs(at - Date.now()) > NOTE_LIMITS.clock) return;
    const id = `note-${this.notes.length + 1}`, mime = String(type).slice(0, 80);
    const file = `notes/${id}.${EXTENSIONS[mime.split(';')[0]] ?? 'webm'}`;
    fs.mkdirSync(path.join(this.bridge.runDir, 'notes'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.bridge.runDir, file), '', { mode: 0o600 });
    const note: Note = { id, start: at, end: at, file, type: mime, bytes: 0, page: page.id, recording: true };
    this.notes.push(note); this.open.set(key, note);
    this.bridge.log({ type: 'note.started', id, start: at, file, page: page.id });
    this.show(note);
  }
  /** A piece of the recording, base64, in order. */
  audio(page: { id: string }, key: string, data: unknown) {
    const note = this.open.get(key);
    if (!note || note.page !== page.id || typeof data !== 'string' || data.length > Math.ceil(NOTE_LIMITS.piece / 3) * 4) return;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || this.bytes + bytes.length > NOTE_LIMITS.run) return;
    fs.appendFileSync(path.join(this.bridge.runDir, note.file), bytes);
    note.bytes += bytes.length; this.bytes += bytes.length;
    note.end = Math.max(note.end, Date.now());
    this.show(note);
  }
  /** Recording stopped at `at`; without it (the page went away), the note ends at its last audio. */
  end(page: { id: string }, key: string, at?: number) {
    const note = this.open.get(key);
    if (!note || note.page !== page.id) return;
    this.open.delete(key);
    if (typeof at === 'number' && Number.isFinite(at) && at >= note.start && Math.abs(at - Date.now()) <= NOTE_LIMITS.clock) note.end = at;
    note.recording = false;
    this.bridge.log({ type: 'note.saved', id: note.id, start: note.start, end: note.end, file: note.file, bytes: note.bytes });
    this.save(); this.show(note);
  }
  /** The page closed: its notes end where their audio does. */
  closePage(page: { id: string }) { for (const [key, note] of [...this.open]) if (note.page === page.id) this.end(page, key); }
  close() { for (const [key, note] of [...this.open]) this.end({ id: note.page }, key); }
  save() {
    const notes = this.notes.filter(note => !note.recording).map(({ id, start, end, file, type, bytes }) => ({ id, start, end, file, type, bytes }));
    fs.writeFileSync(path.join(this.bridge.runDir, 'notes.json'), JSON.stringify(notes, null, 1) + '\n', { mode: 0o600 });
  }
  show({ id, start, end, file, bytes, recording }: Note) { this.bridge.publish({ type: 'note', id, start, end, file, bytes, recording }); }
}
