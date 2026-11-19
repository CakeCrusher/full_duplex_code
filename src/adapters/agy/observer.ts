import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Observation, ObservationKind, TurnState } from '../../core/adapter.ts';
import { AgentObserver, type Logger, type ToolUse } from '../../core/agent-observer.ts';
import { observation as makeObservation } from '../../core/observation.ts';
import { lastRecords, TranscriptTail } from '../../core/transcript-tail.ts';
import { agyProfile } from './profile.ts';
import { agyContext } from './context.ts';
import { receivedRequest, requestText, WAKE } from './message.ts';
import type { LogEvent } from './server.ts';

/** Where agy keeps a conversation's transcript, one step per line (its hooks name the same file). */
export const transcriptFile = (conversation: string, home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli', 'brain', conversation, '.system_generated', 'logs', 'transcript_full.jsonl');

/** A tool call as it reaches the record: an MCP tool by the name Claude would give it (mcp__server__tool), so the stage reads it alike. */
export function toolOf(call: { name?: string; args?: Record<string, any> } = {}): { tool: string; args: Record<string, any> } {
  const args = call.args ?? {};
  if (call.name === 'call_mcp_tool' && typeof args.ServerName === 'string' && typeof args.ToolName === 'string') return { tool: `mcp__${args.ServerName}__${args.ToolName}`, args: args.Arguments ?? {} };
  return { tool: call.name ?? 'tool', args };
}
// A tool step's text opens with when it was made and finished, sometimes twice: the record keeps what it said.
const stepOutput = (content: unknown) => typeof content === 'string' ? content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '') : '';

/** The last step a fork can start from: the end of the last finished reply (a reply without tool calls). Agy refuses a user message. */
export function forkPoint(file: string): number {
  let point: number | undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let step: any; try { step = JSON.parse(line); } catch { continue; }
    if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && !step.tool_calls?.length && Number.isInteger(step.step_index)) point = step.step_index;
  }
  if (point === undefined) throw new Error('Antigravity has not finished a reply yet: there is nothing to fork.');
  return point;
}

const KINDS: Record<string, ObservationKind> = { USER_INPUT: 'prompt', PLANNER_RESPONSE: 'text', TOOL_RESULT: 'tool', ToolConfirmation: 'attention', Stop: 'turn_end', SessionEnd: 'session_end' };
/** Steps made more than this before fdc took up a transcript are history (a resumed conversation, a fork's carried steps). */
const HISTORY_MS = 3000;
/** How much of a long transcript's history is read. */
const HISTORY_BYTES = 2 * 1024 * 1024;

// Translates Antigravity's hooks (turn start and end, its tools), its transcript (the operator's messages, its replies,
// what each tool answered) and its log (approvals it waits for, the conversation its terminal shows, its exit) into shared
// Observations, conversation and state. Records are built here from what each source says, without the transport
// fields (paths, IDs, counters) the hooks repeat in every event.
export class AgyObserver extends AgentObserver {
  sessionId?: string;
  turn: TurnState = 'unknown';
  /** A turn runs: from its first model call until its Stop hook, when the last one ended. */
  running = false; stoppedAt?: number;
  /** In the running turn: the tool calls its replies announced, and those its hooks reported finished. */
  announced = 0; ended = 0;
  transcriptPath?: string; tail?: TranscriptTail;
  /** Steps already in the record, and when the transcript was taken up: older steps are history. */
  steps = new Set<number>(); since = 0;
  /** fdc's own first message to the session (a greeting, a fork's opening): Antigravity records it as typed, but it is not the operator's. */
  opening?: string;
  /** Tool calls announced in a reply, waiting for their result steps, in order. */
  calls: { tool: string; args: Record<string, any> }[] = [];
  home: string;
  constructor({ sessionId, clean = String, log = () => {}, home = os.homedir() }: { sessionId?: string; clean?: (text: string) => string; log?: Logger; home?: string }) {
    super({ agent: { profile: agyProfile, context: agyContext, receivedRequest }, clean, log });
    this.sessionId = sessionId; this.home = home;
  }
  observe(name: string, data: Record<string, any>, emit = true, kind: ObservationKind = KINDS[name] ?? 'event') {
    this.add(makeObservation({ kind, name, text: this.clean(JSON.stringify({ event: name, ...data })), at: Date.now(), state: this.turn, child: false }), emit);
  }
  /** The conversation the terminal shows, named by agy's log or a new conversation's first hook; another one later is a switch (/resume, /fork, /new). */
  adopt(id: string, file = transcriptFile(id, this.home)) {
    if (this.sessionId === id && this.transcriptPath) return;
    const previous = this.sessionId;
    if (previous !== id) { this.sessionId = id; this.log({ type: 'agent.session', sessionId: id, previous }); this.emit('session', id); }
    this.attachTranscript(file);
    // Opened with fdc's own first message, the conversation's first turn is that message's: not ready until it ends.
    const opening = this.opening !== undefined && this.stoppedAt === undefined;
    if (!this.running && this.state !== 'needs_attention') this.status(opening ? 'working' : 'idle', opening ? 'Antigravity is opening the conversation' : 'Antigravity is ready');
  }
  /**
   * Follows the conversation's transcript, from its start: steps made before fdc took it up seed the conversation as
   * history, never news. Of a long one, only its last part: a transcript grows without bound.
   */
  attachTranscript(file: string) {
    if (this.transcriptPath === file) return;
    this.tail?.stop(); this.transcriptPath = file; this.steps.clear(); this.calls = []; this.since = Date.now() - HISTORY_MS;
    let fromEnd = false;
    try { if (fs.statSync(file).size > HISTORY_BYTES) { for (const step of lastRecords(file, HISTORY_BYTES)) this.record(step, false); fromEnd = true; } } catch {}
    this.log({ type: 'agent.transcript', file, fromEnd });
    this.tail = new TranscriptTail(file, step => this.record(step), error => this.emit('fault', error), { intervalMs: 100 });
    this.tail.start({ fromEnd });
  }
  /** One step of the transcript. */
  record(step: Record<string, any>, emit = true) {
    const index = step.step_index;
    if (!Number.isInteger(index) || this.steps.has(index)) return;
    this.steps.add(index);
    if (Date.parse(step.created_at) < this.since) emit = false;
    const content = typeof step.content === 'string' ? step.content : '';
    switch (step.type) {
      case 'USER_INPUT': {
        // Typed (USER_EXPLICIT), or a voice request the companion's hook added (SYSTEM_SDK).
        const text = requestText(content);
        if (text === this.opening) return this.observe('OPENING', { text }, emit);
        this.observe('USER_INPUT', { source: step.source, text }, emit);
        this.input(text, { source: step.source }, emit);
        return;
      }
      case 'PLANNER_RESPONSE': {
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls.map(toolOf) : [];
        this.calls.push(...calls);
        // What it is about to do: agy has no hook as a tool starts (a PreToolUse hook that decides nothing blocks the tool).
        // agy may write the step only once its calls are done, their hooks heard: then it is not news.
        if (calls.length && emit) {
          const done = this.ended >= this.announced + calls.length;
          this.announced += calls.length;
          if (!done) {
            this.status('working', `Antigravity is using ${calls.map((call: { tool: string }) => call.tool).join(', ')}`);
            // As other agents' hooks report a tool as it starts: what it runs, before its result.
            this.observe('TOOL_CALL', { calls }, emit, 'tool');
          }
        }
        // A reply that only calls tools says nothing more: each call's result step records what it did.
        if (!content.trim()) return;
        this.observe('PLANNER_RESPONSE', { text: content, ...calls.length && { tools: calls.map((call: { tool: string }) => call.tool) } }, emit);
        this.textDelta(content, { source: 'transcript' }, emit);
        return;
      }
      case 'GENERIC': {
        // A tool's result: the next call announced and not yet answered.
        const call = this.calls.shift() ?? { tool: 'tool', args: {} };
        const failed = step.status === 'ERROR';
        this.observe('TOOL_RESULT', { tool: call.tool, args: call.args, output: stepOutput(content), ...failed && { error: step.error ?? 'failed' } }, emit, failed ? 'tool_failure' : 'tool');
        return;
      }
      case 'SYSTEM_MESSAGE':
        // The companion's own wake (server.ts) carries nothing; Antigravity's notes (a background task ended) are news.
        if (content.includes(WAKE)) return;
        this.observe('SYSTEM_MESSAGE', { text: content.replace(/^The following is a <SYSTEM_MESSAGE>[^\n]*\n+/, '') }, emit);
        return;
      default:
        this.observe(step.type ?? 'step', { ...content && { text: content }, ...step.status === 'ERROR' && { error: step.error } }, emit);
    }
  }
  /** A tool call the transcript reports finished, for the stage: its tool, what it was asked, and what it answered. */
  override toolUse(observation: Observation): ToolUse | undefined {
    const raw = observation.raw;
    return raw?.event === 'TOOL_RESULT' && typeof raw.tool === 'string' ? { tool: raw.tool, input: raw.args ?? {}, response: raw.output } : undefined;
  }
  /** What agy's log says (server.ts). */
  logged(event: LogEvent) {
    if (event.type === 'conversation') return this.adopt(event.id);
    if (event.type === 'confirmation') {
      // Waiting for the operator: the call is the earliest one announced and not yet answered.
      const call = this.calls[0];
      this.turn = 'needs_operator';
      this.observe('ToolConfirmation', { tool: call?.tool ?? event.tool, ...call && { args: call.args } });
      return this.status('needs_attention', `${call?.tool ?? event.tool} needs approval in the Antigravity terminal`);
    }
    if (event.type === 'confirmed' && event.conversation === this.sessionId) {
      this.turn = 'working';
      this.observe('ToolConfirmed', { approved: event.approved });
      return this.status('working', event.approved ? 'Antigravity is working' : 'The operator declined a tool in the Antigravity terminal');
    }
    if (event.type === 'exit') { this.running = false; this.turn = 'exited'; this.observe('SessionEnd', {}); this.status('exited', 'Antigravity session ended'); }
  }
  override hook(event: Record<string, any>): boolean {
    const id = typeof event.conversationId === 'string' && event.conversationId ? event.conversationId : undefined;
    // A new conversation's first hook names it, if the log has not yet.
    if (id && this.sessionId === undefined) this.adopt(id, typeof event.transcriptPath === 'string' && path.isAbsolute(event.transcriptPath) ? event.transcriptPath : undefined);
    if (!id || id !== this.sessionId) {
      this.log({ type: 'agent.hook_refused', name: event.hookEventName, conversationId: id, sessionId: this.sessionId });
      return false;
    }
    const name = event.hookEventName;
    this.log({ type: 'agent.hook', name, invocation: event.invocationNum, tool: event.toolCall?.name, reason: event.terminationReason, error: event.error || undefined });
    if (name === 'PreInvocation') {
      if (!this.running) { this.running = true; this.turn = 'working'; this.announced = this.ended = 0; }
      this.status('working', 'Antigravity is working');
    }
    if (name === 'PostToolUse') this.ended++;
    if (name === 'PostToolUse') this.status('working', event.error ? `${toolOf(event.toolCall).tool} reported a failure` : `Antigravity finished ${toolOf(event.toolCall).tool}`);
    if (name === 'Stop') {
      this.running = false; this.stoppedAt = Date.now();
      const failed = event.terminationReason === 'ERROR' || Boolean(event.error);
      // A command it sent to the background still runs (agy does so after a few seconds, `sleep 15` included): the turn
      // ends, and agy goes on by itself when the task ends. Its work is not done, so this is progress, not a turn's end.
      const waiting = !failed && event.fullyIdle === false;
      this.turn = failed ? 'failed' : waiting ? 'working' : 'turn_finished';
      // Its reasons: NO_TOOL_CALL (it answered), USER_CANCELED (interrupted), ERROR, MAX_* (a limit).
      this.observe('Stop', { reason: event.terminationReason, ...event.error && { error: event.error }, ...waiting && { background: 'a task it started still runs; it goes on when the task ends' } }, true, failed ? 'turn_failed' : waiting ? 'event' : 'turn_end');
      this.status(failed ? 'failed' : waiting ? 'working' : 'idle', failed ? 'Antigravity reported an error' : waiting ? 'Antigravity is waiting for a task it started' : event.terminationReason === 'USER_CANCELED' ? 'Antigravity was interrupted' : 'Antigravity finished responding');
    }
    return true;
  }
  override close() { this.tail?.stop(); }
}
