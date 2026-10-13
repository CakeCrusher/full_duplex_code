import type { CompanionSummary as Companion } from '../src/core/companions.ts';

// Every running companion, to switch between them: its folder, agent and state,
// refreshed while the page is visible. Each companion has a tab of its own, so
// switching never leaves a page and never ends the voice it runs.
const LABELS = { voice: 'Voice on', starting: 'Starting voice', ready: 'Ready', waiting: 'Agent not connected', unreachable: 'Unreachable' };
const AGENT_STATES: Record<string, string> = { starting: 'starting', idle: 'ready for a request', working: 'working', needs_attention: 'needs your attention', failed: 'reported an error', exited: 'session ended' };
const stateOf = (c: Companion): keyof typeof LABELS => !c.reachable ? 'unreachable' : c.voice === 'active' ? 'voice' : c.voice === 'connecting' ? 'starting' : c.agentReady ? 'ready' : 'waiting';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function details(c: Companion) {
  if (!c.reachable) return 'Not answering: it may be busy or have stopped.';
  const started = new Date(c.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const parts = [`${c.agent} ${AGENT_STATES[c.agentState ?? ''] ?? c.agentState ?? ''}`.trim(), `${c.pages} page${c.pages === 1 ? '' : 's'} open`, `started ${started}`];
  if (!c.current && !c.link) parts.push('open it on the computer running it');
  return parts.join(' · ');
}
function chip(c: Companion) {
  const state = stateOf(c), button = element('button', 'companion');
  button.type = 'button'; button.dataset.companion = c.id; button.dataset.state = state; button.title = details(c);
  const name = element('span', 'companion-name');
  name.append(element('i', 'companion-dot'), element('strong', '', c.folder));
  if (c.public) name.append(element('b', 'companion-public', 'Public'));
  button.append(name, element('span', 'companion-meta', [c.agent, c.sessionId, LABELS[state]].filter(Boolean).join(' · ')));
  // The link holds the other page's token: open it from here rather than show it as an address on hover.
  if (c.current) button.setAttribute('aria-current', 'page');
  else if (c.link && c.reachable) { const link = c.link; button.onclick = () => openCompanion(c.id, link); }
  else button.disabled = true;
  return button;
}

// Brings the companion's own tab forward, opening it the first time. An open one is another
// origin, unreadable from here; it is left as it is (reloading it would end its voice).
function openCompanion(id: string, link: string) {
  const tab = window.open('', tabName(id));
  if (!tab) return location.assign(link);
  try { if (tab.location.href === 'about:blank') tab.location.href = link; } catch {}
  tab.focus();
}
const tabName = (id: string) => `fdc-companion-${id}`;

export function mountCompanions(nav: HTMLElement, token: string | null, voiceHere: () => boolean) {
  if (!token) return;
  const list = element('div', 'companion-list'), hint = element('p', 'companions-hint', 'Each opens in its own tab; voice here keeps running.');
  nav.replaceChildren(element('span', 'companions-label', 'Running companions'), list, hint);
  let shown = '', others = false, busy = false;
  const showHint = () => { hint.hidden = !(others && voiceHere()); };
  async function refresh() {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const response = await fetch('/api/companions', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const { companions }: { companions: Companion[] } = await response.json(), serialized = JSON.stringify(companions);
      if (serialized === shown) return;
      shown = serialized; others = companions.some(c => !c.current); nav.hidden = !others;
      // Keep keyboard focus on the same companion across refreshes.
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.companion;
      const first = !list.children.length;
      list.replaceChildren(...companions.map(chip));
      // This tab is this companion's: switching from another one brings it forward.
      const self = companions.find(c => c.current); if (self) window.name = tabName(self.id);
      if (focused) list.querySelector<HTMLElement>(`[data-companion="${focused}"]`)?.focus();
      // On a narrow screen the list scrolls sideways: start with this companion in view.
      const current = list.querySelector('[aria-current]');
      if (first && current) list.scrollLeft += current.getBoundingClientRect().left - list.getBoundingClientRect().left - 8;
      showHint();
    } catch {} finally { busy = false; }
  }
  setInterval(refresh, 3000); setInterval(showHint, 1000);
  document.addEventListener('visibilitychange', refresh);
  refresh();
}
