// The stage: the page the coding agent last showed the operator in the browser. fdc runs the
// stage script there (stage-page.js) through its own connection to Open Claude in Chrome, so
// the gate can move the page, highlight and read it without the agent.
import fs from 'node:fs';
import type { Observation } from './adapter.ts';
import { Browser } from './browser.ts';

const SCRIPT = fs.readFileSync(new URL('./stage-page.js', import.meta.url), 'utf8');
/** Browser tools that show a tab to the operator: the tab they act on becomes the stage. */
const SHOWS = /chrome[\w-]*__(navigate|set_tab_focus|tabs_create_mcp|execute_code)$/;

export interface StageCommand { id: string; say: string }
export interface StageCue { say: string; run: string }
export interface StageView { tabId: number; title: string; url: string; about: string | null; where: string; commands: StageCommand[]; cues: StageCue[] }
export interface StageRun { done: StageCommand[]; onScreen: string }

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
    const said = await this.browser.evaluate<string[]>(tabId, `${SCRIPT}\n;(async () => { const said = []; for (const id of ${JSON.stringify(ids)}) said.push(await window.__fdcStage.run(id)); return said; })()`, 15000);
    this.viewAt = 0;
    const done = ids.map(id => view?.commands.find(c => c.id === id) ?? { id, say: id });
    this.log({ type: 'stage.ran', tabId, ids, ms: Date.now() - started });
    return { done, onScreen: said.at(-1) ?? '' };
  }
  close() { this.browser.close(); }
}
