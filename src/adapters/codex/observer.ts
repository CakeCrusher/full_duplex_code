import fs from 'node:fs';
import path from 'node:path';
import type { ObservationKind, TurnState } from '../../core/adapter.ts';
import { AgentObserver, type Logger } from '../../core/agent-observer.ts';
import { observation as makeObservation } from '../../core/observation.ts';
import { TranscriptTail } from '../../core/transcript-tail.ts';
import { codexProfile } from './profile.ts';
import { codexContext } from './context.ts';
import { receivedRequest } from './delivery.ts';

// What each Codex hook is, in the core's terms. Other hooks are ordinary events.
const KINDS = new Map<string, ObservationKind>([
  ['UserPromptSubmit', 'prompt'], ['PreToolUse', 'tool'], ['PostToolUse', 'tool'], ['PermissionRequest', 'attention'],
  ['Stop', 'turn_end'], ['Interrupt', 'turn_end'], ['SessionEnd', 'session_end'],
]);
// Hooks that name the running turn, and hooks that end it.
const IN_TURN = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest']);
const ENDS_TURN = new Set(['Stop', 'Interrupt']);
const eventName = (data: Record<string, any>): string => data.hook_event_name ?? 'transcript';
// The final message, once it has already been observed as a transcript message.
const SEEN_FINAL = '(the assistant message above)';

export function observationKind(data: Record<string, any>): ObservationKind {
  if (data.source === 'transcript') return data.type === 'UserMessage' ? 'prompt' : 'text';
  return KINDS.get(eventName(data)) ?? 'event';
}

// Codex's turn as recorded in context. Subagent events never end or start the main turn.
export function nextTurnState(state: TurnState, data: Record<string, any>): TurnState {
  if (data.agent_id || data.source === 'transcript') return state;
  const name = eventName(data);
  if (name === 'UserPromptSubmit' || name === 'PreToolUse') return 'working';
  if (name === 'PermissionRequest') return 'needs_operator';
  if (ENDS_TURN.has(name)) return 'turn_finished';
  if (name === 'SessionEnd') return 'exited';
  return state;
}

// A text as Codex's transcript stores it: a list of typed parts.
const joined = (content: unknown) => Array.isArray(content) ? content.filter(part => typeof part?.text === 'string').map(part => part.text).join('') : '';

// Recent texts, so the same message seen twice (hook and transcript) counts once.
class Recent {
  items: string[] = [];
  has(text: string) { return this.items.includes(text); }
  add(text: string) { this.items.push(text); if (this.items.length > 64) this.items.shift(); }
}

// Translates Codex's command hooks (actions, prompts, turn ends, session ID and
// transcript path) and its transcript (assistant messages, steered input) into
// shared Observations, conversation and state.
export class CodexObserver extends AgentObserver {
  sessionId?: string;
  turn: TurnState = 'unknown';
  /** The running turn's ID, from the hooks that name it. */
  activeTurn: string | null = null;
  transcriptPath?: string; tail?: TranscriptTail; stopTimer?: NodeJS.Timeout;
  prompts = new Recent(); replies = new Recent();
  // The last final message that a Stop hook carried in full.
  finalInStop?: string;
  constructor({ sessionId, clean = String, log = () => {} }: { sessionId?: string; clean?: (text: string) => string; log?: Logger }) {
    super({ agent: { profile: codexProfile, context: codexContext, receivedRequest }, clean, log });
    this.sessionId = sessionId;
  }
  observe(data: Record<string, any>, emit = true) {
    this.turn = nextTurnState(this.turn, data);
    this.add(makeObservation({ kind: observationKind(data), name: data.source === 'transcript' ? data.type : eventName(data), text: this.clean(JSON.stringify(data)), at: Date.now(), state: this.turn, child: Boolean(data.agent_id) }), emit);
  }
  attachTranscript(file: string, resumed: boolean) {
    if (this.transcriptPath === file || !path.isAbsolute(file)) return;
    this.transcriptPath = file;
    this.log({ type: 'agent.transcript', file, resumed });
    this.tail?.stop();
    // A resumed session's earlier messages are history: seed the conversation
    // with them, then follow only what Codex adds from now on.
    if (resumed) {
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) { try { if (line) this.record(JSON.parse(line), { emit: false }); } catch {} }
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('fault', err); }
    }
    this.tail = new TranscriptTail(file, record => this.record(record), error => this.emit('fault', error), { intervalMs: 100 });
    this.tail.start({ fromEnd: resumed });
  }
  record(line: Record<string, any>, { emit = true } = {}) {
    const payload = line.payload;
    if (line.type !== 'event_msg' || payload?.type !== 'item_completed' || (payload.thread_id && this.sessionId && payload.thread_id !== this.sessionId)) return;
    const item = payload.item ?? {};
    const text = this.clean(joined(item.content));
    if (!text) return;
    if (item.type === 'AgentMessage') {
      // A final message that a Stop hook already carried is not observed twice.
      if (!(emit && this.finalInStop === text)) this.observe({ source: 'transcript', type: 'AgentMessage', phase: item.phase, turn_id: payload.turn_id, text }, emit);
      if (!this.replies.has(text)) { this.replies.add(text); this.textDelta(text, { source: 'transcript' }, emit); }
    }
    if (item.type === 'UserMessage') {
      // Typed and queued prompts also arrive as a hook; steered input only here.
      if (emit && this.prompts.has(text)) return;
      this.prompts.add(text);
      this.observe({ source: 'transcript', type: 'UserMessage', turn_id: payload.turn_id, text }, emit);
      this.input(text, { source: 'transcript' }, emit);
    }
  }
  /** Takes the session Codex named, unless one is known already. */
  adopt(id: string) {
    if (this.sessionId !== undefined) return;
    this.sessionId = id; this.log({ type: 'agent.session', sessionId: id }); this.emit('session', id);
  }
  override hook(event: Record<string, any>): boolean {
    // Codex chooses the session ID. The adapter usually learns it as the
    // terminal loads its thread; if not (a new session in Codex 0.155), the
    // first hook names it. Only this Codex process runs the companion's hooks.
    if (typeof event.session_id === 'string' && event.session_id) this.adopt(event.session_id);
    if (event.session_id !== this.sessionId) return false;
    event = JSON.parse(this.clean(JSON.stringify(event)));
    const name = event.hook_event_name;
    if (event.transcript_path && !event.agent_id) this.attachTranscript(event.transcript_path, name === 'SessionStart' && event.source === 'resume');
    this.log({ type: 'agent.hook', name, ...event });
    if (name === 'Stop' && typeof event.last_assistant_message === 'string') {
      const final = event.last_assistant_message;
      // Observed once: here in full, unless the transcript already brought it.
      const seen = this.replies.has(final);
      this.finalInStop = seen ? undefined : final;
      this.observe(seen ? { ...event, last_assistant_message: SEEN_FINAL } : event);
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        if (final && !this.replies.has(final)) { this.replies.add(final); this.textDelta(final, { source: 'stop_hook' }); }
      }, 300);
    } else this.observe(event);
    // Subagent events belong in context, but not in the main turn's status.
    if (event.agent_id) return true;
    if (IN_TURN.has(name) && event.turn_id) this.activeTurn = event.turn_id;
    if (ENDS_TURN.has(name) && (!event.turn_id || event.turn_id === this.activeTurn)) this.activeTurn = null;
    if (name === 'SessionStart') this.status('idle', 'Codex is ready');
    if (name === 'UserPromptSubmit') {
      if (!this.prompts.has(event.prompt ?? '')) { this.prompts.add(event.prompt ?? ''); this.input(event.prompt, { source: 'prompt_hook' }); }
      this.status('working', 'Codex received a prompt');
    }
    if (name === 'PreToolUse') this.status('working', `Codex is using ${event.tool_name}`);
    if (name === 'PostToolUse') this.status('working', `Codex finished ${event.tool_name}`);
    if (name === 'PermissionRequest') this.status('needs_attention', `${event.tool_name} needs approval in the Codex terminal`);
    if (name === 'Stop') this.status('idle', 'Codex finished responding');
    if (name === 'Interrupt') this.status('idle', 'Codex was interrupted');
    if (name === 'SessionEnd') this.status('exited', 'Codex session ended');
    return true;
  }
  override close() { clearTimeout(this.stopTimer); this.tail?.stop(); }
}
