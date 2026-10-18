import type { BridgeEvent } from './bridge-client.js';
import { profile } from './profile.js';

// Buttons, captions, the prompt panel and notices: everything the page shows
// outside the timeline.
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const { name } = profile;
let instructionHistory = '';

export function notice(text: string) { $('notice').textContent = text; }
/** Whether Start continues the earlier conversation: Resume voice. */
export const resumable = (event?: BridgeEvent) => Boolean(event?.resume && event.resume.plan !== 'fresh');
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// Local or public link, the last time voice ended on its own and whether it reconnected, and how Resume works.
function showConnection({ connection, resume }: BridgeEvent) {
  const drop = connection?.lastDrop;
  const facts = [local ? 'Local link' : 'Public link (tunnel)',
    drop && `Last drop ${clock(drop.at)}: ${drop.reason}${drop.reconnecting ? ', reconnecting automatically' : ''}`,
    connection?.reconnects && `${connection.reconnects} automatic reconnect${connection.reconnects === 1 ? '' : 's'} in 5 min (at most 2)`,
    resume && !resume.store && 'Voice sessions aren’t stored, so Resume continues from the conversation’s text'].filter(Boolean).join(' · ');
  if ($('connection-facts').textContent !== facts) $('connection-facts').textContent = facts;
}

// Developer mode adds the diagnostic parts of the page. Each browser remembers
// the choice; without storage it simply starts off.
export function developerMode() {
  const toggle = $<HTMLInputElement>('developer-mode');
  const show = (on: boolean) => { document.body.classList.toggle('developer', on); toggle.checked = on; };
  let saved = false;
  try { saved = localStorage.getItem('fd-developer-mode') === 'on'; } catch {}
  show(saved);
  toggle.onchange = () => {
    show(toggle.checked);
    try { localStorage.setItem('fd-developer-mode', toggle.checked ? 'on' : 'off'); } catch {}
  };
}

// The bridge's status, sent every second and on change.
// Which session this page belongs to, at the top and in the tab title, so that
// several companions open at once can be told apart.
function showSession(cwd: string, sessionId?: string) {
  const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd, id = sessionId?.slice(0, 8);
  const meta = [profile.product, id && `session ${id}`, cwd].filter(Boolean).join(' · ');
  if ($('session-name').textContent !== folder) $('session-name').textContent = folder;
  if ($('session-meta').textContent !== meta) { $('session-meta').textContent = meta; $('session-meta').title = sessionId ? `Session ${sessionId}` : ''; }
  const title = [folder, profile.product, id, 'Full-Duplex Code'].filter(Boolean).join(' · ');
  if (document.title !== title) document.title = title;
}
export function showStatus(event: BridgeEvent, voice: { active: boolean; muted: boolean; starting: boolean; standby: boolean; waking: boolean; elsewhere: boolean }) {
  if (event.prompt) {
    const texts: Record<string, string> = {
      'prompt-state': ({ preview: 'Next voice session · startup preview', session: 'Current voice session · startup instructions', previous: 'Last voice session · startup instructions' } as Record<string, string>)[event.prompt.mode],
      'prompt-instructions': event.prompt.instructions,
    };
    // Preserve text selection while the regular status updates arrive.
    for (const [id, text] of Object.entries(texts)) if ($(id).textContent !== text) $(id).textContent = text;
    // Acknowledged and saved instructions are part of the prompt text above; only those in flight or failed are listed.
    const additional: { state: string; text: string; error?: string }[] = (event.prompt.additional ?? []).filter((item: { state: string }) => item.state === 'pending' || item.state === 'failed');
    const serialized = JSON.stringify(additional);
    if (serialized !== instructionHistory) {
      instructionHistory = serialized;
      $('instruction-history').replaceChildren(...additional.map(item => {
        const article = document.createElement('article');
        const state = document.createElement('strong');
        state.textContent = ({ pending: 'Applying…', acknowledged: 'Live acknowledged', failed: 'Not confirmed', next_session: 'Saved for next voice session' } as Record<string, string>)[item.state];
        const text = document.createElement('pre'); text.textContent = item.text;
        article.append(state, text);
        if (item.error) { const error = document.createElement('p'); error.textContent = item.error; article.append(error); }
        return article;
      }));
    }
    $<HTMLButtonElement>('instruction-append').disabled = ['new', 'connecting', 'closing'].includes(event.live) || additional.some(item => item.state === 'pending');
  }
  const delivery = event.contextDelivery ?? { waiting: 0, inFlight: 0 };
  $('context-delivery').textContent = event.live !== 'active' ? `${name} observations stay saved while voice is off.`
    : delivery.observationsWaiting ? `${delivery.observationsWaiting} ${profile.eventsWord} being combined · oldest ${(delivery.oldestObservationMs / 1000).toFixed(1)}s · estimated API backlog ${delivery.estimatedBacklogSeconds.toFixed(1)}s. Full observations remain saved.`
    : delivery.waiting ? `${delivery.waiting} context fragments waiting · sending in order, including during speech. All observations remain saved.`
    : delivery.inFlight ? `All context sent · ${delivery.inFlight} fragment${delivery.inFlight === 1 ? '' : 's'} awaiting Live’s acknowledgment.` : 'No context waiting to be sent.';
  $('connection').textContent = voice.active ? voice.muted ? 'Microphone muted' : 'Listening'
    : voice.waking ? 'Waking…' : voice.standby ? voice.muted ? 'Standby · microphone muted' : 'Standby · speak to wake it'
    : voice.elsewhere ? 'Voice is on in another tab or device' : event.agentReady ? 'Agent connected' : `Waiting for ${name}`;
  $('agentState').textContent = ({ starting: 'Starting in your terminal', idle: 'Ready for your next request', working: 'Working', needs_attention: 'Needs your attention in the terminal', failed: 'Reported an error', exited: 'Session ended' } as Record<string, string>)[event.agent] ?? event.agent;
  // Voice running in another page (or on Standby there) can be moved here; one still connecting or closing cannot.
  const movable = voice.elsewhere && (event.live === 'active' || Boolean(event.standby));
  // On Standby, Start wakes voice at once.
  const wakeable = voice.standby && !voice.waking;
  $<HTMLButtonElement>('start').disabled = !wakeable && (voice.starting || voice.active || voice.waking || !event.agentReady || ['connecting', 'closing'].includes(event.live) || (event.live === 'active' && !movable) || event.agent === 'exited');
  // Resume voice continues the conversation; Start fresh starts without it.
  const resume = !movable && !voice.standby && resumable(event);
  $('start').textContent = wakeable || voice.waking ? 'Wake now' : movable ? 'Move voice here' : resume ? 'Resume voice' : 'Start voice';
  $('start').title = wakeable ? 'Reconnects voice now; speaking does too' : resume ? event.resume.plan === 'fork' ? 'Continues the last voice session where it left off' : 'Starts voice with the conversation so far' : '';
  $('fresh').hidden = !resume; $<HTMLButtonElement>('fresh').disabled = $<HTMLButtonElement>('start').disabled;
  showConnection(event);
  $('project').textContent = event.cwd;
  showSession(event.cwd, event.sessionId);
  $('usage').textContent = voice.active ? `${Math.floor(event.usageSeconds / 60)}m ${event.usageSeconds % 60}s · $${(event.usageSeconds * 0.05 / 60).toFixed(3)}` : voice.standby ? 'Standby · not billed' : 'Not connected · $0.05/min';
  $('budget').textContent = `Estimated total $${event.committedUsd.toFixed(2)} · includes unfinished sessions`;
}

// The page is for talking: until Chrome has granted it the microphone, a modal covers everything else.
// Chrome remembers the grant per address (a companion on a new port asks again). Granting it is also
// the click Chrome wants before the page may play sound, so another companion can then turn voice on here.
const TEXT = {
  ask: ['Allow the microphone', 'Full-Duplex Code needs your microphone before anything else. When Chrome asks, choose "Allow while visiting the site" so it remembers; "Allow this time" asks again on every visit.', 'Allow microphone'],
  waiting: ['Allow the microphone', 'Choose Allow in the box Chrome shows near the address bar.', 'Waiting for Chrome…'],
  denied: ['The microphone is blocked', 'Chrome has blocked the microphone for this page. Click the icon at the left of the address bar, set Microphone to Allow, then click Try again.', 'Try again'],
  missing: ['No microphone found', 'Chrome found no microphone. Connect one, then click Try again.', 'Try again'],
} as const;

/** Whether this page has opened the microphone: Chrome's "Allow this time" works for the visit while the permission still reads "prompt". */
export const microphone = { opened: false };
export function requireMicrophone(onGranted: () => void) {
  const dialog = document.createElement('dialog'), title = document.createElement('h2'), text = document.createElement('p'), button = document.createElement('button');
  dialog.className = 'microphone-gate'; dialog.setAttribute('aria-labelledby', 'microphone-gate-title'); title.id = 'microphone-gate-title';
  dialog.append(title, text, button); document.body.append(dialog);
  // It can't be dismissed: Escape does nothing until the microphone is granted.
  dialog.addEventListener('cancel', event => event.preventDefault());
  const show = (state: keyof typeof TEXT) => {
    [title.textContent, text.textContent, button.textContent] = TEXT[state];
    button.disabled = state === 'waiting';
    if (!dialog.open) dialog.showModal();
  };
  let done = false;
  const granted = () => { if (done) return; done = true; dialog.close(); dialog.remove(); onGranted(); };
  button.onclick = async () => {
    show('waiting');
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(track => track.stop()); microphone.opened = true; granted(); }
    catch (error) { show((error as Error).name === 'NotFoundError' ? 'missing' : 'denied'); }
  };
  const check = async () => {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      status.onchange = () => { if (status.state === 'granted') granted(); else if (!done) show(status.state === 'denied' ? 'denied' : 'ask'); };
      if (status.state === 'granted') return granted();
      show(status.state === 'denied' ? 'denied' : 'ask');
    } catch { show('ask'); } // Without the Permissions API, asking is the only way to know.
  };
  check();
}
