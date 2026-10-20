// The stage: the page the coding agent last showed the operator in the browser. fdc runs the
// stage script there (stage-page.js) through its own connection to Open Claude in Chrome, so
// the gate can move the page, highlight and read it without the agent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Observation } from './adapter.ts';
import { Browser } from './browser.ts';
import { cueWords, type SpeechCue } from './speech-cues.ts';
import type { PageAction } from './fast-action.ts';

const RAW = fs.readFileSync(new URL('./stage-page.js', import.meta.url), 'utf8');
// A page keeps the script it was given until the script changes: its version is its content's hash.
const SCRIPT = RAW.replace('__FDC_STAGE_VERSION__', createHash('sha1').update(RAW).digest('hex').slice(0, 12));
/** A pause between the steps of a sequence, so each one is seen ("the DNS lookup, then the response"). */
const STEP_DWELL_MS = 1000;
/** Browser tools that show a tab to the operator: the tab they act on becomes the stage. */
const SHOWS = /chrome[\w-]*__(navigate|set_tab_focus|tabs_create_mcp|execute_code)$/;

export interface StageCommand { id: string; say: string; /** The element id it lands on, when it has one. */ anchor?: string; /** What people call its target, for speech cues. */ name?: string; /** A whole section. */ top?: boolean }
export interface StageView { tabId: number; title: string; url: string; about: string | null; where: string; commands: StageCommand[]; /** What the page says, part by part, in its own words: what the voice knows of it. */ parts: StagePart[] }
export interface StagePart { name: string; text: string }
export interface StageRun { done: StageCommand[]; onScreen: string }
/** A page command threw: the page's controller is broken, or was asked something it can't do. */
export class StageError extends Error {
  done: StageCommand[]; onScreen: string; failed: StageCommand;
  constructor(message: string, done: StageCommand[], onScreen: string, failed: StageCommand) { super(message); this.done = done; this.onScreen = onScreen; this.failed = failed; }
}
/** A page command had nothing to do (no earlier place to go back to, no next slide): the request goes on. */
export class StageNothing extends StageError {}

export class Stage {
  browser: Browser;
  log: (event: Record<string, unknown>) => void;
  tabId?: number;
  view?: StageView; viewAt = 0;
  /** The pages the agent showed this session, by tab: the voice can switch back to them ("go back to the diagram"). */
  pages = new Map<number, { title: string; url: string; about: string | null }>();
  /** The stage moved to another tab. */
  onChange?: () => void;
  /** Where the tab on stage is remembered across restarts of fdc (a day at most); describe() drops it if it is gone. */
  file?: string;
  constructor({ log, browser = new Browser(), onChange, file }: { log: (event: Record<string, unknown>) => void; browser?: Browser; onChange?: () => void; file?: string }) {
    this.log = log; this.browser = browser; this.onChange = onChange; this.file = file;
    try {
      const saved = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
      if (Number.isInteger(saved?.tabId) && saved.tabId > 0 && Date.now() - saved.at < 86400000) { this.tabId = saved.tabId; log({ type: 'stage.restored', tabId: saved.tabId, url: saved.url }); }
    } catch {}
  }
  /** Remembers the tab on stage (or that there is none) for the next start of fdc. */
  remember() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ tabId: this.tabId ?? null, url: this.view?.url ?? this.pages.get(this.tabId ?? 0)?.url ?? null, at: Date.now() })); } catch {}
  }
  /**
   * The agent's own browser tool calls say which tab it showed the operator. At the end of each of its turns the page is
   * read again, since the agent may have rebuilt it however it reloaded it: the voice is briefed anew if its parts changed.
   */
  observe({ raw }: Pick<Observation, 'raw'>, turnEnded = false) {
    if (turnEnded && this.tabId) { this.view = undefined; this.onChange?.(); return; }
    if (raw?.hook_event_name !== 'PostToolUse' || !SHOWS.test(String(raw.tool_name ?? ''))) return;
    const input = raw.tool_input ?? {}, response = typeof raw.tool_response === 'string' ? raw.tool_response : JSON.stringify(raw.tool_response ?? '');
    const created = /Tab ID: (\d+)/.exec(response)?.[1];
    const named = typeof input.tabId === 'number' ? input.tabId : [...String(input.code ?? '').matchAll(/(?:navigate|set_tab_focus)\(\s*\{[^}]*?tabId:\s*(\d+)/g)].at(-1)?.[1];
    const tabId = Number(created ?? named);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    if (tabId !== this.tabId) this.log({ type: 'stage.tab', tabId, by: raw.tool_name });
    this.tabId = tabId; this.view = undefined; this.remember();
    this.onChange?.();
  }
  /** What the stage shows and the commands it offers; undefined without a stage. */
  async describe(maxAgeMs = 2000): Promise<StageView | undefined> {
    const tabId = this.tabId;
    if (!tabId) return;
    if (this.view?.tabId === tabId && Date.now() - this.viewAt < maxAgeMs) return this.view;
    const started = Date.now();
    let view: Omit<StageView, 'tabId'>;
    try { view = await this.browser.evaluate<Omit<StageView, 'tabId'>>(tabId, `${SCRIPT}\n;window.__fdcStage.describe()`, 3000); }
    catch (error) {
      // The tab was closed (or left the shared group): there is no stage until the agent shows another page.
      if (/not in the MCP group|No tab with id|tab.*(closed|not found)/i.test((error as Error).message) && this.tabId === tabId) { this.log({ type: 'stage.gone', tabId }); this.tabId = undefined; this.view = undefined; this.pages.delete(tabId); this.remember(); }
      throw error;
    }
    // A page's own controller can return anything: keep only well-formed commands.
    const str = (v: unknown, n = 300) => typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' ? String(v) : '';
    const commands = (Array.isArray(view?.commands) ? view.commands : []).filter((c: any) => c && str(c.id) && str(c.say)).map((c: any) => ({ id: str(c.id, 60), say: str(c.say), ...str(c.anchor) ? { anchor: str(c.anchor) } : {}, ...str(c.name, 80) ? { name: str(c.name, 80) } : {}, ...c.top ? { top: true } : {} }));
    const parts = (Array.isArray((view as any)?.parts) ? (view as any).parts : []).slice(0, 60).filter((p: any) => p && str(p.text)).map((p: any) => ({ name: str(p.name, 100) || 'Untitled part', text: str(p.text, 6001) }));
    this.view = { title: str(view?.title, 200), url: str(view?.url, 500), about: str(view?.about) || null, where: str(view?.where, 600), commands, parts, tabId }; this.viewAt = Date.now();
    this.pages.delete(tabId); this.pages.set(tabId, { title: this.view.title, url: this.view.url, about: this.view.about });
    // The other pages the agent showed are commands too, named by title, file and the page's own description, since people
    // name pages by what they are ("the diagram"); the page left last comes first.
    const others = [...this.pages].filter(([id]) => id !== tabId).reverse();
    others.forEach(([id, page], index) => commands.push({ id: `tab_${id}`, say: `Switch to the other page "${page.title.slice(0, 80)}" (${[page.url.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? page.url, page.about?.slice(0, 80)].filter(Boolean).join('; ')}), in another tab${index ? '' : ': the page shown before this one'}` }));
    this.log({ type: 'stage.described', tabId, url: this.view.url, commands: commands.length, ms: Date.now() - started });
    return this.view;
  }
  /** Runs commands in order, each finished before the next; resolves to what is on screen after. */
  async run(ids: string[]): Promise<StageRun> {
    const switchAt = ids.findIndex(id => /^tab_\d+$/.test(id));
    if (switchAt >= 0) return this.switchPage(ids, switchAt);
    const tabId = this.tabId, view = this.view;
    if (!tabId) throw new Error('No page is on the stage');
    const started = Date.now();
    // Steps run in order; one that throws stops the rest, and what ran before it is still reported.
    const { said, error, nothing, limit } = await this.browser.evaluate<{ said: string[]; error?: string; nothing?: boolean; limit?: string }>(tabId, `${SCRIPT}\n;(async () => { const said = []; for (const [i, id] of ${JSON.stringify(ids)}.entries()) { if (i) await new Promise(r => setTimeout(r, ${STEP_DWELL_MS})); let out; try { out = await window.__fdcStage.run(id); } catch (e) { return { said, error: String(e && e.message || e) }; } if (out == null) return { said, nothing: true }; if (window.__fdcStage.limit) return { said, limit: String(out) }; said.push(out); } return { said }; })()`, 15000);
    this.viewAt = 0;
    const command = (id: string) => view?.commands.find(c => c.id === id) ?? { id, say: id };
    const done = ids.slice(0, said.length).map(command);
    this.log({ type: error ? 'stage.failed' : nothing || limit ? 'stage.nothing' : 'stage.ran', tabId, ids, ran: said.length, error, limit, ms: Date.now() - started });
    if (error) throw new StageError(error, done, said.at(-1) ?? '', command(ids[said.length]));
    // Nothing to do there, or the page's answer that it had nothing to do ("Already on the last step"): not a move.
    if (nothing || limit) throw new StageNothing(limit ?? 'nothing to do there', done, said.at(-1) ?? '', command(ids[said.length]));
    return { done, onScreen: said.at(-1) ?? '' };
  }
  /** Brings another page the agent showed to the front, as the stage; steps before and after it run on their own page. */
  async switchPage(ids: string[], at: number): Promise<StageRun> {
    const before = at ? await this.run(ids.slice(0, at)) : { done: [], onScreen: '' };
    const tabId = Number(ids[at].slice(4)), page = this.pages.get(tabId), step = { id: ids[at], say: `Switch to the page "${page?.title ?? 'in another tab'}"` };
    try { await this.browser.call('set_tab_focus', { tabId }); }
    catch (error) { this.pages.delete(tabId); throw new StageError(`That page's tab is gone (${(error as Error).message.slice(0, 120)})`, before.done, before.onScreen, step); }
    this.log({ type: 'stage.tab', tabId, by: 'voice' });
    this.tabId = tabId; this.view = undefined; this.remember(); this.onChange?.();
    const rest = at + 1 < ids.length ? await this.run(ids.slice(at + 1)) : undefined;
    const view = rest ? undefined : await this.describe(0).catch(() => undefined);
    return { done: [...before.done, step, ...rest?.done ?? []], onScreen: rest?.onScreen ?? `The page "${view?.title ?? page?.title}" is in front${view?.where ? `, at: ${view.where}` : ''}.` };
  }
  /**
   * What GPT Live can say to move the page as it talks, after "let's look at" or another turning phrase: a part's name
   * (the page's own named places, sections, annotated parts) or a long name's title alone ("after a move" for
   * "Highlighting: after a move").
   */
  static cues(view: StageView): SpeechCue[] {
    const cues: SpeechCue[] = [];
    // The page's own named places first, then its annotations and headings: the voice is told them in this order.
    const named = view.commands.filter(c => c.name && (c.top || /^(show|page|slide)_/.test(c.id)));
    for (const command of [...named.filter(c => c.id.startsWith('page_')), ...named.filter(c => !c.id.startsWith('page_'))]) {
      cues.push({ run: command.id, label: command.name!, words: cueWords(command.name!), listed: true });
      const title = command.name!.split(/\s*[:—–]\s+|\s+-\s+/).at(-1)!;
      if (title !== command.name && cueWords(title).length >= 2) cues.push({ run: command.id, label: title, words: cueWords(title) });
    }
    return cues;
  }
  /** The page's own step to its next part (a deck's next slide), or the next section. */
  static next(view: StageView) {
    return view.commands.find(c => c.id.startsWith('page_') && /(^|_)(next|forward)(_|$)/.test(c.id))?.id ?? ['next_slide', 'next_section'].find(id => view.commands.some(c => c.id === id));
  }
  /** What the viewer can act on, numbered, and what is on screen: for a one-off action. */
  async digest(): Promise<string> {
    if (!this.tabId) throw new Error('No page is on the stage');
    return this.browser.evaluate<string>(this.tabId, `${SCRIPT}\n;window.__fdcStage.digest()`, 5000);
  }
  /** Carries out a one-off's steps (fast-action.ts) in the page; resolves to what is on screen. */
  async act(actions: PageAction[]): Promise<string> {
    if (!this.tabId) throw new Error('No page is on the stage');
    const started = Date.now();
    let out: string;
    // The steps' own waits (3 s at most, fast-action.ts) and 5 s for the rest.
    const waits = actions.reduce((sum, a) => sum + (a.do === 'wait' ? a.ms : 0), 0);
    try { out = await this.browser.evaluate<string>(this.tabId, `${SCRIPT}\n;window.__fdcStage.perform(${JSON.stringify(actions)})`, 5000 + waits); }
    catch (error) {
      // A click that opened another page of this site ends the old page's script: done, not failed.
      if (!/context was destroyed|navigated|Cannot find context|Execution context/i.test((error as Error).message)) throw error;
      out = 'The page opened another page of this site.';
    }
    this.viewAt = 0;
    this.log({ type: 'stage.acted', tabId: this.tabId, actions, ms: Date.now() - started });
    return out;
  }
  /** Moves the ring to what GPT Live's sentence is about, among what is on screen; resolves to it, or null. */
  async follow(sentence: string): Promise<{ on: string; score: number } | null> {
    if (!this.tabId) return null;
    return this.browser.evaluate(this.tabId, `${SCRIPT}\n;window.__fdcStage.follow(${JSON.stringify(sentence.slice(-400))})`, 2000);
  }
  close() { this.browser.close(); }
}
