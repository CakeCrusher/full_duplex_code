import { EventEmitter } from 'node:events';
import type { AgentDefinition, AgentState, Observation } from './adapter.ts';

export interface ConversationTurn { role: 'input' | 'output'; text: string }
/** A tool call the agent finished, in terms every agent shares: the tool, what it was asked, what it answered. */
export interface ToolUse { tool: string; input: Record<string, any>; response: unknown }
export type Logger = (event: Record<string, unknown>) => void;
/** The parts of an agent definition that describe its observations. */
export type ObservedAgent = Pick<AgentDefinition, 'profile' | 'context' | 'receivedRequest' | 'toolCall'>;

// The observation store: everything seen from one agent session, in the shared
// Observation format, plus the plain conversation and the agent's state.
// Adapters subclass it to translate their own events. It emits `observation`,
// `input`, `text`, `status` and `fault`.
export class AgentObserver extends EventEmitter {
  state: AgentState = 'starting';
  text = '';
  conversation: ConversationTurn[] = [];
  observations: Observation[] = [];
  readonly agent: ObservedAgent;
  clean: (text: string) => string;
  log: Logger;
  constructor({ agent, clean = String, log = () => {} }: { agent: ObservedAgent; clean?: (text: string) => string; log?: Logger }) {
    super();
    this.agent = agent; this.clean = clean; this.log = log;
  }
  get profile() { return this.agent.profile; }
  status(state: AgentState, detail: string) { this.state = state; this.emit('status', { state, detail }); }
  remember(role: ConversationTurn['role'], text: string) {
    const last = this.conversation.at(-1);
    if (role === 'output' && last?.role === role) last.text += text;
    else this.conversation.push({ role, text });
  }
  conversationContext() { return JSON.stringify(this.conversation); }
  add(observation: Observation, emit = true) {
    this.observations.push(observation);
    if (emit) this.emit('observation', observation);
  }
  input(text: string | undefined, metadata: Record<string, unknown> = {}, emit = true) {
    const safe = this.clean(text ?? ''); if (!safe) return;
    this.remember('input', safe);
    if (emit) this.emit('input', { text: safe, ...metadata });
  }
  textDelta(text: string | undefined, metadata: Record<string, unknown> = {}, emit = true) {
    const safe = this.clean(text ?? ''); if (!safe) return;
    this.text += safe;
    this.remember('output', safe);
    if (emit) this.emit('text', { text: safe, ...metadata });
  }
  /** One event from the agent's command hook. Returns false for another session's event. */
  hook(_event: Record<string, any>): boolean { return false; }
  /**
   * The tool call an observation reports finished, if it does: what the stage reads to learn which tab the agent showed
   * (stage.ts). Agents whose hooks are Claude's shape (PostToolUse with tool_name, tool_input and tool_response) need no
   * more; an agent whose events split a call in two pairs them (Pi).
   */
  toolUse(observation: Observation): ToolUse | undefined {
    const raw = observation.raw;
    return raw?.hook_event_name === 'PostToolUse' && typeof raw.tool_name === 'string' ? { tool: raw.tool_name, input: raw.tool_input ?? {}, response: raw.tool_response } : undefined;
  }
  close() {}
}
