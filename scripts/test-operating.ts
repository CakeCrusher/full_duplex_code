// The voice works a page for the operator, end to end: real GPT Live and real Jev, fdc's own page in headless Chrome with
// a virtual microphone (speech from `say`), and an order page in another headless context, reached through a test
// transport instead of Open Claude in Chrome. No coding agent: the test writes the page as an agent would (one command
// per action, STAGE.md) and takes the requests fdc would deliver. The operator orders by voice:
// 1. A drink, then three settings in one breath, then "add it" and another drink: each done on the page, in order.
// 2. A question about a drink: answered, nothing changes.
// 3. Told to take the order itself and pass nothing on, a setting and "place the order": done, nothing delivered.
// 4. "Tell Claude to add a caramel option": that goes.
// Every step records what was heard and said, the commands that ran (and how long after the operator stopped), the
// page's own state, and what was delivered; the report goes to .scratch/operating-e2e/. Spends GPT Live (about $0.05 a
// minute) and Jev.
//   node scripts/test-operating.ts
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Page as BrowserPage } from 'playwright';
import { Harness } from '../src/core/bridge.ts';
import { CompanionRegistry } from '../src/core/companions.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { root, synthesize, delay, until } from './test-support.ts';

const label = `operating-${Date.now()}`, runRoot = path.join(root, '.runs', label), docs = path.join(runRoot, 'docs'), out = path.join(root, '.scratch', 'operating-e2e');
fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(out, { recursive: true });

// --- The page: a small order board, with a controller that has a command for everything the voice may have to do ------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Corner Café · Order board</title><style>
body{font:16px/1.5 -apple-system,sans-serif;max-width:900px;margin:0 auto;padding:24px} section{margin:28px 0} .drinks{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.drink{padding:10px;border:2px solid #ddd;border-radius:8px} .drink.on{border-color:#e8590c} .opt{display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border:1px solid #ccc;border-radius:12px} .opt.on{background:#e8590c;color:#fff}
#ticket li{margin:4px 0}</style></head><body>
<h1>Corner Café</h1>
<section id="menu"><h2>Menu</h2><div class="drinks" id="drinks"></div></section>
<section id="cup"><h2>Your cup</h2><div id="editor"></div></section>
<section id="order"><h2>Your order</h2><ul id="ticket"></ul><p id="status"></p></section>
<script>
const MENU = [['latte', 'Latte', 'Espresso with a lot of steamed milk. Mild.', 4.5], ['cappuccino', 'Cappuccino', 'Espresso, milk and thick foam.', 4.25], ['mocha', 'Mocha', 'A latte with chocolate. Sweet.', 5], ['americano', 'Americano', 'Espresso and hot water. Black and bold.', 3.25], ['espresso', 'Espresso', 'A small, strong shot of coffee.', 2.75], ['cold_brew', 'Cold brew', 'Coffee steeped cold, over ice.', 4.5]];
const OPTIONS = { size: ['Regular', 'Large'], milk: ['Whole', 'Oat', 'None'], sweet: ['None', 'Sugar', 'Vanilla'], temp: ['Hot', 'Iced'], caffeine: ['Regular', 'Decaf'] };
const fresh = () => ({ selected: null, size: 'Regular', milk: 'Whole', sweet: 'None', temp: 'Hot', caffeine: 'Regular', items: [], placed: false });
let state; try { state = { ...fresh(), ...JSON.parse(localStorage.getItem('corner-cafe') || '{}') }; } catch { state = fresh(); }
const name = id => (MENU.find(d => d[0] === id) || [])[1];
const cup = () => state.selected ? state.size + ' ' + state.temp.toLowerCase() + ' ' + name(state.selected) + ', ' + (state.milk === 'None' ? 'no milk' : state.milk.toLowerCase() + ' milk') + ', ' + (state.sweet === 'None' ? 'no sweetener' : state.sweet.toLowerCase()) + ', ' + state.caffeine.toLowerCase() : 'no drink chosen';
function render() {
  document.getElementById('drinks').innerHTML = MENU.map(d => '<div class="drink' + (state.selected === d[0] ? ' on' : '') + '"><h3>' + d[1] + '</h3><p>' + d[2] + ' $' + d[3].toFixed(2) + '</p></div>').join('');
  document.getElementById('editor').innerHTML = state.selected ? '<p><b>' + name(state.selected) + '</b></p>' + Object.entries(OPTIONS).map(([k, vs]) => '<p>' + k + ': ' + vs.map(v => '<span class="opt' + (state[k] === v ? ' on' : '') + '">' + v + '</span>').join('') + '</p>').join('') : '<p>Choose a drink to make it yours.</p>';
  document.getElementById('ticket').innerHTML = state.items.map(i => '<li>' + i + '</li>').join('') || '<li>Nothing yet.</li>';
  document.getElementById('status').textContent = state.placed ? 'Order placed.' : 'Still choosing.';
  localStorage.setItem('corner-cafe', JSON.stringify(state));
}
window.cafe = { get state() { return state; }, render, cup, name, MENU, OPTIONS, set(next) { Object.assign(state, next); render(); } };
render();
</script><script src="cafe.controller.js?v=1"></script></body></html>`;
const CONTROLLER = `// The order board's controller: a command for everything the voice may have to show or do (STAGE.md).
(() => {
  const c = window.cafe, at = { part: 'menu' };
  const show = id => { at.part = id; document.getElementById(id).scrollIntoView({ block: 'start' }); };
  const order = () => c.state.items.length ? 'The order: ' + c.state.items.join('; ') + '.' : 'Nothing in the order yet.';
  window.fdcController = {
    about: 'Order board of a small café: the barista chooses a drink, sets how it is made, adds it to the order and places the order',
    commands() {
      const s = c.state, list = [{ id: 'show_menu', say: 'Show the menu', name: 'Menu' }, { id: 'show_order', say: 'Show the order', name: 'Your order' }];
      if (s.placed) return [...list, { id: 'new_order', say: 'Start a new order' }];
      for (const [id, label] of c.MENU) if (id !== s.selected) list.push({ id: 'choose_' + id, say: 'Choose the ' + label + ' as the drink being made' });
      if (s.selected) {
        const drink = c.name(s.selected);
        for (const [key, values] of Object.entries(c.OPTIONS)) for (const value of values) if (s[key] !== value)
          list.push({ id: 'set_' + key + '_' + value.toLowerCase(), say: key === 'size' ? 'Make the ' + drink + ' ' + value.toLowerCase() : key === 'milk' ? (value === 'None' ? 'Make the ' + drink + ' without milk' : 'Make the ' + drink + ' with ' + value.toLowerCase() + ' milk') : key === 'sweet' ? (value === 'None' ? 'Take the sweetener out of the ' + drink : 'Sweeten the ' + drink + ' with ' + value.toLowerCase()) : key === 'temp' ? 'Make the ' + drink + ' ' + value.toLowerCase() : 'Make the ' + drink + ' ' + value.toLowerCase() + (value === 'Decaf' ? '' : ' (with caffeine)') });
        list.push({ id: 'add_drink', say: 'Add the ' + drink + ' as it is set to the order' });
      }
      s.items.forEach((item, i) => list.push({ id: 'remove_' + (i + 1), say: 'Remove drink ' + (i + 1) + ' from the order: ' + item }));
      if (s.items.length) list.push({ id: 'place_order', say: 'Place the order' });
      return list;
    },
    async run(id) {
      const s = c.state;
      if (id === 'show_menu') { show('menu'); return 'The menu: ' + c.MENU.map(d => d[1]).join(', ') + '.'; }
      if (id === 'show_order') { show('order'); return order(); }
      if (id === 'new_order') { c.set({ selected: null, size: 'Regular', milk: 'Whole', sweet: 'None', temp: 'Hot', caffeine: 'Regular', items: [], placed: false }); show('menu'); return 'A new order: nothing in it yet.'; }
      if (s.placed) return 'The order is already placed.';
      if (id.startsWith('choose_')) { c.set({ selected: id.slice(7), size: 'Regular', milk: 'Whole', sweet: 'None', temp: 'Hot', caffeine: 'Regular' }); show('cup'); return 'Now making: ' + c.cup() + '. ' + order(); }
      if (id.startsWith('set_')) {
        const [, key, ...rest] = id.split('_'), value = c.OPTIONS[key].find(v => v.toLowerCase() === rest.join('_'));
        if (!value) throw new Error('No such option: ' + id);
        c.set({ [key]: value }); show('cup'); return 'Now making: ' + c.cup() + '.';
      }
      if (id === 'add_drink') { if (!s.selected) return 'No drink is chosen yet.'; c.set({ items: [...s.items, c.cup()], selected: null }); show('order'); return 'Added. ' + order(); }
      if (id.startsWith('remove_')) { const i = Number(id.slice(7)) - 1; if (!s.items[i]) return 'That drink is not in the order.'; c.set({ items: s.items.filter((_, n) => n !== i) }); show('order'); return 'Removed. ' + order(); }
      if (id === 'place_order') { c.set({ placed: true }); show('order'); return 'The order is placed. ' + order(); }
      throw new Error('No such command: ' + id);
    },
    where() { const s = c.state; return { text: (at.part === 'menu' ? 'Menu' : at.part === 'cup' ? 'Your cup' : 'Your order') + '. Making: ' + c.cup() + '. ' + s.items.length + ' in the order' + (s.placed ? ', placed.' : '.'), path: ['Corner Café', at.part === 'menu' ? 'Menu' : at.part === 'cup' ? 'Your cup' : 'Your order'], revision: 1 }; },
  };
})();
`;
fs.writeFileSync(path.join(docs, 'index.html'), PAGE); fs.writeFileSync(path.join(docs, 'cafe.controller.js'), CONTROLLER);
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url!, 'http://x').pathname), file = path.join(docs, name === '/' ? 'index.html' : name);
  if (!file.startsWith(docs) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(fs.readFileSync(file));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// --- The browser: fdc's page with a virtual microphone; the order page in its own context ----------------------------
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const pages = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const board = await pages.newPage();
await board.goto(base);
/** The stage's browser tools, over a Playwright tab instead of Open Claude in Chrome (the same calls Stage makes). */
const TAB = 4100, stageBrowser = {
  async evaluate(tabId: number, expression: string) { if (tabId !== TAB || board.isClosed()) throw new Error(`Tab ${tabId} is not in the MCP group.`); return board.evaluate(expression); },
  async call() { return 'ok'; }, async tabs() { return [{ tabId: TAB, title: await board.title(), url: board.url() }]; }, close() {},
};
const harness = new Harness({ agent: claude, root, runDir: path.join(runRoot, 'fdc'), cwd: path.join(runRoot, 'project'), sessionId: randomUUID(), apiKey: process.env.OPENAI_API_KEY!, jevKey: process.env.TYPESAFE_API_KEY, stageFile: path.join(runRoot, 'stage.json'), tuning: { standbyAfterMs: 0 }, features: ['configuration'] });
fs.mkdirSync(path.join(runRoot, 'project'), { recursive: true });
harness.companions = new CompanionRegistry(path.join(runRoot, 'companions'));
harness.stage.browser = stageBrowser as any;
await harness.start(); harness.agentReady = true;
// No agent: what fdc would deliver is taken here.
const delivered: { at: number; said: string; content: string }[] = [];
harness.deliver = request => { delivered.push({ at: Date.now(), said: request.said ?? '', content: request.content }); harness.mediator?.delivered(request.id); };
// The run's events, read as they are appended (the log also holds every audio packet: only the rest is kept).
const log = { offset: 0, rest: '', list: [] as any[] };
const events = () => {
  const file = path.join(harness.runDir, 'events.jsonl');
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
const voicePage = await voiceContext.newPage();
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
/** Waits until GPT Live has answered since `since` and then been quiet for `ms` (or `max`). */
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
const state = () => board.evaluate('JSON.parse(JSON.stringify(window.cafe.state))') as Promise<any>;
interface Step { said: string; heard: string; voice: string; ran: string[]; afterMs?: number; delivered: string[]; state: any; expect: string; passed: boolean; notes: string[] }
const steps: Step[] = [];
async function say(text: string, expect: string, check: (s: any, step: Step) => boolean) {
  const mark = events().length, sent = delivered.length, at = Date.now(), speech = synthesize(`operating-${Buffer.from(text).toString('base64url').slice(0, 40)}`, text);
  await voicePage.evaluate(pcm => (window as any).say(pcm), speech.pcm.toString('base64'));
  const spoken = Date.now();
  await quiet(30000, 3000, at);
  const all = events().slice(mark), text_ = (type: string) => all.filter(e => e.type === type).map(e => e.delta ?? '').join('').replace(/\s+/g, ' ').trim();
  const ran = all.filter(e => e.type === 'stage.ran').flatMap(e => e.ids), first = all.find(e => e.type === 'stage.ran');
  const step: Step = { said: text, heard: text_('session.input_transcript.delta'), voice: text_('session.output_transcript.delta'), ran, ...first && { afterMs: first.at - spoken }, delivered: delivered.slice(sent).map(d => d.said), state: await state(), expect, passed: false,
    notes: all.filter(e => ['stage.asked', 'stage.failed', 'stage.nothing', 'turn.read', 'turn.job', 'turn.kept', 'jev.error', 'stage.error', 'turn.error'].includes(e.type)).map(e => `${e.type} ${JSON.stringify({ ...e, at: undefined, type: undefined }).slice(0, 220)}`) };
  step.passed = check(step.state, step);
  steps.push(step);
  await board.screenshot({ path: path.join(out, `step-${steps.length}.png`) }).catch(() => {});
  console.log(`\n"${text}"\n  heard: ${step.heard}\n  voice: ${step.voice.slice(0, 300)}\n  ran:   ${ran.join(' > ') || '(nothing)'}${step.afterMs !== undefined ? ` (first ${step.afterMs} ms after they stopped speaking)` : ''}\n  to the agent: ${step.delivered.length ? step.delivered.map(d => `"${d}"`).join(', ') : 'nothing'}\n  ${step.passed ? 'PASS' : 'FAIL'}: ${expect}`);
}
try {
  harness.stage.observe({ tool: 'mcp__open-claude-in-chrome-hybrid__navigate', input: { tabId: TAB, url: '' }, response: '' });
  const before = events().filter(e => e.type === 'voice.started').length;
  await voicePage.locator('#start').click();
  await until(() => events().filter(e => e.type === 'voice.started').length > before, { label: 'voice started', timeout: 40000 });
  await quiet(20000, 2500);
  const nothing = (step: Step) => step.delivered.length === 0;
  await say('Hi. You are my barista today. Can I get a mocha, please?', 'the mocha is chosen, by the voice tool, and nothing goes to the agent', (s, step) => s.selected === 'mocha' && nothing(step));
  await say('Make it large, with oat milk, and vanilla.', 'three settings from one request: large, oat milk, vanilla', (s, step) => s.size === 'Large' && s.milk === 'Oat' && s.sweet === 'Vanilla' && nothing(step));
  await say('Okay, add that to my order. And I would also like an espresso.', 'the mocha is in the order as it was set, and the espresso is chosen', (s, step) => s.items.length === 1 && /Large hot Mocha, oat milk, vanilla/.test(s.items[0]) && s.selected === 'espresso' && nothing(step));
  await say('Wait, what is an espresso, exactly?', 'a question: answered, nothing changes on the page, nothing goes to the agent', (s, step) => s.items.length === 1 && s.selected === 'espresso' && step.ran.every(id => !/^page_(set|add|place|remove|choose)/.test(id)) && nothing(step));
  await harness.appendInstruction('Take my order yourself, with the page. Do not pass my orders or my questions about them on to Claude.');
  await delay(1500);
  await say('Make the espresso decaf, add it, and then place the order.', 'decaf, added, and the order placed, with the instruction in force', (s, step) => s.items.length === 2 && /Espresso.*decaf/.test(s.items[1]) && s.placed === true && nothing(step));
  await say('How many drinks did I order in the end?', 'a question the voice can answer: nothing goes to the agent', (s, step) => s.placed === true && nothing(step));
  await say('Now tell Claude to add a caramel option to the sweeteners on this page.', 'asked for the agent by name: it goes', (s, step) => step.delivered.some(d => /caramel/i.test(d)));
} catch (error) { console.error('\nERROR', error); steps.push({ said: `(error: ${(error as Error).message})`, heard: '', voice: '', ran: [], delivered: [], state: null, expect: 'no error', passed: false, notes: [] }); }
finally {
  await harness.live?.close('test over').catch(() => {}); await delay(1500);
  const billed = events().filter(e => e.type === 'bridge.closed').reduce((n, e) => n + (e.usageSeconds ?? 0), 0);
  const jevFile = path.join(harness.runDir, 'jev.jsonl'), jevCalls = fs.existsSync(jevFile) ? fs.readFileSync(jevFile, 'utf8').trim().split('\n').length : 0;
  await harness.close().catch(() => {}); await browser.close(); server.close();
  const summary = { label, runRoot, billedSeconds: billed, dollars: +(billed * .05 / 60).toFixed(3), jevCalls, passed: steps.filter(s => s.passed).length, failed: steps.filter(s => !s.passed).length, steps };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(summary, null, 1));
  console.log(`\n${summary.passed} passed, ${summary.failed} failed; billed ${billed} s of voice (about $${summary.dollars}), ${jevCalls} Jev calls; ${runRoot}`);
  process.exit(summary.failed ? 1 : 0);
}
