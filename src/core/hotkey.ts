import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import type { Harness } from './bridge.ts';
import type { Page } from './pages.ts';

// The voice-note chord: Right Command and Right Option held together anywhere on this Mac record a voice note
// (notes.ts) on the page that runs voice, or else the page opened last, until either key is let go; a sound marks the
// start and the release. A small listener (note-chord.swift) watches the modifier keys, built once with the Command
// Line Tools' swiftc into fdc's cache. macOS lets it hear them only once the terminal app running fdc has Input
// Monitoring (System Settings › Privacy & Security); until then notes record from the page's button alone.
// FDC_NOTE_HOTKEY=0 turns it off.
//
// Every fdc running hears the chord, and one answers each press: the one running voice (or on Standby) at once, else
// one with a page open a moment later, else, a moment after that, one that sounds that nothing records. Answering is
// a claim on a lock file, freed at the release, or once its fdc has gone.

const SOURCE = new URL('./note-chord.swift', import.meta.url);
const SOUNDS = { down: '/System/Library/Sounds/Tink.aiff', up: '/System/Library/Sounds/Pop.aiff', nowhere: '/System/Library/Sounds/Basso.aiff' };
export type HotkeyState = 'off' | 'starting' | 'ready' | 'denied' | 'unavailable';
const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'fdc');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** The listener, built from its source when it changed: the cached binary is named by the source's hash. */
export async function buildListener(cache = CACHE) {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const binary = path.join(cache, `note-chord-${createHash('sha1').update(source).digest('hex').slice(0, 12)}`);
  if (fs.existsSync(binary)) return binary;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdc-chord-'));
  try {
    // A single file named main.swift is a program: its top-level code runs.
    fs.writeFileSync(path.join(dir, 'main.swift'), source);
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    await promisify(execFile)('swiftc', ['-O', '-o', `${binary}.part`, path.join(dir, 'main.swift')], { timeout: 180000 });
    fs.renameSync(`${binary}.part`, binary);
    return binary;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export class NoteHotkey {
  bridge: Harness; state: HotkeyState = 'off'; child?: ChildProcess;
  /** The page recording for the chord held now; whether this fdc answered it; its answer, waiting its turn. */
  target?: Page; holding = false; pending?: NodeJS.Timeout;
  sound: (name: keyof typeof SOUNDS) => void; lock: string; waits: { page: number; none: number };
  constructor(bridge: Harness, { sound = (name: keyof typeof SOUNDS) => { spawn('afplay', [SOUNDS[name]], { stdio: 'ignore' }).on('error', () => {}); },
    lock = path.join(CACHE, 'note-chord.lock'), waits = { page: 150, none: 300 } } = {}) {
    this.bridge = bridge; this.sound = sound; this.lock = lock; this.waits = waits;
  }
  async start(listener?: string) {
    if (!listener && (process.platform !== 'darwin' || process.env.FDC_NOTE_HOTKEY === '0')) return;
    this.set('starting');
    let binary: string;
    try { binary = listener ?? await buildListener(); }
    catch (error) { this.bridge.log({ type: 'note.hotkey_unavailable', message: (error as Error).message.slice(0, 400) }); this.set('unavailable'); return; }
    if (this.bridge.stopping) return;
    const child = this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    createInterface({ input: child.stdout! }).on('line', line => this.line(line.trim()));
    child.on('error', error => { this.bridge.log({ type: 'note.hotkey_unavailable', message: error.message }); this.set('unavailable'); });
    child.on('exit', () => { if (this.child === child && this.state !== 'denied') this.set('unavailable'); this.release(); });
  }
  line(text: string) {
    if (text === 'ready' || text === 'denied') { this.set(text); if (text === 'denied') this.bridge.log({ type: 'note.hotkey_denied' }); }
    if (text === 'down') this.press();
    if (text === 'up') this.release();
  }
  press() {
    // A release this fdc missed: the press before is over.
    this.release();
    const { pages, voiceSessions } = this.bridge, open = [...pages.all.values()];
    const voice = voiceSessions.page && open.includes(voiceSessions.page) ? voiceSessions.page : undefined, page = voice ?? open.at(-1);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (!this.claim()) return;
      this.bridge.log({ type: 'note.hotkey', down: true, page: page?.id ?? null });
      if (!page) { this.sound('nowhere'); return; }
      this.target = page; this.sound('down');
      pages.send(page, { type: 'note_hotkey', down: true });
    }, voice ? 0 : page ? this.waits.page : this.waits.none);
  }
  release() {
    clearTimeout(this.pending); this.pending = undefined;
    if (!this.holding) return;
    this.holding = false; fs.rmSync(this.lock, { force: true });
    const page = this.target; if (!page) return;
    this.target = undefined; this.sound('up');
    this.bridge.log({ type: 'note.hotkey', down: false, page: page.id });
    this.bridge.pages.send(page, { type: 'note_hotkey', down: false });
  }
  /** Answers this press, unless another fdc did: the lock file holds the answering process. */
  claim(retry = true): boolean {
    try {
      fs.mkdirSync(path.dirname(this.lock), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return this.holding = true;
    } catch {
      let pid = 0; try { pid = Number(fs.readFileSync(this.lock, 'utf8')); } catch {}
      if ((Number.isSafeInteger(pid) && pid > 0 && alive(pid)) || !retry) return false;
      // Its fdc has gone without freeing it.
      fs.rmSync(this.lock, { force: true });
      return this.claim(false);
    }
  }
  set(state: HotkeyState) { this.state = state; this.bridge.publish(this.bridge.status()); }
  close() { this.release(); const child = this.child; this.child = undefined; child?.stdin?.end(); child?.kill(); }
}
