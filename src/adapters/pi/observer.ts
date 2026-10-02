import fs from 'node:fs';
import path from 'node:path';
import type { ObservationKind, TurnState } from '../../core/adapter.ts';
import { AgentObserver, type Logger } from '../../core/agent-observer.ts';
import { observation as makeObservation } from '../../core/observation.ts';
import { piProfile } from './profile.ts';
import { piContext } from './context.ts';
import { receivedRequest } from './message.ts';

// A message's text: Pi stores it as a string or a list of typed blocks.
export const messageText = (content: unknown) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';

// What each event is, in the core's terms. Other events are ordinary events.
export function observationKind(data: Record<string, any>, failed = false): ObservationKind {
  switch (data.type) {
    case 'input': return 'prompt';
    case 'message_end': return data.message?.role === 'assistant' ? 'text' : 'event';
    case 'tool_execution_start': return 'tool';
    case 'tool_execution_end': return data.isError ? 'tool_failure' : 'tool';
    case 'ui_prompt_start': return 'attention';
    case 'agent_settled': return failed ? 'turn_failed' : 'turn_end';
    case 'session_shutdown': return data.reason === 'quit' ? 'session_end' : 'event';
    default: return 'event';
  }
}

// Translates the events the companion's extension forwards, and Pi's session
// file on resume, into shared Observations, conversation and state.
export class PiObserver extends AgentObserver {
  sessionId?: string;
  turn: TurnState = 'unknown';
  /** An agent run is under way: from agent_start until agent_settled. */
  running = false;
  /** How the run's last assistant message ended: an error makes a failed turn, unless Pi retries. */
  lastStop?: string;
  restored = new Set<string>();
  constructor({ sessionId, clean = String, log = () => {} }: { sessionId?: string; clean?: (text: string) => string; log?: Logger }) {
    super({ agent: { profile: piProfile, context: piContext, receivedRequest }, clean, log });
    this.sessionId = sessionId;
  }
  observe(data: Record<string, any>, emit = true) {
    const failed = data.type === 'agent_settled' && this.lastStop === 'error';
    if (data.source !== 'session_file') this.turn = this.nextTurn(data, failed);
    this.add(makeObservation({ kind: observationKind(data, failed), name: data.type, text: this.clean(JSON.stringify(data)), at: Date.now(), state: this.turn, child: false }), emit);
  }
  nextTurn(data: Record<string, any>, failed: boolean): TurnState {
    switch (data.type) {
      case 'agent_start': case 'tool_execution_start': return 'working';
      case 'ui_prompt_start': return 'needs_operator';
      case 'ui_prompt_end': return this.running ? 'working' : this.turn;
      case 'agent_settled': return failed ? 'failed' : 'turn_finished';
      case 'session_shutdown': return data.reason === 'quit' ? 'exited' : this.turn;
      default: return this.turn;
    }
  }
  /** A resumed, continued or forked session: its saved messages become history, never live context. */
  restore(file: unknown) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !path.basename(file).endsWith(`_${this.sessionId}.jsonl`) || this.restored.has(file)) return;
    let lines: string[];
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('fault', err); return; }
    this.restored.add(file);
    let count = 0;
    for (const line of lines) {
      let entry: any; try { entry = JSON.parse(line); } catch { continue; }
      const message = entry?.type === 'message' ? entry.message : undefined;
      // Saved in the shapes the extension forwards live, so the same table applies.
      if (message?.role === 'user') {
        const text = messageText(message.content);
        this.observe({ type: 'input', text, source: 'session_file' }, false); this.input(text, { source: 'session_file' }, false);
      } else if (message?.role === 'assistant') {
        this.observe({ type: 'message_end', message, source: 'session_file' }, false); this.textDelta(messageText(message.content), { source: 'session_file' }, false);
        // Live, a tool's arguments arrive as it starts; the saved call holds them.
        for (const call of Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === 'toolCall') : []) {
          this.observe({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments, source: 'session_file' }, false);
        }
      } else if (message?.role === 'toolResult') {
        this.observe({ type: 'tool_execution_end', toolCallId: message.toolCallId, toolName: message.toolName, result: { content: message.content, details: message.details }, isError: message.isError, source: 'session_file' }, false);
      } else continue;
      count++;
    }
    this.log({ type: 'agent.transcript', file, restored: count });
  }
  override hook(event: Record<string, any>): boolean {
    // Pi names the session. Only this Pi process runs the companion's extension,
    // so its first event names the session, and a session_start for another one
    // (/new, /resume, /fork) moves to that one.
    const id = typeof event.session_id === 'string' && event.session_id ? event.session_id : undefined;
    if (id && (this.sessionId === undefined || (event.type === 'session_start' && id !== this.sessionId))) {
      const previous = this.sessionId;
      this.sessionId = id; this.log({ type: 'agent.session', sessionId: id, previous }); this.emit('session', id);
    }
    if (!id || id !== this.sessionId) {
      this.log({ type: 'agent.hook_refused', name: event.type, session_id: event.session_id, sessionId: this.sessionId });
      return false;
    }
    event = JSON.parse(this.clean(JSON.stringify(event)));
    const name = event.type;
    if (name === 'session_start') this.restore(event.session_file);
    // Pi's own `type` is the event's name; the log record keeps its own type.
    this.log({ ...event, type: 'agent.hook', name });
    this.observe(event);
    if (name === 'session_start' && !this.running) this.status('idle', 'Pi is ready');
    if (name === 'agent_start') { this.running = true; this.lastStop = undefined; this.status('working', 'Pi is working'); }
    if (name === 'input') this.input(event.text, { source: event.source });
    if (name === 'message_end' && event.message?.role === 'assistant') {
      this.lastStop = event.message.stopReason;
      if (this.running) this.status('working', 'Pi is responding');
      this.textDelta(messageText(event.message.content), { source: 'message_end' });
    }
    if (name === 'tool_execution_start') this.status('working', `Pi is using ${event.toolName}`);
    if (name === 'tool_execution_end') this.status('working', event.isError ? `${event.toolName} reported a failure` : `Pi finished ${event.toolName}`);
    if (name === 'ui_prompt_start') this.status('needs_attention', 'Pi is waiting for an answer in the terminal');
    if (name === 'ui_prompt_end') this.status(this.running ? 'working' : 'idle', this.running ? 'Pi is working' : 'Pi is ready');
    if (name === 'agent_settled') {
      this.running = false;
      if (this.lastStop === 'error') this.status('failed', 'Pi reported an error');
      else this.status('idle', this.lastStop === 'aborted' ? 'Pi was interrupted' : 'Pi finished responding');
    }
    if (name === 'session_shutdown' && event.reason === 'quit') this.status('exited', 'Pi session ended');
    return true;
  }
}
