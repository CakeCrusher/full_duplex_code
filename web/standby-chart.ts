// The Standby chart: for every quiet window, the share of voice time Standby would not have billed and how often
// it would have woken, replayed by the bridge over this run's voice conversation or every recorded run's, with the
// current prices and threshold (src/core/standby-replay.ts). Two panels share one window axis, rather than two
// scales on one plot; the current window is marked on both.
interface Point { windowS: number; saved: number; wakesPerHour: number; noisePerHour: number; wakes: number; noise: number; savedUsd: number }
interface Sweep { scope: 'run' | 'all'; hours: number; sessions: number; windowS: number; threshold: number; points: Point[] }

const NS = 'http://www.w3.org/2000/svg';
// Validated (color-blind separation, lightness, chroma, contrast) on the page's white surface.
const COLORS = { saved: '#0b8f7a', wakes: '#6a3fd0', noise: '#c26a00', ink: '#203d32', muted: '#617266', line: '#e4eae0', surface: '#ffffff' };
const el = (parent: Element, tag: string, attrs: Record<string, string | number>, text?: string) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node); return node;
};
// Round ticks: a step of 1, 2 or 5 times a power of ten, about four of them up to the data's maximum.
const niceStep = (v: number) => { const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const ticks = (max: number, cap = Infinity) => { const step = niceStep(Math.max(max, 1) / 4); return { step, top: Math.min(cap, Math.ceil(max * 1.05 / step) * step) }; };
const number = (v: number) => Number.isInteger(v) ? String(v) : v.toFixed(1);

export function mountStandbyChart(section: HTMLElement, token: string | null) {
  const scope = section.querySelector<HTMLSelectElement>('#standby-scope')!, refresh = section.querySelector<HTMLButtonElement>('#standby-refresh')!;
  const status = section.querySelector<HTMLElement>('#standby-status')!, svg = section.querySelector<SVGSVGElement>('#standby-svg')!, table = section.querySelector<HTMLTableElement>('#standby-table')!;
  const tooltip = section.querySelector<HTMLElement>('#standby-tooltip')!;
  let data: Sweep | null = null, asked = 0, tuningKey = '', timer: ReturnType<typeof setTimeout> | undefined;
  let geometry: { x: (w: number) => number; W: number; left: number; right: number; panels: { y: (v: number) => number; fields: [keyof Point, string][] }[]; cross: SVGGElement; line: SVGLineElement; dots: { panel: number; field: keyof Point; dot: SVGCircleElement }[] } | null = null;

  async function load() {
    if (!token) return;
    const ask = ++asked;
    status.textContent = 'Replaying…';
    try {
      const response = await fetch(`/api/standby?scope=${scope.value}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!response.ok) throw new Error(`the companion answered ${response.status}`);
      const sweep: Sweep = await response.json();
      if (ask !== asked) return;
      data = sweep;
      status.textContent = sweep.sessions ? `${sweep.hours.toFixed(1)} h of voice in ${sweep.sessions} session${sweep.sessions === 1 ? '' : 's'} · threshold ${sweep.threshold} · now ${sweep.windowS ? `${sweep.windowS} s` : 'off'}` : 'No recorded voice yet: talk for a while, then refresh.';
      draw(); fill();
    } catch (error) { if (ask === asked) status.textContent = `Couldn't replay: ${(error as Error).message}`; }
  }

  function draw() {
    svg.replaceChildren(); geometry = null;
    const points = data?.points ?? [];
    if (!data || !data.sessions || !points.length) return;
    const W = svg.clientWidth || 900, H = 300, m = { left: 58, right: 72, top: 16, gap: 32, bottom: 28 }, panelH = (H - m.top - m.gap - m.bottom) / 2;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const last = points[points.length - 1].windowS, x = (w: number) => m.left + w / last * (W - m.left - m.right);
    const saved = ticks(Math.max(...points.map(p => p.saved), 5), 100), woken = ticks(Math.max(...points.map(p => p.wakesPerHour), 4));
    const specs: { y0: number; top: number; step: number; title: string; format: (v: number) => string; fields: [keyof Point, string][] }[] = [
      { y0: m.top, top: saved.top, step: saved.step, title: 'Not billed (%)', format: v => `${Math.round(v)}%`, fields: [['saved', COLORS.saved]] },
      { y0: m.top + panelH + m.gap, top: woken.top, step: woken.step, title: 'Wakes an hour', format: number, fields: [['wakesPerHour', COLORS.wakes], ['noisePerHour', COLORS.noise]] },
    ];
    const panels = specs.map(spec => {
      const y = (v: number) => spec.y0 + panelH - v / spec.top * panelH;
      for (let v = 0; v <= spec.top + 1e-9; v += spec.step) {
        el(svg, 'line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), stroke: COLORS.line, 'stroke-width': 1 });
        el(svg, 'text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', fill: COLORS.muted }, spec.format(v));
      }
      el(svg, 'text', { x: m.left, y: spec.y0 - 4, fill: COLORS.ink, 'font-weight': 600 }, spec.title);
      for (const [field, color] of spec.fields) {
        el(svg, 'polyline', { points: points.map(p => `${x(p.windowS)},${y(p[field] as number)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
        const end = points[points.length - 1][field] as number;
        el(svg, 'text', { x: x(last) + 8, y: y(end) + 4, fill: COLORS.muted }, field === 'saved' ? `${Math.round(end)}%` : `${end.toFixed(1)}${field === 'noisePerHour' ? ' noise' : '/h'}`);
      }
      return { y, fields: spec.fields };
    });
    for (let w = 0; w <= last; w += 30) el(svg, 'text', { x: x(w), y: H - m.bottom + 18, 'text-anchor': 'middle', fill: COLORS.muted }, w ? `${w} s` : 'off');
    el(svg, 'text', { x: W - m.right, y: H - 2, 'text-anchor': 'end', fill: COLORS.ink, 'font-weight': 600 }, 'Quiet window');
    // The window in use, on both panels.
    const now = points.find(p => p.windowS === data!.windowS), cx = x(Math.min(last, data.windowS));
    el(svg, 'line', { x1: cx, x2: cx, y1: m.top, y2: H - m.bottom, stroke: COLORS.ink, 'stroke-width': 1 });
    el(svg, 'text', { x: cx + 6, y: m.top + 10, fill: COLORS.ink }, `now ${data.windowS ? `${data.windowS} s` : 'off'}`);
    if (now) panels.forEach(panel => panel.fields.forEach(([field, color]) => el(svg, 'circle', { cx, cy: panel.y(now[field] as number), r: 4.5, fill: color, stroke: COLORS.surface, 'stroke-width': 2 })));
    const cross = el(svg, 'g', { visibility: 'hidden' }) as SVGGElement;
    const line = el(cross, 'line', { y1: m.top, y2: H - m.bottom, stroke: COLORS.muted, 'stroke-width': 1 }) as SVGLineElement;
    const dots = panels.flatMap((panel, index) => panel.fields.map(([field, color]) => ({ panel: index, field, dot: el(cross, 'circle', { r: 4.5, fill: color, stroke: COLORS.surface, 'stroke-width': 2 }) as SVGCircleElement })));
    geometry = { x, W, left: m.left, right: m.right, panels, cross, line, dots };
  }
  function pointAt(clientX: number) {
    if (!geometry || !data) return null;
    const rect = svg.getBoundingClientRect(), px = (clientX - rect.left) / rect.width * geometry.W, last = data.points[data.points.length - 1].windowS;
    const w = (px - geometry.left) / (geometry.W - geometry.left - geometry.right) * last;
    return data.points.reduce((best, p) => Math.abs(p.windowS - w) < Math.abs(best.windowS - w) ? p : best, data.points[0]);
  }
  svg.addEventListener('mousemove', event => {
    const p = pointAt(event.clientX), g = geometry; if (!p || !g) return;
    g.cross.setAttribute('visibility', 'visible'); g.line.setAttribute('x1', String(g.x(p.windowS))); g.line.setAttribute('x2', String(g.x(p.windowS)));
    for (const { panel, field, dot } of g.dots) { dot.setAttribute('cx', String(g.x(p.windowS))); dot.setAttribute('cy', String(g.panels[panel].y(p[field] as number))); }
    tooltip.replaceChildren(Object.assign(document.createElement('strong'), { textContent: p.windowS ? `Quiet window ${p.windowS} s` : 'Standby off' }),
      Object.assign(document.createElement('p'), { textContent: `${p.saved.toFixed(1)}% not billed ($${p.savedUsd.toFixed(2)})` }),
      Object.assign(document.createElement('p'), { textContent: `${p.wakesPerHour.toFixed(1)} wakes an hour, ${p.noisePerHour.toFixed(1)} of them noise (${p.wakes} and ${p.noise} in all)` }));
    tooltip.hidden = false; tooltip.style.left = `${Math.min(innerWidth - 320, event.clientX + 14)}px`; tooltip.style.top = `${event.clientY + 16}px`;
  });
  svg.addEventListener('mouseleave', () => { tooltip.hidden = true; geometry?.cross.setAttribute('visibility', 'hidden'); });
  function fill() {
    const rows = (data?.points ?? []).map(p => `<tr><td>${p.windowS ? `${p.windowS} s` : 'off'}</td><td>${p.saved.toFixed(1)}%</td><td>$${p.savedUsd.toFixed(2)}</td><td>${p.wakesPerHour.toFixed(1)}</td><td>${p.noisePerHour.toFixed(1)}</td></tr>`).join('');
    table.innerHTML = `<tr><th>Window</th><th>Not billed</th><th>Saved</th><th>Wakes an hour</th><th>Noise an hour</th></tr>${rows}`;
  }
  scope.onchange = load; refresh.onclick = load;
  addEventListener('resize', draw);
  // This run grows as you talk: replayed again every two minutes while the page is visible.
  setInterval(() => { if (scope.value === 'run' && !document.hidden) load(); }, 120000);
  load();
  return {
    /** New settings (the window, the threshold, the prices): replayed again. */
    tuning(tuning: Record<string, number> | undefined) {
      const key = JSON.stringify(tuning ?? {});
      if (key === tuningKey) return;
      const first = !tuningKey; tuningKey = key;
      if (!first) { clearTimeout(timer); timer = setTimeout(load, 1000); }
    },
  };
}
