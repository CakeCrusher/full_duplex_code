const tracks = { operator: 'Operator audio', speech: 'Live speech', transcript: 'API transcript', claude: 'Claude hooks', context: 'Context sent to Live', requests: 'Requests to Claude' };
const $ = id => document.getElementById(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export function elapsed(ms, precise = false) {
  const seconds = Math.max(0, ms / 1000);
  return `${Math.floor(seconds / 60)}:${(precise ? (seconds % 60).toFixed(1) : String(Math.floor(seconds % 60))).padStart(precise ? 4 : 2, '0')}`;
}
export class TimelineView {
  constructor() {
    this.items = new Map(); this.nodes = new Map(); this.origin = Date.now(); this.windowMs = 60000;
    this.follow = true; this.viewStart = this.origin; this.selected = null; this.hovered = null;
    this.plot = $('timeline-plot'); this.tooltip = $('timeline-tooltip');
    $('timeline-live').onclick = () => { this.follow = true; this.selected = null; this.hovered = null; this.hideTooltip(); this.showDetails(null); this.render(); };
    $('timeline-back').onclick = () => this.pan(-this.windowMs / 2);
    $('timeline-forward').onclick = () => this.pan(this.windowMs / 2);
    $('timeline-zoom').onchange = e => { this.windowMs = Number(e.target.value); this.render(); };
    $('timeline-scrub').oninput = e => { this.follow = false; this.viewStart = this.origin + Number(e.target.value); this.render(); };
    $('detail-clear').onclick = () => { this.selected = null; this.showDetails(null); this.render(); };
    $('detail-copy').onclick = async () => {
      try { await navigator.clipboard.writeText($('detail-text').textContent); $('detail-copy').textContent = 'Copied'; }
      catch { $('detail-copy').textContent = 'Select the text to copy'; }
    };
    this.plot.addEventListener('wheel', e => {
      if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault(); this.pan((e.deltaX || e.deltaY) / this.plot.clientWidth * this.windowMs);
    }, { passive: false });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { this.selected = null; this.hovered = null; this.hideTooltip(); this.showDetails(null); this.render(); } });
    this.timer = setInterval(() => { if (!document.hidden) this.render(); }, 100);
    this.render();
  }
  handle(event) {
    if (event.type === 'timeline_history') { this.origin = event.origin; this.viewStart = event.origin; this.items.clear(); }
    if (event.type === 'timeline_history' || event.type === 'timeline_update') {
      for (const item of event.items) this.items.set(item.id, item);
      this.render();
    }
  }
  pan(delta) { this.follow = false; this.viewStart += delta; this.render(); }
  timing(item) {
    const start = elapsed(item.start - this.origin, true);
    return item.end > item.start ? `${start} – ${elapsed(item.end - this.origin, true)} · ${((item.end - item.start) / 1000).toFixed(2)}s` : `${start} · instant event`;
  }
  detailText(item) {
    if (item.text) return item.text;
    const role = item.track === 'operator' ? 'operator' : 'intermediary';
    const transcripts = [...this.items.values()].filter(t => t.track === 'transcript' && t.role === role && t.start < item.end + 300 && t.end > item.start - 300);
    return transcripts.map(t => t.text).join('\n') || 'Audio activity. No matching transcript has arrived yet.';
  }
  showDetails(item) {
    if ((!item || item.text) && this.detailItem === item && this.detailSelected === this.selected) return;
    this.detailItem = item; this.detailSelected = this.selected;
    $('detail-clear').hidden = !this.selected;
    $('detail-kind').textContent = item ? tracks[item.track] : 'Inspect the timeline';
    $('detail-title').textContent = item ? this.itemLabel(item) : 'Hover for a closer look.';
    $('detail-time').textContent = item ? this.timing(item) : 'Click an item to pin it. Keyboard focus and tap work too.';
    $('detail-text').textContent = item ? this.detailText(item) : 'Audio, transcripts, every Claude hook, context delivery, and requests share the same clock.';
    const request = item?.track === 'requests';
    $('detail-copy').hidden = !request; $('detail-copy').textContent = 'Copy message';
    $('detail-message-label').hidden = !request;
    $('detail-message-label').textContent = item?.notification ? (['sent', 'observed'].includes(item.state) ? 'Full channel message content · sent as shown' : 'Full channel message content · delivery not confirmed') : 'Prompt captured from Claude';
    $('detail-payload').hidden = !item?.notification;
    $('detail-json').textContent = item?.notification ? JSON.stringify(item.notification, null, 2) : '';
    $('detail-json-label').textContent = item?.track === 'context' ? 'Exact JSON sent to Live' : ['queued', 'dispatching', 'uncertain'].includes(item?.state) ? 'Channel notification JSON · delivery not confirmed' : 'Channel notification JSON';
    $('detail-observed').hidden = !item?.observedPrompt;
    $('detail-observed-text').textContent = item?.observedPrompt ?? '';
    $('detail-verification').hidden = !request || !item?.notification;
    $('detail-verification').textContent = item?.contentMatches === true ? 'Verified: Claude’s UserPromptSubmit contains exactly this message.'
      : item?.contentMatches === false ? 'Content differs: compare the sent message with Claude’s captured prompt below.'
      : item?.observedPrompt ? 'Claude’s prompt was captured; its envelope could not be compared automatically.'
      : 'Waiting for Claude’s UserPromptSubmit to verify receipt. Channel delivery alone does not prove Claude has processed it.';
    const extras = [];
    if (item?.index !== undefined) extras.push(`Batch ${item.index + 1}${item.final ? ' · final' : ''}`);
    if (item?.state && item.track === 'context') extras.push(item.state === 'sent' ? 'Sent to Live; waiting for acknowledgment' : 'Acknowledged by Live');
    else if (item?.state) extras.push(({ queued: 'Queued', dispatching: 'Sending', sent: 'Delivered to channel', observed: 'Received by Claude', uncertain: 'Delivery uncertain' })[item.state] ?? item.state);
    if (item?.receivedAt) extras.push(`Transcript received at ${elapsed(item.receivedAt - this.origin, true)}`);
    if (item?.peak) extras.push(`Peak level ${Math.round(item.peak * 100)}%`);
    if (item?.injectionStartMs !== undefined) extras.push(`API injection estimate: ${(item.injectionStartMs / 1000).toFixed(2)}–${(item.injectionEndMs / 1000).toFixed(2)}s into voice`);
    $('detail-source').textContent = item ? [item.source, ...extras].join(' · ') : '';
  }
  itemLabel(item) {
    if (item.track === 'transcript') return `${item.label}: ${item.text.trim()}`;
    if (item.track === 'claude') return item.label;
    return item.label;
  }
  showTooltip(item, target) {
    $('tooltip-title').textContent = `${tracks[item.track]} · ${this.timing(item)}`;
    $('tooltip-text').textContent = this.detailText(item).slice(0, 350);
    this.tooltip.hidden = false;
    const box = target.getBoundingClientRect(); const rect = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${clamp(box.left, 12, innerWidth - rect.width - 12)}px`;
    this.tooltip.style.top = `${Math.max(12, box.top - rect.height - 12)}px`;
  }
  hideTooltip() { this.tooltip.hidden = true; }
  makeNode(item) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `timeline-item track-${item.track}`;
    button.dataset.id = item.id; button.dataset.track = item.track;
    const text = document.createElement('span'); button.append(text);
    const inspect = () => {
      this.hovered = item.id;
      const current = this.items.get(item.id);
      if (!this.selected) this.showDetails(current);
      this.showTooltip(current, button);
    };
    button.addEventListener('pointerenter', inspect); button.addEventListener('focus', inspect);
    button.addEventListener('pointerleave', () => { if (document.activeElement !== button) { this.hovered = null; this.hideTooltip(); } });
    button.addEventListener('blur', () => { this.hovered = null; this.hideTooltip(); });
    button.onclick = () => { this.selected = item.id; this.follow = false; this.showDetails(this.items.get(item.id)); this.hideTooltip(); this.render(); };
    button.setAttribute('aria-describedby', 'timeline-tooltip');
    this.plot.querySelector(`[data-lane="${item.track}"]`).append(button);
    this.nodes.set(item.id, button); return button;
  }
  render() {
    const now = Date.now();
    const maxStart = Math.max(this.origin, now - this.windowMs + 2000);
    if (this.follow && !this.hovered) this.viewStart = maxStart;
    this.viewStart = clamp(this.viewStart, this.origin, maxStart);
    const end = this.viewStart + this.windowMs;
    $('timeline-live').setAttribute('aria-pressed', String(this.follow));
    $('timeline-mode').textContent = this.follow ? this.hovered ? 'Inspecting · updates continue' : 'Following live' : 'Reviewing · updates continue';
    $('timeline-clock').textContent = elapsed(now - this.origin);
    $('timeline-back').disabled = this.viewStart <= this.origin;
    $('timeline-forward').disabled = this.follow || this.viewStart >= maxStart;
    const slider = $('timeline-scrub'); slider.max = String(maxStart - this.origin); slider.value = String(this.viewStart - this.origin); slider.disabled = maxStart === this.origin;
    $('timeline-range').textContent = `${elapsed(this.viewStart - this.origin)} – ${elapsed(end - this.origin)}`;
    const axis = $('timeline-axis'); axis.replaceChildren();
    const ticks = this.plot.clientWidth < 500 ? 3 : 6;
    for (let i = 0; i <= ticks; i++) {
      const tick = document.createElement('span'); tick.textContent = elapsed(this.viewStart - this.origin + this.windowMs * i / ticks);
      tick.style.left = `${i / ticks * 100}%`; axis.append(tick);
    }
    const xNow = (now - this.viewStart) / this.windowMs * 100;
    $('timeline-now').hidden = xNow < 0 || xNow > 100;
    $('timeline-now').style.left = `${clamp(xNow, 0, 100)}%`;
    $('timeline-now').firstElementChild.style.left = xNow > 90 ? '-30px' : xNow < 10 ? '4px' : '-13px';
    const visible = new Set(); const laneCounts = {};
    for (const item of this.items.values()) {
      if (item.end < this.viewStart || item.start > end) continue;
      visible.add(item.id); laneCounts[item.track] = (laneCounts[item.track] ?? 0) + 1;
      const button = this.nodes.get(item.id) ?? this.makeNode(item);
      const point = item.end === item.start;
      const left = clamp((item.start - this.viewStart) / this.windowMs * 100, 0, 100);
      const right = clamp((item.end - this.viewStart) / this.windowMs * 100, 0, 100);
      button.style.left = `${left}%`; button.style.width = point ? '8px' : `max(8px, ${right - left}%)`;
      button.classList.toggle('point', point); button.classList.toggle('selected', this.selected === item.id);
      button.classList.toggle('active', Boolean(item.active && now - item.end < 500));
      button.classList.toggle('operator-text', item.role === 'operator');
      button.classList.toggle('live-text', item.role === 'intermediary');
      button.classList.toggle('uncertain', item.state === 'uncertain');
      button.classList.toggle('commentary', item.kind === 'commentary');
      button.dataset.role = item.role ?? ''; button.dataset.state = item.state ?? '';
      button.firstChild.textContent = this.itemLabel(item);
      button.setAttribute('aria-label', `${tracks[item.track]}. ${this.itemLabel(item)}. ${this.timing(item)}`);
    }
    for (const [id, node] of this.nodes) if (!visible.has(id)) { node.remove(); this.nodes.delete(id); }
    for (const track of Object.keys(tracks)) this.plot.querySelector(`[data-lane="${track}"] .lane-empty`).hidden = Boolean(laneCounts[track]);
    $('timeline-empty').hidden = this.items.size > 0;
    const inspecting = this.selected ?? this.hovered;
    if (inspecting && this.items.has(inspecting)) this.showDetails(this.items.get(inspecting));
  }
}
