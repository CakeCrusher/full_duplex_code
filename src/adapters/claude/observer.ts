import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ObservationKind, TurnState } from '../../core/adapter.ts';
import { AgentObserver, type Logger } from '../../core/agent-observer.ts';
import { observation as makeObservation } from '../../core/observation.ts';
import { TranscriptTail } from '../../core/transcript-tail.ts';
import { claudeProfile } from './profile.ts';
import { claudeContext } from './context.ts';

// What each hook is, in the core's terms. Other hooks are ordinary events.
const KINDS = new Map<string, ObservationKind>([
  ['UserPromptSubmit', 'prompt'], ['MessageDisplay', 'text'],
  ['PreToolUse', 'tool'], ['PostToolUse', 'tool'], ['PostToolBatch', 'tool'], ['PostToolUseFailure', 'tool_failure'],
  ['PermissionRequest', 'attention'], ['PermissionDenied', 'attention'], ['Elicitation', 'attention'],
  ['Stop', 'turn_end'], ['StopFailure', 'turn_failed'], ['TaskCompleted', 'task_completed'], ['SessionEnd', 'session_end'],
]);
const eventName = (data: Record<string, any>): string => data.hook_event_name ?? data.source ?? 'transcript';

export function observationKind(data: Record<string, any>): ObservationKind {
  const name = eventName(data);
  // Restored transcript blocks: conversation text is prose; tool blocks are detail.
  if (name === 'transcript') return ['user', 'assistant'].includes(data.role) && data.block?.type === 'text' ? 'text' : 'tool';
  return KINDS.get(name) ?? 'event';
}

// Claude's turn as recorded in context. Subagent lifecycle never ends or
// starts the main turn.
export function nextTurnState(state: TurnState, data: Record<string, any>): TurnState {
  if (data.agent_id) return state;
  const name = eventName(data);
  if (name === 'UserPromptSubmit' || name === 'PreToolUse') return 'working';
  if (name === 'Stop') return data.background_tasks?.length ? 'working' : 'turn_finished';
  if (name === 'PermissionRequest' || name === 'Elicitation') return 'needs_operator';
  if (name === 'StopFailure') return 'failed';
  if (name === 'SessionEnd') return 'exited';
  return state;
}

// Translates Claude's command hooks, and its transcript records on resume,
// into shared Observations, conversation and state.
export class ClaudeObserver extends AgentObserver {
  sessionId?: string; observation: string;
  seen = new Set<string>(); hookBatches = new Set<string>();
  turn: TurnState = 'unknown';
  transcriptPath?: string; tail?: TranscriptTail; stopTimer?: NodeJS.Timeout;
  constructor({ sessionId, observation = 'hooks', clean = String, log = () => {} }: { sessionId?: string; observation?: string; clean?: (text: string) => string; log?: Logger }) {
    super({ agent: { profile: claudeProfile, context: claudeContext }, clean, log });
    this.sessionId = sessionId; this.observation = observation;
  }
  observe(data: Record<string, any>, emit = true) {
    this.turn = nextTurnState(this.turn, data);
    this.add(makeObservation({ kind: observationKind(data), name: eventName(data), text: this.clean(JSON.stringify(data)), at: Date.now(), state: this.turn, child: Boolean(data.agent_id) }), emit);
  }
  attachTranscript(file: string) {
    if (this.transcriptPath === file) return;
    if (!path.isAbsolute(file) || path.basename(file) !== `${this.sessionId}.jsonl`) return;
    this.transcriptPath = file;
    this.log({ type: 'agent.transcript', file, observation: this.observation });
    if (this.observation === 'transcript') {
      this.tail?.stop();
      this.tail = new TranscriptTail(file, event => this.record(event), error => this.emit('fault', error)); this.tail.start();
    } else {
      // Seed resumed sessions with saved prompts and replies. Normal live observation
      // uses display hooks, so the two sources are never blindly merged.
      try {
        const data = fs.readFileSync(file, 'utf8');
        const records = data.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        if (!this.conversation.length) for (const record of records) this.record(record, { emit: false });
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('fault', err); }
    }
  }
  record(event: Record<string, any>, { emit = true } = {}) {
    // Claude stores channel-delivered operator prompts as metadata. They still
    // belong to this conversation; exclude only other internal metadata.
    const channelInput = event.type === 'user' && event.origin?.kind === 'channel';
    if (!['user', 'assistant'].includes(event.type) || event.isSidechain || (event.isMeta && !channelInput) || (event.sessionId && event.sessionId !== this.sessionId)) return;
    const content = event.message?.content;
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
    for (const [index, block] of blocks.entries()) {
      // Resume/fallback also restores tool calls and results. Private reasoning
      // is not part of the visible hook feed and is not imported from disk.
      if (!['text', 'tool_use', 'tool_result'].includes(block.type)) continue;
      const id = event.type === 'user' ? event.uuid ?? event.promptId ?? event.timestamp : event.message.id;
      const key = createHash('sha256').update(`${event.type}:${id}:${index}:${JSON.stringify(block)}`).digest('hex');
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.observe({ source: 'transcript', role: event.type, message_id: id, block }, emit);
      if (block.type === 'text') {
        if (event.type === 'user') this.input(block.text, { source: 'transcript' }, emit);
        else this.textDelta(block.text, { source: 'transcript' }, emit);
      }
    }
  }
  override hook(event: Record<string, any>): boolean {
    // Resuming by picker, --continue or a fork: Claude chooses the ID. Only this
    // Claude process runs the run's hooks, so its first event names the session.
    if (this.sessionId === undefined && typeof event.session_id === 'string' && event.session_id) {
      this.sessionId = event.session_id; this.log({ type: 'agent.session', sessionId: this.sessionId }); this.emit('session', this.sessionId);
    }
    if (event.session_id !== this.sessionId) return false;
    event = JSON.parse(this.clean(JSON.stringify(event)));
    const name = event.hook_event_name;
    if (name === 'MessageDisplay') {
      const key = `${event.agent_id ?? ''}:${event.message_id}:${event.index}`;
      if (this.hookBatches.has(key)) return true;
      this.hookBatches.add(key);
    }
    if (event.transcript_path) this.attachTranscript(event.transcript_path);
    this.log({ type: 'agent.hook', name, ...event });
    this.observe(event);
    // Subagent observations belong in Live context, but their lifecycle must
    // not mark the parent terminal idle or overwrite its current status.
    if (event.agent_id) return true;
    if (name === 'SessionStart') this.status('idle', 'Claude is ready');
    if (name === 'UserPromptSubmit') {
      if (this.observation === 'hooks') this.input(event.prompt, { source: 'prompt_hook' });
      this.status('working', 'Claude received a prompt');
    }
    if (name === 'MessageDisplay' && this.observation === 'hooks') {
      // Stop and the final display hook can arrive in either order. A late
      // display batch must not turn an already-idle agent back into working.
      if (this.state === 'working') this.status('working', 'Claude is responding');
      this.textDelta(event.delta, { source: 'display_hook', messageId: event.message_id, index: event.index, final: event.final });
    }
    if (name === 'PreToolUse') this.status('working', `Claude is using ${event.tool_name}`);
    if (name === 'PostToolUse') this.status('working', `Claude finished ${event.tool_name}`);
    if (name === 'PostToolUseFailure') this.status('working', `${event.tool_name} reported a failure`);
    if (name === 'PermissionRequest') this.status('needs_attention', `${event.tool_name} needs approval in the Claude terminal`);
    if (name === 'Notification' && event.notification_type === 'permission_prompt') this.status('needs_attention', 'Claude needs approval in the terminal');
    if (name === 'Stop' || name === 'StopFailure') {
      const final = this.clean(event.last_assistant_message ?? '');
      const background = event.background_tasks?.length > 0;
      this.status(name === 'StopFailure' ? 'failed' : background ? 'working' : 'idle', name === 'StopFailure' ? 'Claude reported an error' : background ? 'Background work is still running' : 'Claude finished responding');
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        if (final && !this.text.endsWith(final)) this.textDelta(final, { source: 'stop_hook' });
      }, 300);
    }
    if (name === 'SessionEnd') this.status('exited', 'Claude session ended');
    return true;
  }
  override close() { clearTimeout(this.stopTimer); this.tail?.stop(); }
}
