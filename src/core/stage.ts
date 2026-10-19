// The stage: the page the coding agent last showed the operator in the browser. fdc runs the
// stage script there (stage-page.js) through its own connection to Open Claude in Chrome, so
// the gate can move the page, highlight and read it without the agent.
import fs from 'node:fs';
import type { Observation } from './adapter.ts';
import { Browser } from './browser.ts';

const SCRIPT = fs.readFileSync(new URL('./stage-page.js', import.meta.url), 'utf8');
/** Browser tools that show a tab to the operator: the tab they act on becomes the stage. */
const SHOWS = /chrome[\w-]*__(navigate|set_tab_focus|tabs_create_mcp|execute_code)$/;

export interface StageCommand { id: string; say: string; /** The element id it lands on, when it has one. */ anchor?: string }
export interface StageCue { say: string; run: string }
export interface StageView { tabId: number; title: string; url: string; about: string | null; where: string; commands: StageCommand[]; cues: StageCue[] }
export interface StageRun { done: StageCommand[]; onScreen: string }
/** A page command threw: the page's controller is broken, or was asked something it can't do. */
export class StageError extends Error {
  done: StageCommand[]; onScreen: string; failed: StageCommand;
  constructor(message: string, done: StageCommand[], onScreen: string, failed: StageCommand) { super(message); this.done = done; this.onScreen = onScreen; this.failed = failed; }
}

export class Stage {
  browser: Browser;
  log: (event: Record<string, unknown>) => void;
  tabId?: number;
  view?: StageView; viewAt = 0;
  constructor({ log, browser = new Browser() }: { log: (event: Record<string, unknown>) => void; browser?: Browser }) { this.log = log; this.browser = browser; }
  /** The agent's own browser tool calls say which tab it showed the operator. */
  observe({ raw }: Pick<Observation, 'raw'>) {
    if (raw?.hook_event_name !== 'PostToolUse' || !SHOWS.test(String(raw.tool_name ?? ''))) return;
    const input = raw.tool_input ?? {}, response = typeof raw.tool_response === 'string' ? raw.tool_response : JSON.stringify(raw.tool_response ?? '');
    const created = /Tab ID: (\d+)/.exec(response)?.[1];
    const named = typeof input.tabId === 'number' ? input.tabId : [...String(input.code ?? '').matchAll(/(?:navigate|set_tab_focus)\(\s*\{[^}]*?tabId:\s*(\d+)/g)].at(-1)?.[1];
    const tabId = Number(created ?? named);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    if (tabId !== this.tabId) this.log({ type: 'stage.tab', tabId, by: raw.tool_name });
    this.tabId = tabId; this.view = undefined;
  }
  /** What the stage shows and the commands it offers; undefined without a stage. */
  async describe(maxAgeMs = 2000): Promise<StageView | undefined> {
    const tabId = this.tabId;
    if (!tabId) return;
    if (this.view?.tabId === tabId && Date.now() - this.viewAt < maxAgeMs) return this.view;
    const started = Date.now();
    const view = await this.browser.evaluate<Omit<StageView, 'tabId'>>(tabId, `${SCRIPT}\n;window.__fdcStage.describe()`, 3000);
    this.view = { ...view, tabId }; this.viewAt = Date.now();
    this.log({ type: 'stage.described', tabId, url: view.url, commands: view.commands.length, cues: view.cues.length, ms: Date.now() - started });
    return this.view;
  }
  /** Runs commands in order, each finished before the next; resolves to what is on screen after. */
  async run(ids: string[]): Promise<StageRun> {
    const tabId = this.tabId, view = this.view;
    if (!tabId) throw new Error('No page is on the stage');
    const started = Date.now();
    // Steps run in order; one that throws stops the rest, and what ran before it is still reported.
    const { said, error } = await this.browser.evaluate<{ said: string[]; error?: string }>(tabId, `${SCRIPT}\n;(async () => { const said = []; for (const id of ${JSON.stringify(ids)}) { try { said.push(await window.__fdcStage.run(id)); } catch (e) { return { said, error: String(e && e.message || e) }; } } return { said }; })()`, 15000);
    this.viewAt = 0;
    const command = (id: string) => view?.commands.find(c => c.id === id) ?? { id, say: id };
    const done = ids.slice(0, said.length).map(command);
    this.log({ type: error ? 'stage.failed' : 'stage.ran', tabId, ids, ran: said.length, error, ms: Date.now() - started });
    if (error) throw new StageError(error, done, said.at(-1) ?? '', command(ids[said.length]));
    return { done, onScreen: said.at(-1) ?? '' };
  }
  close() { this.browser.close(); }
}
