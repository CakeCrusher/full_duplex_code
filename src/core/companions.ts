import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from './bridge.ts';

/** A running companion, as its bridge registered itself. */
export interface CompanionEntry {
  pid: number; port: number; token: string; cwd: string;
  /** The agent's product name: Claude Code, Codex or Pi. */
  agent: string;
  sessionId?: string; startedAt: number;
  /** The tunnel's origin, with --public. */
  publicUrl?: string;
}
/** What a page is told about one companion. */
export interface CompanionSummary {
  id: string; current: boolean; folder: string; agent: string; sessionId: string | null;
  reachable: boolean; agentReady: boolean; agentState: string | null;
  voice: 'none' | 'connecting' | 'active'; voicePage: boolean; pages: number;
  public: boolean; startedAt: number;
  /** Where the page can switch to it, or null where it may not learn the token. */
  link: string | null;
}

// A process that exists but is not ours (EPERM) keeps its entry: removing a
// live companion's entry would hide it, while a stale one only shows as unreachable.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const httpsOrigin = (url: unknown) => { try { const { protocol, origin } = new URL(url as string); return protocol === 'https:' && origin === url; } catch { return false; } };
const valid = (e: any): e is CompanionEntry => Boolean(e) && Number.isSafeInteger(e.pid) && e.pid > 0 && Number.isInteger(e.port) && e.port > 0 && e.port < 65536
  && typeof e.token === 'string' && /^[0-9a-f]{64}$/.test(e.token) && typeof e.cwd === 'string' && typeof e.agent === 'string' && Number.isFinite(e.startedAt)
  && (e.sessionId === undefined || typeof e.sessionId === 'string') && (e.publicUrl === undefined || httpsOrigin(e.publicUrl));

// The companions this user is running, so that one page can switch between
// them. Each bridge writes its entry as it starts and removes it as it stops;
// a crashed one's entry goes once its process has ended. Entries hold page
// tokens, as powerful as the links fdc prints, so only this user may read them.
export class CompanionRegistry {
  dir: string;
  constructor(dir: string) { this.dir = dir; }
  private open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error(`${this.dir} is not a directory of this user.`);
    if (stat.mode & 0o077) fs.chmodSync(this.dir, 0o700);
  }
  file({ pid, port }: { pid: number; port: number }) { return path.join(this.dir, `${pid}-${port}.json`); }
  // Written whole, then renamed: another companion never reads half an entry.
  register(entry: CompanionEntry) {
    this.open();
    const file = this.file(entry), temporary = `${file}.tmp`;
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  }
  remove(entry: { pid: number; port: number }) { fs.rmSync(this.file(entry), { force: true }); }
  /** Entries of running processes; the others are removed. None when the directory is not this user's. */
  list(): CompanionEntry[] {
    try { this.open(); } catch { return []; }
    const entries: CompanionEntry[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^\d+-\d+\.json$/.test(name)) continue;
      let entry;
      try { entry = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { continue; }
      if (!valid(entry) || name !== path.basename(this.file(entry))) continue;
      if (alive(entry.pid)) entries.push(entry); else fs.rmSync(path.join(this.dir, name), { force: true });
    }
    return entries;
  }
}

// Another companion's status, asked with its own token. Busy, stopped or not a
// companion at all, it is unreachable rather than an error.
async function statusOf({ port, token }: CompanionEntry, timeoutMs: number): Promise<Record<string, any> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : undefined;
  } catch { return undefined; }
}

export function summarize(entry: CompanionEntry, status: Record<string, any> | undefined, { current, local }: { current: boolean; local: boolean }): CompanionSummary {
  const sessionId = typeof status?.sessionId === 'string' ? status.sessionId : entry.sessionId;
  return {
    id: `${entry.pid}-${entry.port}`, current, folder: path.basename(entry.cwd) || entry.cwd, agent: entry.agent, sessionId: sessionId?.slice(0, 8) ?? null,
    reachable: Boolean(status), agentReady: status?.agentReady === true, agentState: typeof status?.agent === 'string' ? status.agent : null,
    voice: status?.live === 'active' ? 'active' : ['new', 'connecting'].includes(status?.live) ? 'connecting' : 'none',
    voicePage: Boolean(status?.voicePage), pages: Number.isInteger(status?.pages) ? status!.pages : 0,
    public: Boolean(entry.publicUrl), startedAt: entry.startedAt,
    // Through the tunnel, only links the tunnel already exposes: never a local-only companion's token.
    link: local ? `http://127.0.0.1:${entry.port}/#${entry.token}` : entry.publicUrl ? `${entry.publicUrl}/#${entry.token}` : null,
  };
}

/** Every running companion, oldest first, as the page that asked may see them. */
export async function listCompanions(bridge: Harness, local: boolean, timeoutMs = 1000): Promise<CompanionSummary[]> {
  const own = bridge.companionEntry();
  const entries = [own, ...bridge.companions.list().filter(entry => entry.pid !== own.pid || entry.port !== own.port)].sort((a, b) => a.startedAt - b.startedAt || a.port - b.port);
  return Promise.all(entries.map(async entry => entry === own ? summarize(own, bridge.status(), { current: true, local })
    : summarize(entry, await statusOf(entry, timeoutMs), { current: false, local })));
}
