// Presenting, end to end: real GPT Live and real Jev, fdc's own page in headless Chrome with a virtual microphone
// (speech from `say`), and the pages it presents in another headless context, reached through a test transport instead of
// Open Claude in Chrome. No coding agent: the test writes the documents and does what the agent would (shows a page, edits
// its controller, reloads it, gives an existing documentation page a controller). Scenarios:
// 1. A new report: a walkthrough asked for (the goal), pointing at a grid's row and column, switching its view, a side
//    question, "keep going".
// 2. A step-through box inside a section: the section, then the box's own steps (offered once it is on screen).
// 3. Voice ended and started again (resumed); then quiet until Standby, and woken by speech.
// 4. The controller edited and the page reloaded mid-session: a new section and a renamed command.
// 5. fdc restarted on the same agent session: the page remembered, voice resumed.
// 6. An existing documentation page (MDN) given a controller, as the agent would, and presented.
// 7. A walkthrough asked for without waiting: it goes on through the sections while the operator listens; a question stops it.
// Every step records what was heard and said, each page move (exact or judged, its steps, how long), and where the page
// is after it; the report goes to .scratch/presenting-e2e/. Spends GPT Live (about $0.05 a minute) and Jev.
//   node scripts/test-presenting.ts [--only 1,2,...]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Page as BrowserPage } from 'playwright';
import { Harness } from '../src/core/bridge.ts';
import { CompanionRegistry } from '../src/core/companions.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { root, synthesize, delay, until } from './test-support.ts';

const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',').map(Number)) : undefined;
const label = `presenting-${Date.now()}`, runRoot = path.join(root, '.runs', label), docs = path.join(runRoot, 'docs'), out = path.join(root, '.scratch', 'presenting-e2e');
fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(out, { recursive: true });
const sessionId = randomUUID(), stageFile = path.join(runRoot, 'stage.json');

// --- The documents -------------------------------------------------------------------------------------------------
const filler = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `<p>${topic}: note ${i + 1}. These notes are here so the page is long enough that moving between its parts needs real scrolling, as a report does.</p>`).join('');
const report = (version: number) => `<!doctype html><html><head><meta charset="utf-8"><title>Outreach report</title><style>
body{font:16px/1.5 -apple-system,sans-serif;max-width:860px;margin:0 auto;padding:24px} section{margin:40px 0}
.grid{display:grid;grid-template-columns:150px repeat(3,1fr);gap:4px} .grid div{padding:8px;background:#f1f0ec;border-radius:6px}
.grid .head{font-weight:600;background:#e3e1da} .grid .camp{display:none;font-size:14px} .split .grid .camp{display:block}
.lit{outline:3px solid #e8590c;outline-offset:2px} #rule .step{display:none;padding:16px;background:#eef3fb;border-radius:8px} #rule .step.on{display:block}
svg rect{fill:#6b8fd6} svg rect.lit{fill:#e8590c;outline:none}</style></head><body>
<h1>Outreach report</h1>
<section id="overview"><h2>Overview</h2><p>384 posts since September 30 brought 360 likes from 281 people and 49 follows. Reply loops did most of the work.</p>${filler('Overview', 10)}</section>
<section id="grid-section"><h2>Projects by approaches</h2><p id="metric-label">Each cell shows total likes.</p>
<div id="grid-wrap"><div id="grid" class="grid">
<div class="head">Project</div><div class="head" data-col="own">Own posts</div><div class="head" data-col="reply">Reply loops</div><div class="head" data-col="outreach">Outreach</div>
<div data-row="fdc">FDC</div><div data-row="fdc" data-col="own" data-total="40" data-lpp="0.6">40</div><div data-row="fdc" data-col="reply" data-total="177" data-lpp="0.99">177</div><div data-row="fdc" data-col="outreach" data-total="9" data-lpp="0.4">9</div>
<div class="camp" data-row="fdc1">FDC wave 1</div><div class="camp" data-row="fdc1" data-col="own">22</div><div class="camp" data-row="fdc1" data-col="reply">101</div><div class="camp" data-row="fdc1" data-col="outreach">5</div>
<div class="camp" data-row="fdc2">FDC wave 2</div><div class="camp" data-row="fdc2" data-col="own">12</div><div class="camp" data-row="fdc2" data-col="reply">58</div><div class="camp" data-row="fdc2" data-col="outreach">3</div>
<div class="camp" data-row="fdc3">FDC wave 3</div><div class="camp" data-row="fdc3" data-col="own">6</div><div class="camp" data-row="fdc3" data-col="reply">18</div><div class="camp" data-row="fdc3" data-col="outreach">1</div>
<div data-row="editor">Editor</div><div data-row="editor" data-col="own" data-total="11" data-lpp="0.9">11</div><div data-row="editor" data-col="reply" data-total="74" data-lpp="1.64">74</div><div data-row="editor" data-col="outreach" data-total="2" data-lpp="0.5">2</div>
<div data-row="nyc">NYC map</div><div data-row="nyc" data-col="own" data-total="20" data-lpp="1.1">20</div><div data-row="nyc" data-col="reply" data-total="6" data-lpp="0.5">6</div><div data-row="nyc" data-col="outreach" data-total="0" data-lpp="0">0</div>
</div></div><p>Reply loops are the replies the hourly loop posts into other people's threads.</p>${filler('Grid', 8)}</section>
<section id="hotspots"><h2>Hotspots</h2><p>Likes per day. Three peaks stand out: October 9 (editor loop replies), October 16 (the reply to OpenAI, 33 likes) and October 17 (FDC loop replies).</p>
<svg id="hotspots-chart" width="600" height="160" viewBox="0 0 600 160"><title>Likes per day</title>${Array.from({ length: 30 }, (_, i) => { const day = i + 1, h = day === 9 ? 90 : day === 16 ? 140 : day === 17 ? 100 : 10 + (i * 7) % 30; return `<rect id="day-${day}" x="${i * 20}" y="${160 - h}" width="16" height="${h}"><title>October ${day}</title></rect>`; }).join('')}</svg>${filler('Hotspots', 8)}</section>
<section id="timing"><h2>Timing rule</h2><p>A rule for when to reply, in three steps.</p>
<div id="rule"><div class="step on" id="rule-1"><b>Step 1 of 3: measure.</b> When a thread appears, note its views and age.</div><div class="step" id="rule-2"><b>Step 2 of 3: look again.</b> Fifteen minutes later, keep it only if it gains a thousand views an hour.</div><div class="step" id="rule-3"><b>Step 3 of 3: reply.</b> Reply while it is under two hours old and still growing.</div></div>${filler('Timing', 8)}</section>
${version >= 2 ? `<section id="follows"><h2>Follows</h2><p>49 follows; 11 can be traced to a reply. Four were people we replied to.</p>${filler('Follows', 6)}</section>` : ''}
<section id="notes"><h2>Data notes</h2><p>Snapshot taken October 31 at 05:42 UTC.</p>${filler('Notes', 6)}</section>
<script src="report.controller.js?v=${version}"></script></body></html>`;
const controller = (version: number) => `// The report's controller (version ${version}): see STAGE.md.
(() => {
  const sections = ${JSON.stringify([['overview', 'Overview'], ['grid-section', 'Projects by approaches'], ['hotspots', 'Hotspots'], ['timing', 'Timing rule'], ...(version >= 2 ? [['follows', 'Follows']] : []), ['notes', 'Data notes']])};
  const state = { metric: 'total', split: false, step: 1, lit: '' };
  const saved = new URLSearchParams(location.hash.slice(1));
  if (saved.get('metric')) state.metric = saved.get('metric'); if (saved.get('split') === '1') state.split = true; if (saved.get('step')) state.step = Number(saved.get('step')) || 1;
  const save = () => history.replaceState(null, '', '#' + new URLSearchParams({ metric: state.metric, split: state.split ? '1' : '0', step: String(state.step), at: current()[0] }));
  const $ = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)];
  const light = (els, what) => { all('.lit').forEach(x => x.classList.remove('lit')); els.forEach(x => x.classList.add('lit')); state.lit = what; };
  const current = () => sections.reduce((best, s) => { const top = document.getElementById(s[0]).getBoundingClientRect().top; return top <= 120 ? s : best; }, sections[0]);
  const show = () => {
    all('#grid [data-total]').forEach(c => { c.textContent = state.metric === 'lpp' ? c.dataset.lpp : c.dataset.total; });
    $('#metric-label').textContent = state.metric === 'lpp' ? 'Each cell shows likes per post.' : 'Each cell shows total likes.';
    document.body.classList.toggle('split', state.split);
    all('#rule .step').forEach((el, i) => el.classList.toggle('on', i + 1 === state.step));
  };
  show();
  if (saved.get('at')) { const el = document.getElementById(saved.get('at')); if (el) el.scrollIntoView(); }
  addEventListener('scroll', () => save(), { passive: true });
  const go = async id => { document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); await new Promise(r => setTimeout(r, 450)); save(); };
  const metricId = ${version >= 2 ? "'show_likes_per_post'" : "'show_lpp'"};
  window.fdcController = {
    about: 'Outreach report: projects by approaches, hotspots, a timing rule',
    commands() { return [
      ...sections.map(([id, name], i) => ({ id: 'go_' + id.replace(/-/g, '_'), say: 'Go to section ' + (i + 1) + ', ' + name, name })),
      { id: 'row_fdc', say: 'Highlight the FDC row in the projects by approaches grid', part: 'grid' },
      { id: 'row_editor', say: 'Highlight the Editor row in the projects by approaches grid', part: 'grid' },
      { id: 'row_nyc', say: 'Highlight the NYC map row in the projects by approaches grid', part: 'grid' },
      { id: 'col_own', say: 'Highlight the own posts column in the projects by approaches grid', part: 'grid' },
      { id: 'col_reply', say: 'Highlight the reply loops column in the projects by approaches grid', part: 'grid' },
      { id: 'col_outreach', say: 'Highlight the outreach column in the projects by approaches grid', part: 'grid' },
      { id: metricId, say: 'Show likes per post in the projects by approaches grid', part: 'grid' },
      { id: 'show_total', say: 'Show total likes in the projects by approaches grid', part: 'grid' },
      { id: 'split_fdc', say: 'Split the FDC row of the grid into its three campaign waves', part: 'grid' },
      { id: 'merge_fdc', say: 'Show FDC as one row of the grid again', part: 'grid' },
      { id: 'peak_oct9', say: 'Highlight the October 9 peak in the hotspots chart (editor loop replies)', part: 'hotspots-chart' },
      { id: 'peak_oct16', say: 'Highlight the October 16 peak in the hotspots chart (the reply to OpenAI)', part: 'hotspots-chart' },
      { id: 'peak_oct17', say: 'Highlight the October 17 peak in the hotspots chart (FDC loop replies)', part: 'hotspots-chart' },
      { id: 'rule_next', say: 'Show the next step of the timing rule', part: 'rule' },
      { id: 'rule_previous', say: 'Show the previous step of the timing rule', part: 'rule' },
      ...[1, 2, 3].map(n => ({ id: 'rule_step_' + n, say: 'Show step ' + n + ' of the timing rule', part: 'rule' })),
    ]; },
    async run(id) {
      const section = sections.find(([s]) => 'go_' + s.replace(/-/g, '_') === id);
      if (section) { await go(section[0]); light([], ''); return 'Section ' + (sections.indexOf(section) + 1) + ' of ' + sections.length + ': ' + section[1] + '.'; }
      const row = /^row_(\\w+)$/.exec(id), col = /^col_(\\w+)$/.exec(id), peak = /^peak_oct(\\d+)$/.exec(id), step = /^rule_step_(\\d)$/.exec(id);
      if (row) { light(all('#grid [data-row="' + row[1] + '"]'), 'row ' + row[1]); return 'The ' + $('#grid [data-row="' + row[1] + '"]').textContent + ' row is highlighted: ' + all('#grid [data-row="' + row[1] + '"]').slice(1).map(c => c.textContent).join(', ') + '.'; }
      if (col) { light(all('#grid [data-col="' + col[1] + '"]'), 'column ' + col[1]); return 'The ' + $('#grid .head[data-col="' + col[1] + '"]').textContent + ' column is highlighted.'; }
      if (id === metricId || id === 'show_total') { state.metric = id === 'show_total' ? 'total' : 'lpp'; show(); save(); return state.metric === 'lpp' ? 'The grid shows likes per post: FDC reply loops 0.99, Editor reply loops 1.64.' : 'The grid shows total likes.'; }
      if (id === 'split_fdc' || id === 'merge_fdc') { state.split = id === 'split_fdc'; show(); save(); return state.split ? 'FDC is split into waves 1 to 3: reply loops 101, 58, 18.' : 'FDC is one row again.'; }
      if (peak) { light([document.getElementById('day-' + peak[1])], 'peak ' + peak[1]); return 'The October ' + peak[1] + ' peak is highlighted.'; }
      if (id === 'rule_next' || id === 'rule_previous' || step) {
        const to = step ? Number(step[1]) : state.step + (id === 'rule_next' ? 1 : -1);
        if (to < 1) return 'Already on the first step';
        if (to > 3) return 'Already on the last step';
        state.step = to; show(); save(); return { text: $('#rule-' + to).textContent, path: ['Timing rule', 'Step ' + to], step: { index: to, total: 3, of: 'step' } };
      }
      throw new Error('No such command: ' + id);
    },
    where() {
      const [id, name] = current(), at = sections.findIndex(s => s[0] === id);
      const inRule = id === 'timing', extra = id === 'grid-section' ? (state.metric === 'lpp' ? ', showing likes per post' : ', showing total likes') + (state.split ? ', FDC split by wave' : '') + (state.lit ? ', ' + state.lit + ' highlighted' : '') : '';
      return { text: name + (inRule ? ', step ' + state.step + ' of 3' : '') + extra, path: inRule ? [name, 'Step ' + state.step] : [name], step: inRule ? { index: state.step, total: 3, of: 'step' } : { index: at + 1, total: sections.length, of: 'section' }, revision: ${version} };
    },
  };
})();
`;
const write = (version: number) => { fs.writeFileSync(path.join(docs, 'report.html'), report(version)); fs.writeFileSync(path.join(docs, 'report.controller.js'), controller(version)); };
write(1);
// The documentation page's controller, as the agent would add it with its browser tools (MDN's Array.prototype.map()).
const DOCS_URL = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map';
const DOCS_CONTROLLER = `(() => {
  const at = id => document.getElementById(id) || document.querySelector('[id="' + id + '"]');
  const parts = [['syntax', 'Syntax'], ['parameters', 'Parameters'], ['return_value', 'Return value'], ['examples', 'Examples'], ['mapping_an_array_of_numbers_to_an_array_of_square_roots', 'First example: square roots']];
  let lit = null, last = 'top';
  const light = el => { if (lit) lit.style.outline = ''; lit = el; if (el) { el.style.outline = '3px solid #e8590c'; el.style.outlineOffset = '4px'; } };
  window.fdcController = {
    about: 'MDN reference page: Array.prototype.map()',
    commands() { return parts.filter(([id]) => at(id)).map(([id, name]) => ({ id: 'show_' + id.slice(0, 40), say: 'Show and highlight the ' + name + ' part of the map() reference', name })); },
    async run(id) {
      const part = parts.find(([p]) => 'show_' + p.slice(0, 40) === id); if (!part) throw new Error('No such command: ' + id);
      const heading = at(part[0]); if (!heading) throw new Error('Missing heading #' + part[0]);
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' }); await new Promise(r => setTimeout(r, 450));
      const block = heading.closest('section') || heading.parentElement; light(block); last = part[1];
      return part[1] + ': ' + (block.innerText || '').replace(/\\s+/g, ' ').slice(0, 240);
    },
    where() { return { text: 'The map() reference, at ' + last, path: ['Array.prototype.map()', last] }; },
  };
})();`;

// --- A static server for the documents --------------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const file = path.join(docs, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
  if (!file.startsWith(docs) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(fs.readFileSync(file));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const docsBase = `http://127.0.0.1:${(server.address() as any).port}`;

// --- The browser: fdc's page with a virtual microphone; the documents in their own context ----------------------------
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = await browser.newContext({ viewport: { width: 1280, height: 800 } });
/** The stage's browser tools, over Playwright tabs instead of Open Claude in Chrome (the same calls Stage makes). */
class TestBrowser {
  tabs_ = new Map<number, BrowserPage>(); next = 4100;
  add(page: BrowserPage) { const id = this.next++; this.tabs_.set(id, page); return id; }
  async evaluate(tabId: number, expression: string) { const page = this.tabs_.get(tabId); if (!page || page.isClosed()) throw new Error(`Tab ${tabId} is not in the MCP group.`); return page.evaluate(expression); }
  async call(tool: string, args: Record<string, unknown> = {}) { if (tool === 'set_tab_focus') { await this.tabs_.get(Number(args.tabId))?.bringToFront(); return 'ok'; } if (tool === 'tabs_context_mcp') return JSON.stringify({ availableTabs: await this.tabs() }); throw new Error(`${tool} is not available in the test browser`); }
  async tabs() { return Promise.all([...this.tabs_].filter(([, p]) => !p.isClosed()).map(async ([tabId, p]) => ({ tabId, title: await p.title(), url: p.url() }))); }
  close() {}
}
const stageBrowser = new TestBrowser();
const reportPage = await pages.newPage();
await reportPage.goto(`${docsBase}/report.html`);
const reportTab = stageBrowser.add(reportPage);

const fixtures = new Map<string, ReturnType<typeof synthesize>>();
const line = (text: string) => { const key = `presenting-${Buffer.from(text).toString('base64url').slice(0, 40)}`; if (!fixtures.has(text)) fixtures.set(text, synthesize(key, text)); return fixtures.get(text)!; };

let harness: Harness;
const runDir = (n: number) => path.join(runRoot, `fdc-${n}`);
async function startHarness(n: number) {
  const h = new Harness({ agent: claude, root, runDir: runDir(n), cwd: path.join(runRoot, 'project'), sessionId, apiKey: process.env.OPENAI_API_KEY!, jevKey: process.env.TYPESAFE_API_KEY, stageFile, tuning: { standbyAfterMs: 20000 } });
  fs.mkdirSync(path.join(runRoot, 'project'), { recursive: true });
  h.companions = new CompanionRegistry(path.join(runRoot, 'companions'));
  h.stage.browser = stageBrowser as any;
  await h.start(); h.agentReady = true;
  return h;
}
harness = await startHarness(1);
// The run's events, read as they are appended (the log also holds every audio packet: only the rest is kept).
const seen = new Map<string, { offset: number; rest: string; list: any[] }>();
const events = () => {
  const file = path.join(harness.runDir, 'events.jsonl'), log = seen.get(file) ?? { offset: 0, rest: '', list: [] };
  seen.set(file, log);
  if (!fs.existsSync(file)) return log.list;
  const size = fs.statSync(file).size;
  if (size > log.offset) {
    const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(size - log.offset);
    fs.readSync(fd, buffer, 0, buffer.length, log.offset); fs.closeSync(fd); log.offset = size;
    const lines = (log.rest + buffer.toString('utf8')).split('\n'); log.rest = lines.pop() ?? '';
    for (const l of lines) if (l && !l.includes('"audio.packet"') && !l.includes('"audio_level"') && !l.includes('"audio.transport"')) { try { log.list.push(JSON.parse(l)); } catch {} }
  }
  return log.list;
};

const voiceContext = await browser.newContext({ permissions: ['microphone'] });
let voicePage!: BrowserPage;
async function openVoicePage() {
  voicePage = await voiceContext.newPage();
  await voicePage.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
      const destination = audio.createMediaStreamDestination();
      (window as any).say = (base64: string) => new Promise<void>(resolve => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), samples = new Int16Array(bytes.buffer);
        const buffer = audio.createBuffer(1, samples.length, 24000); buffer.getChannelData(0).set(Float32Array.from(samples, x => x / 32768));
        const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination); source.onended = () => resolve(); source.start();
      });
      return destination.stream;
    };
  });
  await voicePage.goto(harness.browserUrl);
  for (let i = 0; i < 200 && !await voicePage.locator('#start').isEnabled(); i++) await delay(100);
}
async function startVoice() {
  const before = events().filter(e => e.type === 'voice.started').length;
  await voicePage.locator('#start').click();
  const clicked = Date.now();
  await until(() => events().filter(e => e.type === 'voice.started').length > before, { label: 'voice started', timeout: 40000 });
  await quiet(20000, 2500, clicked);
}
/** Waits until GPT Live has answered since `since` (a wake takes a few seconds) and then been quiet for `ms` (or `max`). */
async function quiet(max = 30000, ms = 2500, since = Date.now()) {
  const started = Date.now();
  await delay(1500);
  while (Date.now() - started < max) {
    const recent = events().filter(e => (e.type === 'session.output_transcript.delta' || e.type === 'stage.ran' || e.type === 'page.judged') && e.at >= since);
    const last = recent.at(-1)?.at ?? 0;
    if (recent.length && Date.now() - last > ms && Date.now() - started > 4000) return;
    await delay(250);
  }
}
/** Shows a page as the agent would: its tab becomes the stage, as an observed browser tool call makes it. */
function show(tabId: number) { harness.stage.observe({ tool: 'mcp__open-claude-in-chrome-hybrid__navigate', input: { tabId, url: '' }, response: '' }); }

// --- Steps ---------------------------------------------------------------------------------------------------------------
interface Step { scenario: number; said: string; heard?: string; voice?: string; moves: any[]; judged: any[]; announced?: string[]; unmoved?: string[]; expect?: string; passed?: boolean; where?: string; screenshot?: string; notes?: string[]; ms: number }
const steps: Step[] = [];
const ANNOUNCES = /\b(let'?s (look|go|turn|move|jump|head|start)|here'?s|here is|switching|switch(ed)? (it|the|to)|getting you|bring(ing)? (it|you|up)|pull(ing)? (it|that) up|take you|taking you|moving (it|you|to|over)|highlight|point(ing)? (it|out|to)|you can see|on screen|now (we're|you're) (at|on)|showing)\b/i;
async function say(scenario: number, text: string, expect?: { what: string; check: (step: Step) => boolean }, { wait = 30000 } = {}) {
  if (only && !only.has(scenario)) return;
  const mark = events().length, at = Date.now();
  await voicePage.evaluate(pcm => (window as any).say(pcm), line(text).pcm.toString('base64'));
  await quiet(wait, 2500, at);
  const all = events().slice(mark), text_ = (type: string) => all.filter(e => e.type === type).map(e => e.delta ?? '').join('').replace(/\s+/g, ' ').trim();
  const voiceSentences = (text_('session.output_transcript.delta').match(/[^.!?]+[.!?]+/g) ?? []).map(s => s.trim());
  const moves = all.filter(e => e.type === 'stage.cue').map(e => ({ at: e.at - at, run: e.run, steps: e.steps, label: e.label, judged: !!e.judged, ms: e.ms }));
  const step: Step = { scenario, said: text, heard: text_('session.input_transcript.delta'), voice: text_('session.output_transcript.delta'), moves,
    judged: all.filter(e => e.type === 'page.judged').map(e => ({ trigger: e.trigger, said: e.said, command: e.command, more: e.more })),
    announced: voiceSentences.filter(s => ANNOUNCES.test(s)), ms: Date.now() - at,
    notes: all.filter(e => ['stage.cue_instead', 'stage.cue_failed', 'stage.cue_nothing', 'stage.failed', 'goal.set', 'voice.standby', 'voice.woke', 'stage.viewer_moved', 'jev.error', 'stage.error'].includes(e.type)).map(e => `${e.type} ${JSON.stringify({ ...e, at: undefined, type: undefined }).slice(0, 200)}`) };
  try { const here = await harness.stage.here(); step.where = here?.where; } catch (error) { step.where = `(unreadable: ${(error as Error).message.slice(0, 80)})`; }
  const file = `step-${steps.length + 1}.png`;
  const tab = stageBrowser.tabs_.get(harness.stage.tabId ?? 0);
  if (tab) { await tab.screenshot({ path: path.join(out, file) }).catch(() => {}); step.screenshot = file; }
  if (expect) { step.expect = expect.what; step.passed = expect.check(step); }
  steps.push(step);
  console.log(`\n[${scenario}] "${text}"\n  heard: ${step.heard}\n  voice: ${step.voice?.slice(0, 300)}\n  moves: ${moves.map(m => `${m.steps?.join('>') ?? m.run}${m.judged ? '' : ' (named)'} ${m.ms}ms`).join(', ') || '(none)'}\n  where: ${step.where}${step.expect ? `\n  ${step.passed ? 'PASS' : 'FAIL'}: ${step.expect}` : ''}`);
}
const ran = (step: Step, ...ids: string[]) => step.moves.some(m => ids.some(id => (m.steps ?? [m.run]).some((s: string) => s === id || s?.startsWith(id))));
const mark = (scenario: number, note: string, passed: boolean) => { steps.push({ scenario, said: `(${note})`, moves: [], judged: [], expect: note, passed, ms: 0 }); console.log(`\n[${scenario}] ${passed ? 'PASS' : 'FAIL'}: ${note}`); };

try {
  await openVoicePage();
  show(reportTab);
  await startVoice();

  // 1. A new report: a walkthrough asked for, pointing, switching the view, a side question, keep going.
  await say(1, 'Hi. Please walk me through this report, section by section, starting with the projects by approaches grid.', { what: 'the page goes to the grid; the goal is kept', check: s => ran(s, 'page_go_grid_section') && !!harness.voiceSessions.goal });
  await say(1, 'Which approach worked best for FDC? Point it out for me.', { what: 'a row or column of the grid is highlighted', check: s => ran(s, 'page_row_', 'page_col_') });
  await say(1, 'Can you switch the grid to likes per post?', { what: 'the grid shows likes per post', check: s => ran(s, 'page_show_lpp') });
  await say(1, 'Wait, what is a reply loop, exactly?', { what: 'a side question keeps the goal', check: () => !!harness.voiceSessions.goal });
  await say(1, "Okay, got it. Let's keep going.", { what: 'the walkthrough goes on: the page moves to another section', check: s => s.moves.length > 0 });

  // 2. A step-through box inside a section: the section, then the box's own steps.
  await say(2, 'Now take me to the timing rule and walk me through its steps one at a time.', { what: 'the timing rule (its first step shows with it; with the walk on, the next steps follow)', check: s => ran(s, 'page_go_timing', 'goto_timing') });
  await say(2, 'Okay, what is the next step?', { what: 'the next step of the rule', check: s => ran(s, 'page_rule_') });

  // 3. Voice ended and started again; then Standby and a wake.
  if (!only || only.has(3)) {
    await harness.live?.close('operator ended voice'); await delay(3000);
    await startVoice();
    await say(3, 'Where were we? Take me back to the hotspots chart.', { what: 'after voice restarted, the page moves to the hotspots', check: s => ran(s, 'page_go_hotspots', 'goto_hotspots', 'page_peak_') });
    const standbys = events().filter(e => e.type === 'voice.standby').length;
    await until(() => events().filter(e => e.type === 'voice.standby').length > standbys, { label: 'Standby', timeout: 70000 }).catch(() => {});
    mark(3, 'voice went on Standby after the quiet', events().filter(e => e.type === 'voice.standby').length > standbys);
    await say(3, 'Show me the peak on October sixteenth.', { what: 'woken by speech, the page highlights the October 16 peak', check: s => ran(s, 'page_peak_oct16') }, { wait: 35000 });
  }

  // 4. The controller edited and the page reloaded mid-session, as the agent would after an edit.
  if (!only || only.has(4)) {
    write(2);
    await reportPage.reload(); await delay(1500);
    harness.stage.observe(undefined, true);
    await delay(3500);
    const restored = await harness.stage.here().catch(() => undefined);
    mark(4, `after the reload the page is where it was (${restored?.where ?? 'unreadable'})`, /Hotspots/.test(restored?.where ?? ''));
    const view = await harness.stage.describe(0);
    mark(4, 'the new section and the renamed command are offered after the reload', !!view?.commands.some(c => c.id === 'page_go_follows'));
    await say(4, 'What does the new follows section say?', { what: 'the new section is shown', check: s => ran(s, 'page_go_follows') });
    await say(4, 'Go back to the grid and show likes per post there.', { what: 'the renamed command runs (after the grid)', check: s => ran(s, 'page_show_likes_per_post') });
  }

  // 5. fdc restarted on the same agent session: the page remembered, voice resumed.
  if (!only || only.has(5)) {
    await quiet(15000, 3000); await harness.live?.close('operator ended voice'); await delay(2000);
    await harness.close(); await voicePage.close();
    harness = await startHarness(2);
    mark(5, 'after the restart, the stage is the same page', harness.stage.tabId === reportTab);
    await openVoicePage(); await startVoice();
    await say(5, 'Take me down to the data notes at the bottom.', { what: 'after fdc restarted, the page moves to the data notes', check: s => ran(s, 'page_go_notes') });
  }

  // 6. An existing documentation page given a controller, as the agent would, and presented.
  if (!only || only.has(6)) {
    const docsPage = await pages.newPage();
    await docsPage.goto(DOCS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); await delay(2000);
    await docsPage.evaluate(DOCS_CONTROLLER);
    const docsTab = stageBrowser.add(docsPage);
    show(docsTab); await delay(3000);
    await say(6, "I opened the reference for map. Walk me through how it works, starting with its syntax.", { what: 'the docs page goes to its syntax', check: s => ran(s, 'page_show_syntax', 'goto_syntax') });
    await say(6, 'What does it return?', { what: 'the return value is on screen (shown now, or already)', check: s => ran(s, 'page_show_return_value', 'goto_return_value') || /Return value/.test(s.where ?? '') });
    await say(6, 'Show me an example.', { what: 'an example is shown', check: s => ran(s, 'page_show_examples', 'page_show_mapping', 'goto_examples', 'goto_mapping') });
  }
  // 7. A walkthrough the operator asked for goes on while they listen, and a question stops it.
  if (!only || only.has(7)) {
    show(reportTab); await delay(2500);
    const before = events().length;
    await say(7, "Walk me through the whole report from the top, section by section. Don't wait for me.", { what: 'the walkthrough starts: the page moves, and the goal is a walkthrough', check: s => s.moves.length > 0 && !!harness.voiceSessions.goal?.walk }, { wait: 15000 });
    await delay(60000);
    const walked = events().slice(before), sections = new Set(walked.filter(e => e.type === 'stage.cue').flatMap(e => e.steps ?? [e.run]).filter((id: string) => /^(page_go_|goto_)/.test(id)));
    mark(7, `without a word from the operator, the walk went on through ${sections.size} sections (${[...sections].join(', ')}), told to go on ${walked.filter(e => e.type === 'goal.walk_on').length} times`, sections.size >= 3);
    const mark7 = events().length;
    await say(7, 'Hold on, what did the grid show again?', { what: 'a question is answered', check: s => !!s.voice });
    await delay(15000);
    mark(7, 'after the question, the walk waits for the operator (no cue to go on unless the voice moved the page itself)', !events().slice(mark7).some(e => e.type === 'goal.walk_on') || events().slice(mark7).some(e => e.type === 'stage.cue'));
  }
} catch (error) { console.error('\nERROR', error); steps.push({ scenario: 0, said: `(error: ${(error as Error).message})`, moves: [], judged: [], passed: false, expect: 'no error', ms: 0 }); }
finally {
  await harness.live?.close('test over').catch(() => {}); await delay(1500);
  const billed = [runDir(1), runDir(2)].flatMap(dir => fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(l => l.includes('"bridge.closed"')).map(l => JSON.parse(l)) : []).reduce((n, e) => n + (e.usageSeconds ?? 0), 0);
  const jevCalls = [runDir(1), runDir(2)].map(dir => path.join(dir, 'jev.jsonl')).filter(f => fs.existsSync(f)).reduce((n, f) => n + fs.readFileSync(f, 'utf8').trim().split('\n').length, 0);
  await harness.close().catch(() => {}); await browser.close(); server.close();
  const summary = { label, runRoot, billedSeconds: billed, dollars: +(billed * .05 / 60).toFixed(3), jevCalls, passed: steps.filter(s => s.passed === true).length, failed: steps.filter(s => s.passed === false).length, steps };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(summary, null, 1));
  console.log(`\n${summary.passed} passed, ${summary.failed} failed; billed ${billed} s of voice (about $${summary.dollars}), ${jevCalls} Jev calls; ${runRoot}`);
  process.exit(0);
}
