import type { BridgeEvent } from './bridge-client.js';
import { profile } from './profile.js';

// Buttons, captions, the prompt panel and notices: everything the page shows
// outside the timeline.
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const { name } = profile;
const speakingNames = ['Quiet', 'Milestones'];
const speakingDescriptions = [`Answer you and confirm sent requests. Observe ${name} silently.`, 'Default: meaningful outcomes, major changes, and decisions you must make. Complete thoughts, without running commentary. Your spoken requests come first.'];
let instructionHistory = '';

export function notice(text: string) { $('notice').textContent = text; }
export function showSpeaking(level: number) {
  $<HTMLInputElement>('speaking-level').value = String(level);
  $('speaking-level').setAttribute('aria-valuetext', speakingNames[level]);
  $('speaking-label').textContent = speakingNames[level];
  $('speaking-description').textContent = speakingDescriptions[level];
}
export function showSpeakingUpdate(update: { state: string; level?: number; confirmedLevel?: number; source?: string; error?: string }) {
  const name = speakingNames[update.level!];
  const confirmed = speakingNames[update.confirmedLevel!];
  const states: Record<string, [string, string]> = {
    next_session: [`Next session · ${name}`, 'This preference will be included when you start voice.'],
    starting: [`Waiting for session · ${name}`, 'The voice connection has not confirmed this preference yet.'],
    pending: [`Applying · ${name}…`, `Waiting for Live’s acknowledgment.${confirmed ? ` Last confirmed: ${confirmed}.` : ''}`],
    acknowledged: [update.source === 'startup' ? `Active from session start · ${name}` : `Live acknowledged · ${name}`, 'The instructions are confirmed for this conversation. This does not guarantee when speech will reflect them.'],
    failed: [`Not confirmed · ${name}`, `${update.error ?? 'The update failed.'} Select the mode again to retry.`],
    disconnected: ['Disconnected', 'Reconnect before changing the speaking preference.'],
  };
  const [label, detail] = states[update.state] ?? states.next_session;
  $('updates-state').textContent = label; $('updates-state').dataset.state = update.state;
  $('updates-detail').textContent = detail;
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
export function showStatus(event: BridgeEvent, voice: { active: boolean; muted: boolean; starting: boolean; elsewhere: boolean }) {
  if (event.prompt) {
    const texts: Record<string, string> = {
      'prompt-state': ({ preview: 'Next voice session · startup preview', session: 'Current voice session · startup instructions', previous: 'Last voice session · startup instructions' } as Record<string, string>)[event.prompt.mode],
      'prompt-instructions': event.prompt.instructions,
      'prompt-preference': event.prompt.speakingPreference,
    };
    // Preserve text selection while the regular status updates arrive.
    for (const [id, text] of Object.entries(texts)) if ($(id).textContent !== text) $(id).textContent = text;
    const additional: { state: string; text: string; error?: string }[] = event.prompt.additional ?? [];
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
  if (document.activeElement !== $('speaking-level')) showSpeaking(event.speakingLevel ?? 1);
  showSpeakingUpdate(event.speakingUpdate ?? { state: 'next_session', level: event.speakingLevel ?? 1 });
  $<HTMLInputElement>('confirm-deliveries').checked = event.confirmDeliveries !== false;
  const delivery = event.contextDelivery ?? { waiting: 0, inFlight: 0 };
  $('context-delivery').textContent = event.live !== 'active' ? `${name} observations stay saved while voice is off.`
    : delivery.observationsWaiting ? `${delivery.observationsWaiting} ${profile.eventsWord} being combined · oldest ${(delivery.oldestObservationMs / 1000).toFixed(1)}s · estimated API backlog ${delivery.estimatedBacklogSeconds.toFixed(1)}s. Full observations remain saved.`
    : delivery.waiting ? `${delivery.waiting} context fragments waiting · sending in order, including during speech. All observations remain saved.`
    : delivery.inFlight ? `All context sent · ${delivery.inFlight} fragment${delivery.inFlight === 1 ? '' : 's'} awaiting Live’s acknowledgment.` : 'No context waiting to be sent.';
  $('connection').textContent = voice.active ? voice.muted ? 'Microphone muted' : 'Listening' : voice.elsewhere ? 'Voice is on in another tab or device' : event.agentReady ? 'Agent connected' : `Waiting for ${name}`;
  $('agentState').textContent = ({ starting: 'Starting in your terminal', idle: 'Ready for your next request', working: 'Working', needs_attention: 'Needs your attention in the terminal', failed: 'Reported an error', exited: 'Session ended' } as Record<string, string>)[event.agent] ?? event.agent;
  // Voice running in another page can be moved here; one still connecting or closing cannot.
  const movable = voice.elsewhere && event.live === 'active';
  $<HTMLButtonElement>('start').disabled = voice.starting || voice.active || !event.agentReady || ['connecting', 'closing'].includes(event.live) || (event.live === 'active' && !movable) || event.agent === 'exited';
  $('start').textContent = movable ? 'Move voice here' : 'Start voice';
  $('project').textContent = event.cwd;
  showSession(event.cwd, event.sessionId);
  $('usage').textContent = voice.active ? `${Math.floor(event.usageSeconds / 60)}m ${event.usageSeconds % 60}s · $${(event.usageSeconds * 0.05 / 60).toFixed(3)}` : 'Not connected · $0.05/min';
  $('budget').textContent = `Estimated total $${event.committedUsd.toFixed(2)} · includes unfinished sessions`;
}
