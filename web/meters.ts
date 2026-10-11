import { profile } from './profile.js';
import { elapsed } from './timeline.js';

// Small rolling charts of the current voice session: what goes into GPT Live,
// how full its context window is, what is said, and what reaches the agent.
// Rates come from the timeline's items, so a reloaded page shows the same numbers.
type Item = { id: string; track: string; start: number; end: number; [field: string]: any };
/** The bridge's live_usage: the latest voice session's span and GPT Live's usage reports. */
export type LiveUsage = { voiceSessionId: string; startedAt: number; endedAt?: number; seconds: number; ratio: number | null; points: [number, number][] };
type Series = { total: number; buckets: number[] };
type Point = { t: number; v: number };

const BUCKET = 10000, WINDOW = 300000, MINUTE = 60000, SVG = 'http://www.w3.org/2000/svg';
const words = (text = '') => text.match(/\S+/g)?.length ?? 0;
const compact = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
type Key = 'sent' | 'window' | 'live' | 'operator' | 'requests';
// floor: the smallest top of the scale, so that a quiet minute stays a flat line.
const METERS: { key: Key; label: string; unit: string; floor: number; total(n: number): string }[] = [
  { key: 'sent', label: 'Sent to Live', unit: 'tokens/min', floor: 200, total: (n: number) => `About ${compact(n)} tokens this session` },
  { key: 'window', label: 'Live’s context window', unit: 'used', floor: 100, total: () => 'As Live last reported, about every 15 s' },
  { key: 'live', label: 'Live’s words', unit: 'words/min', floor: 60, total: (n: number) => `${compact(n)} words this session` },
  { key: 'operator', label: 'Your words', unit: 'words/min', floor: 60, total: (n: number) => `${compact(n)} words this session` },
  { key: 'requests', label: `Requests to ${profile.name}`, unit: 'per min', floor: 2, total: (n: number) => `${n} passed on this session` },
];
type Tile = { value: HTMLElement; total: HTMLElement; line: SVGPathElement; area: SVGPathElement; dot: HTMLElement; cursor: HTMLElement; points: Point[] };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

export class Meters {
  items: Map<string, Item>; usage: LiveUsage | null = null;
  tiles = new Map<Key, Tile>(); state: HTMLElement; hover: { key: Key; x: number } | null = null;
  constructor(items: Map<string, Item>) {
    this.items = items;
    const root = document.getElementById('meters')!, heading = element('div', 'meters-heading');
    this.state = element('span', 'meters-state');
    heading.append(element('h2', 'eyebrow', 'LIVE METERS · LAST 5 MINUTES'), this.state);
    const grid = element('div', 'meters-grid');
    for (const { key, label, unit } of METERS) {
      const tile = element('article', 'meter'); tile.dataset.meter = key; tile.setAttribute('aria-label', label);
      const reading = element('p', 'meter-reading'), value = element('strong', 'meter-value', '–');
      reading.append(value, element('span', 'meter-unit', unit));
      const chart = element('div', 'meter-chart');
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 100 40'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
      const area = document.createElementNS(SVG, 'path'), line = document.createElementNS(SVG, 'path');
      area.setAttribute('class', 'meter-area'); line.setAttribute('class', 'meter-line'); line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(area, line);
      const dot = element('i', 'meter-dot'), cursor = element('i', 'meter-cursor'); dot.hidden = cursor.hidden = true;
      chart.append(svg, dot, cursor);
      // Pointing at a chart reads that moment's value in place of the total.
      chart.addEventListener('pointermove', event => { const box = chart.getBoundingClientRect(); this.hover = { key, x: (event.clientX - box.left) / box.width }; this.render(); });
      chart.addEventListener('pointerleave', () => { this.hover = null; this.render(); });
      const total = element('p', 'meter-total');
      tile.append(element('span', 'meter-label', label), reading, chart, total);
      grid.append(tile);
      this.tiles.set(key, { value, total, line, area, dot, cursor, points: [] });
    }
    root.append(heading, grid);
    setInterval(() => { if (!document.hidden) this.render(); }, 1000);
    this.render();
  }
  handle(event: { type: string; [field: string]: any }) {
    if (event.type === 'live_usage') { this.usage = event as unknown as LiveUsage; this.render(); }
    // A page that connects mid-session learns the session from the status.
    if (event.type === 'status' && 'liveUsage' in event) this.usage = event.liveUsage;
  }
  // Amounts per 10-second bucket since the session started; a transcript spreads its words over its span.
  series(usage: LiveUsage, end: number) {
    const count = Math.max(1, Math.ceil((end - usage.startedAt) / BUCKET));
    const all = Object.fromEntries(['sent', 'live', 'operator', 'requests'].map(key => [key, { total: 0, buckets: new Array(count).fill(0) }])) as Record<Exclude<Key, 'window'>, Series>;
    const add = (series: Series, amount: number, from: number, to = from) => {
      from = Math.min(Math.max(from, usage.startedAt), end); to = Math.min(Math.max(to, from), end);
      series.total += amount;
      const bucket = (t: number) => Math.min(count - 1, Math.floor((t - usage.startedAt) / BUCKET));
      if (to <= from) { series.buckets[bucket(from)] += amount; return; }
      for (let t = from; t < to;) {
        const next = Math.min(to, usage.startedAt + (bucket(t) + 1) * BUCKET);
        series.buckets[bucket(t)] += amount * (next - t) / (to - from); t = next > t ? next : to;
      }
    };
    for (const item of this.items.values()) {
      if (item.track === 'transcript') { if (item.voiceSessionId === usage.voiceSessionId) add(all[item.role === 'operator' ? 'operator' : 'live'], words(item.text), item.start, item.end); continue; }
      if (item.start < usage.startedAt || item.start > end) continue;
      // Characters / 4 estimates the tokens of each context append.
      if (item.track === 'context') add(all.sent, Math.ceil((item.text ?? '').length / 4), item.start);
      // Requests the bridge passed on carry a request ID; typed ones do not.
      if (item.track === 'requests' && item.requestId) add(all.requests, 1, item.start);
    }
    return all;
  }
  // Each bucket's rate over the minute before it, or since the start when that is sooner.
  rates(series: Series, usage: LiveUsage, end: number): Point[] {
    return series.buckets.map((_, k) => {
      let sum = 0; for (let i = Math.max(0, k - 5); i <= k; i++) sum += series.buckets[i];
      const t = Math.min(usage.startedAt + (k + 1) * BUCKET, end), from = Math.max(usage.startedAt, usage.startedAt + (k - 5) * BUCKET);
      return { t, v: sum / Math.max(BUCKET, t - from) * MINUTE };
    });
  }
  render() {
    const usage = this.usage, now = Date.now(), end = usage?.endedAt ?? now, from = end - WINDOW;
    const state = !usage ? 'Start voice to fill these in' : usage.endedAt ? 'Last voice session' : 'This voice session';
    if (this.state.textContent !== state) this.state.textContent = state;
    const series = usage && this.series(usage, end);
    for (const meter of METERS) {
      const tile = this.tiles.get(meter.key)!, percent = meter.key === 'window' ? '%' : '';
      let points: Point[] = [], value: number | null = null, total = '';
      if (usage && series) {
        if (meter.key === 'window') {
          points = usage.points.map(([t, ratio]) => ({ t, v: ratio * 100 }));
          value = usage.ratio === null ? null : usage.ratio * 100; total = meter.total(0);
        } else {
          points = this.rates(series[meter.key], usage, end);
          value = points.at(-1)!.v; total = meter.total(series[meter.key].total);
        }
      }
      // One point before the window lets the line enter from the left edge.
      const first = points.findIndex(point => point.t >= from);
      tile.points = first < 0 ? [] : points.slice(Math.max(0, first - 1));
      this.draw(tile, meter.floor, from);
      const hover = this.hover?.key === meter.key && tile.points.length ? this.nearest(tile, from) : null;
      tile.cursor.hidden = !hover;
      if (hover) {
        tile.cursor.style.left = `${(hover.t - from) / WINDOW * 100}%`;
        total = `${hover.t >= end - 1000 ? 'Now' : `${elapsed(end - hover.t)} ago`} · ${compact(hover.v)}${percent} ${meter.unit}`;
      }
      const shown = value === null ? '–' : compact(value) + percent;
      if (tile.value.textContent !== shown) tile.value.textContent = shown;
      if (tile.total.textContent !== total) tile.total.textContent = total;
    }
  }
  nearest(tile: Tile, from: number) {
    const t = from + this.hover!.x * WINDOW;
    return tile.points.reduce((best, point) => Math.abs(point.t - t) < Math.abs(best.t - t) ? point : best);
  }
  draw(tile: Tile, floor: number, from: number) {
    const { points } = tile, top = Math.max(floor, ...points.map(point => point.v * 1.15));
    const xy = points.map(point => [(point.t - from) / WINDOW * 100, 39 - point.v / top * 36] as const);
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
    tile.line.setAttribute('d', line);
    tile.area.setAttribute('d', xy.length > 1 ? `${line}L${xy.at(-1)![0].toFixed(2)},40L${xy[0][0].toFixed(2)},40Z` : '');
    tile.dot.hidden = !xy.length;
    if (xy.length) { tile.dot.style.left = `${xy.at(-1)![0]}%`; tile.dot.style.top = `${xy.at(-1)![1] / 40 * 100}%`; }
  }
}
