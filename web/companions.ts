import type { CompanionSummary as Companion } from '../src/core/companions.ts';

// Every running companion, to switch between them in this tab: its folder, agent, session ID and state,
// refreshed every few seconds. Switching never leaves a page and never ends the voice it runs.
const LABELS = { voice: 'Voice on', standby: 'Standby', starting: 'Starting voice', ready: 'Ready', notReady: 'Not ready', waiting: 'Agent not connected', unreachable: 'Unreachable' };
const AGENT_STATES: Record<string, string> = { starting: 'starting', idle: 'ready for a request', working: 'working', needs_attention: 'needs your attention', failed: 'reported an error', exited: 'session ended' };
// Ready only when its voice could start: its agent connected and a page with the microphone allowed and clicked.
const stateOf = (c: Companion): keyof typeof LABELS => !c.reachable ? 'unreachable' : c.voice === 'active' ? 'voice' : c.voice === 'standby' ? 'standby' : c.voice === 'connecting' ? 'starting' : !c.agentReady ? 'waiting' : c.blocked ? 'notReady' : 'ready';
// What a companion that is not ready lacks, in a few words.
const lacks = (blocked: string) => /no page/.test(blocked) ? 'No page open' : /blocked from/.test(blocked) ? 'Microphone blocked' : /not been allowed/.test(blocked) ? 'Microphone not allowed' : /not been clicked/.test(blocked) ? 'Needs a click' : 'Not ready';

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
  if (c.voice === 'none' && c.blocked) parts.push(`voice can't start by voice: ${c.blocked}`);
  return parts.join(' · ');
}
/** What the list shows of a companion: under its folder, its agent, session ID and state; on hovering it, the details. */
export function shown(c: Companion) {
  const state = stateOf(c);
  return { state, meta: [c.agent, c.sessionId, state === 'notReady' ? lacks(c.blocked!) : LABELS[state]].filter(Boolean).join(' · '), hover: details(c) };
}
/** The same in one line: how fdc's voice tool reads each session, as the operator sees it (sessions.ts). */
export function shownLine(c: Companion) {
  const { meta, hover } = shown(c);
  return `${[c.folder, c.public ? 'Public' : '', meta].filter(Boolean).join(' · ')} (${hover})`;
}
function chip(c: Companion, show: (c: Companion) => void) {
  const { state, meta, hover } = shown(c), button = element('button', 'companion');
  button.type = 'button'; button.dataset.companion = c.id; button.dataset.state = state; button.title = hover;
  const name = element('span', 'companion-name');
  name.append(element('i', 'companion-dot'), element('strong', '', c.folder));
  if (c.public) name.append(element('b', 'companion-public', 'Public'));
  button.append(name, element('span', 'companion-meta', meta));
  if (c.current) button.setAttribute('aria-current', 'page');
  // The link holds the other page's token: it is loaded from here rather than shown as an address on hover.
  if (c.current || (c.link && c.reachable)) button.onclick = () => show(c);
  else button.disabled = true;
  return button;
}

// Other companions' pages, each loaded once into this tab and shown in place of this one's. A hidden page keeps
// running: its voice, if on, keeps listening and talking, so several sessions can talk in one tab at once.
class Frames {
  box = element('div', 'companion-frames'); frames = new Map<string, HTMLIFrameElement>(); shown: string | null = null;
  nav: HTMLElement;
  constructor(nav: HTMLElement) {
    this.nav = nav; this.box.hidden = true; nav.after(this.box);
    // Hidden until shown, but listening for others from the start; so any session can be turned on by voice.
    addEventListener('resize', () => { if (this.shown) this.place(); });
  }
  // Below the list of companions, over the rest of this page.
  place() { scrollTo(0, 0); document.documentElement.style.setProperty('--frames-top', `${Math.ceil(this.nav.getBoundingClientRect().bottom + 6)}px`); }
  load(c: Companion) {
    let frame = this.frames.get(c.id);
    if (!frame && c.link && c.reachable) {
      frame = element('iframe', 'companion-frame');
      // The tab's click and microphone carry over to the pages inside it.
      frame.title = `${c.folder} · ${c.agent}`; frame.allow = 'microphone; autoplay'; frame.src = c.link; frame.hidden = c.id !== this.shown;
      this.frames.set(c.id, frame); this.box.append(frame);
    }
    return frame;
  }
  show(c: Companion) {
    if (c.current) { this.shown = null; this.box.hidden = true; document.body.classList.remove('showing-companion'); return; }
    if (!this.load(c)) return;
    for (const [id, f] of this.frames) f.hidden = id !== c.id;
    this.shown = c.id; this.place(); this.box.hidden = false; document.body.classList.add('showing-companion');
  }
  /** A companion that stopped takes its page with it; this one's page shows again if it was shown. */
  keep(running: Companion[]) {
    for (const c of running) if (!c.current) this.load(c);
    for (const [id, frame] of this.frames) if (!running.some(c => c.id === id && c.reachable)) {
      frame.remove(); this.frames.delete(id);
      if (this.shown === id) this.show(running.find(c => c.current)!);
    }
  }
}

export function mountCompanions(nav: HTMLElement, token: string | null) {
  // Shown inside another companion's tab: that tab's list switches between them.
  if (!token || window !== window.top) return;
  const list = element('div', 'companion-list'), hint = element('p', 'companions-hint', 'All open in this tab. A session whose voice is on keeps listening and talking while another is shown.');
  nav.replaceChildren(element('span', 'companions-label', 'Running companions'), list, hint);
  const frames = new Frames(nav);
  let listed = '', busy = false, companions: Companion[] = [];
  const mark = () => { for (const button of list.querySelectorAll<HTMLElement>('[data-companion]')) button.toggleAttribute('data-shown', button.dataset.companion === (frames.shown ?? companions.find(c => c.current)?.id)); };
  const show = (c: Companion) => { frames.show(c); mark(); };
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch('/api/companions', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      companions = (await response.json()).companions;
      frames.keep(companions);
      const serialized = JSON.stringify(companions);
      if (serialized === listed) return;
      listed = serialized; nav.hidden = !companions.some(c => !c.current); hint.hidden = nav.hidden;
      // Keep keyboard focus on the same companion across refreshes.
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.companion;
      const first = !list.children.length;
      list.replaceChildren(...companions.map(c => chip(c, show))); mark();
      if (focused) list.querySelector<HTMLElement>(`[data-companion="${focused}"]`)?.focus();
      // On a narrow screen the list scrolls sideways: start with this companion in view.
      const current = list.querySelector('[aria-current]');
      if (first && current) list.scrollLeft += current.getBoundingClientRect().left - list.getBoundingClientRect().left - 8;
    } catch {} finally { busy = false; }
  }
  setInterval(refresh, 3000);
  refresh();
}
