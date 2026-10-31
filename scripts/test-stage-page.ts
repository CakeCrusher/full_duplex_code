// The stage script (src/core/stage-page.js) in real Chrome, headless: where the viewer is, in words and in structure (a
// controller's object, its counting text, or the page's own sections); a table's rows and columns ringed; the viewer's
// own scrolling told apart from fdc's moves; a part's own controls offered once it is on screen; and a step on the way
// that doesn't wait for its scroll to glide. No API spending.
//   node scripts/test-stage-page.ts
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SCRIPT = fs.readFileSync(new URL('../src/core/stage-page.js', import.meta.url), 'utf8').replace('__FDC_STAGE_VERSION__', 'test');
const filler = (n: number) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i + 1} with enough words to count as a paragraph of the page.</p>`).join('');
const REPORT = `<!doctype html><title>Audience report</title><body style="font:16px sans-serif;max-width:800px;margin:auto">
<h1>Audience report</h1>
<h2 id="map">The map</h2>${filler(24)}
<h2 id="grid">Projects by approaches</h2><p>Each cell is posts and likes per post.</p>
<table><caption>Projects by approaches</caption><thead><tr><th>Project</th><th>Own posts</th><th>Reply loops</th><th>Outreach</th></tr></thead>
<tbody><tr><td>FDC</td><td>12</td><td>231</td><td>4</td></tr><tr><td>Editor</td><td>3</td><td>88</td><td>1</td></tr><tr><td>NYC map</td><td>5</td><td>9</td><td>0</td></tr></tbody></table>${filler(12)}
<h2 id="waves">FDC waves</h2><div id="waves-chart" style="height:300px;background:#eef">waves chart</div>${filler(20)}
<h2 id="notes">Data notes</h2>${filler(10)}</body>`;
// A controller with structured where(), and a part's own controls (part: 'waves-chart').
const CONTROLLER = `<script>let split = false, wave = 1; window.fdcController = {
  about: 'Audience report', commands() { return [
    { id: 'go_waves', say: 'Go to the FDC waves', name: 'FDC waves' },
    { id: 'split_campaigns', say: 'Split the FDC row into its campaigns', part: 'waves-chart' },
    { id: 'next_wave', say: 'Show the next wave', part: 'waves-chart' } ]; },
  async run(id) { if (id === 'go_waves') { document.getElementById('waves').scrollIntoView(); return 'FDC waves'; }
    if (id === 'split_campaigns') { split = true; return { text: 'FDC split into its campaigns', path: ['FDC waves'], step: { index: wave, total: 4, of: 'wave' } }; }
    if (id === 'next_wave') { if (wave === 4) return 'Already on the last wave'; wave++; return 'Wave ' + wave + ' of 4'; } },
  where() { return { text: 'FDC waves, wave ' + wave + (split ? ', split by campaign' : ''), path: ['FDC waves', 'Wave ' + wave], step: { index: wave, total: 4, of: 'wave' }, revision: 3 }; } };</script>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  const stage = <T>(expression: string) => page.evaluate(`${SCRIPT}\n;${expression}`) as Promise<T>;
  const ids = async () => (await stage<any>('window.__fdcStage.describe()')).commands.map((c: any) => c.id) as string[];

  // 1. Without a controller: where in words, and the section in view among the page's sections.
  await page.setContent(REPORT);
  let view = await stage<any>('window.__fdcStage.describe()');
  assert.deepEqual(view.focus, { path: ['The map'], step: { index: 1, total: 4, of: 'section' } }, 'the section in view, counted');
  assert.equal(view.viewerAt, 0);
  assert.ok(!view.commands.some((c: any) => c.id.startsWith('row_')), 'no table on screen, no row commands');

  // 2. The table on screen: each row and column can be ringed; a column's ring spans its cells.
  await stage('window.__fdcStage.run("goto_grid")');
  const listed = await ids();
  for (const id of ['row_fdc', 'row_editor', 'row_nyc_map', 'column_project', 'column_own_posts', 'column_reply_loops', 'column_outreach']) assert.ok(listed.includes(id), `offers ${id}`);
  const said = await stage<string>('window.__fdcStage.run("column_reply_loops")');
  assert.match(said, /^column "Reply loops" in the table "Projects by approaches": 231, 88, 9$/);
  await page.waitForTimeout(400); // the ring glides to its place
  const ring = await page.evaluate(() => { const r = document.getElementById('__fdc_ring')!.getBoundingClientRect(), cells = [...document.querySelectorAll('tr')].map(tr => (tr as HTMLTableRowElement).cells[2].getBoundingClientRect()); return { ring: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, left: Math.min(...cells.map(c => c.left)), right: Math.max(...cells.map(c => c.right)), top: Math.min(...cells.map(c => c.top)), bottom: Math.max(...cells.map(c => c.bottom)) }; });
  assert.ok(Math.abs(ring.ring.left - (ring.left - 4)) < 2 && Math.abs(ring.ring.right - (ring.right + 4)) < 2 && Math.abs(ring.ring.top - (ring.top - 4)) < 2 && Math.abs(ring.ring.bottom - (ring.bottom + 4)) < 2, `the ring spans the column: ${JSON.stringify(ring)}`);
  assert.match(await stage<string>('window.__fdcStage.run("row_editor")'), /Editor/);
  view = await stage<any>('window.__fdcStage.describe()');
  assert.deepEqual(view.focus.path, ['Projects by approaches']);

  // 3. fdc's own moves aren't the viewer's; their scrolling is, and here() says so without commands or parts.
  assert.equal((await stage<any>('window.__fdcStage.here()')).viewerAt, 0, "fdc's moves aren't the viewer's");
  await page.mouse.move(500, 300); await page.mouse.wheel(0, 900); await page.waitForTimeout(400);
  const here = await stage<any>('window.__fdcStage.here()');
  assert.ok(here.viewerAt > 0 && Date.now() - here.viewerAt < 5000, 'their own scroll is seen');
  assert.deepEqual(Object.keys(here).sort(), ['focus', 'url', 'viewerAt', 'where']);

  // 4. A step on the way lands without waiting for its scroll to glide; the last one settles.
  await stage('window.scrollTo(0, 0)');
  let started = Date.now();
  await stage('window.__fdcStage.run("goto_notes", { fast: true })');
  const fast = Date.now() - started;
  await stage('window.scrollTo(0, 0)');
  started = Date.now();
  await stage('window.__fdcStage.run("goto_waves")');
  const settled = Date.now() - started;
  assert.ok(fast < 250, `a step on the way took ${fast} ms`);
  assert.ok(settled > fast, `the last step settles (${settled} ms against ${fast} ms)`);

  // 5. With a controller: where() in structure, and a part's own controls once that part is on screen.
  await page.setContent(REPORT + CONTROLLER);
  await page.evaluate(() => window.scrollTo(0, 0));
  view = await stage<any>('window.__fdcStage.describe()');
  assert.deepEqual(view.focus, { path: ['FDC waves', 'Wave 1'], step: { index: 1, total: 4, of: 'wave' }, revision: '3' });
  assert.ok(!view.commands.some((c: any) => c.id === 'page_split_campaigns'), "the chart's own control waits until it is on screen");
  await stage('window.__fdcStage.run("page_go_waves")');
  assert.ok((await ids()).includes('page_split_campaigns'), 'once the chart is on screen, its control is offered');
  assert.equal((await stage<any>('window.__fdcStage.describe()')).commands.find((c: any) => c.id === 'page_split_campaigns').part, true, "marked as the part's own, for the voice to hear of");
  assert.equal(await stage<string>('window.__fdcStage.run("page_split_campaigns")'), 'FDC split into its campaigns', "a structured answer's text is what the voice hears");
  assert.equal((await stage<any>('window.__fdcStage.here()')).where, 'FDC waves, wave 1, split by campaign');
  for (let i = 0; i < 3; i++) await stage('window.__fdcStage.run("page_next_wave")');
  assert.deepEqual((await stage<any>('window.__fdcStage.here()')).focus.step, { index: 4, total: 4, of: 'wave' });
  assert.equal(await stage<string>('window.__fdcStage.run("page_next_wave")'), 'Already on the last wave');
  assert.equal(await stage<boolean>('window.__fdcStage.limit'), true, 'a limit is an answer, not a move');

  // 6. A controller whose where() counts in words gives the step; one that throws leaves fdc's own description.
  await page.setContent(REPORT + `<script>window.fdcController = { commands() { return []; }, async run() {}, where() { return 'Stage 3 of 5: DNS lookup'; } };</script>`);
  assert.deepEqual((await stage<any>('window.__fdcStage.here()')).focus, { step: { index: 3, total: 5, of: 'stage' } });
  await page.setContent(REPORT + `<script>window.fdcController = { commands() { return []; }, async run() {}, where() { throw new Error('broken'); } };</script>`);
  assert.match((await stage<any>('window.__fdcStage.describe()')).where, /^heading|^paragraph/, "a broken where() doesn't break reading the page");
  console.log('Stage script checks passed: structured where, table rows and columns, the viewer\'s own moves, a part\'s controls once on screen, fast steps. No API spending.');
} finally { await browser.close(); }
