// The contract between the core and a coding agent. The core never names an
// agent: its events, launch flags, delivery and wording all come through here.
import type { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { AgentObserver } from './agent-observer.ts';

/** Wording and capabilities the core uses for this agent. */
export interface AgentProfile {
  /** Command name, and the prefix of the turn-state key in context records (`<id>_turn_state`). */
  id: string;
  /** Short name used in sentences: "Refer to that agent as <name>." */
  name: string;
  /** Product name: "Your request has been sent to <product>." */
  product: string;
  /** The event that ends the agent's turn. */
  turnEnd: string;
  /** The event that records a prompt the agent received. */
  promptEvent: string;
  /** Assistant text arrives while a turn runs, not only when it ends. */
  streamsMessages: boolean;
  /** A request can reach the agent during a running turn. */
  canSteer: boolean;
  /** One observed event, and several: "every <name> <eventWord>", "<name> <eventsWord>". */
  eventWord: string;
  eventsWord: string;
  /** How requests reach the agent: "Delivered to <transport>". */
  transport: string;
  /** The message a request becomes on the way: "<Wire> JSON" in the request inspector. */
  wire: string;
}

/** What an observation is, in terms every agent shares. The feed decides by kind. */
export type ObservationKind =
  | 'prompt'          // a prompt the agent received
  | 'text'            // conversation text, from the agent or the operator
  | 'tool'            // a tool call or its result
  | 'tool_failure'    // a failed tool call
  | 'attention'       // an approval, question or denial involving the operator
  | 'turn_end'        // the agent finished its response
  | 'turn_failed'     // the turn ended in an error
  | 'task_completed'  // a tracked task was completed
  | 'session_end'     // the agent session ended
  | 'event';          // anything else

/** The agent's turn as recorded in context sent to Live. */
export type TurnState = 'unknown' | 'working' | 'turn_finished' | 'needs_operator' | 'failed' | 'exited';

/** The agent's state as shown to the operator. */
export type AgentState = 'starting' | 'idle' | 'working' | 'needs_attention' | 'failed' | 'exited';

/** One observed agent event, in the format shared by all adapters. */
export interface Observation {
  kind: ObservationKind;
  /** The agent's own name for the event. */
  name: string;
  /** The complete event as redacted JSON: the record Live context is made from. */
  text: string;
  /** The same event, parsed. */
  raw: Record<string, any>;
  at: number;
  /** The agent's turn state after this event. */
  state: TurnState;
  /** The event came from a subagent. */
  child: boolean;
}

/** How the feed turns an agent's observations into context records. */
export interface ContextRules {
  /** Transport fields the voice model does not need; dropped from context records. */
  isMetadata(key: string, name: string): boolean;
  /** For a tool record too wide to excerpt: the fields that carry its outcome. */
  essentials(data: Record<string, any>): Record<string, unknown>;
}

/** A spoken request on its way to the agent. */
export interface VoiceRequest {
  id: string;
  content: string;
  delegationId?: string | null;
  voiceSessionId?: string;
  queuedAt?: number;
}

/** How far a delivery got. */
export type DeliveryResult = { state: 'sent' } | { state: 'uncertain'; error: Error };

/** A prompt the agent received that carries a voice request. */
export interface ReceivedRequest {
  id: string;
  /** The request text inside the agent's envelope, when it can be separated. */
  content?: string;
}

/** What the agent's own command line says about the session it opens. */
export interface AgentArguments {
  /** Not a session (help, version, a subcommand): run the command without the companion. */
  direct: boolean;
  /** The session's ID, when the command names it. */
  sessionId?: string;
  /** The command continues an earlier conversation. */
  resume: boolean;
  /** Nothing in the command selects a session: the launcher assigns a new session ID. */
  assignSession: boolean;
}

/** Everything the core knows about one kind of agent before a session exists. */
export interface AgentDefinition {
  profile: AgentProfile;
  context: ContextRules;
  /** Reads the agent's own arguments. Throws, with the reason, when one would stop the companion from working. */
  readArgs(args: readonly string[]): AgentArguments;
  /** Ways to observe assistant text that `--observe` can choose, default first; none if there is no choice. */
  observationModes: readonly string[];
  /** Finds the voice request inside a prompt the agent received, if there is one. */
  receivedRequest(prompt: string): ReceivedRequest | undefined;
  /** The exact message deliver() sends for a request, shown in the request inspector. */
  wire(request: VoiceRequest): unknown;
  create(session: AgentSession): AgentAdapter;
  /** Checks the agent's local prerequisites for `npm run doctor`, without API spending. */
  doctor(): { report: Record<string, unknown>; ok: boolean };
  /** For the launcher's help: example command lines after `fdc`, and a note on running this agent. */
  usage: { examples: string[]; notes: string };
}

/** What the bridge gives an adapter for one agent session. */
export interface AgentSession {
  root: string;
  runDir: string;
  cwd: string;
  /** The session's ID; when unknown, the adapter learns it from the agent's first event. */
  sessionId?: string;
  /** How assistant text is observed, for agents that offer a choice. */
  observation: string;
  /** The agent's own command-line arguments, passed through unchanged. */
  agentArgs: string[];
  clean: (text: string) => string;
  log: (event: Record<string, unknown>) => void;
}

/** The agent's own command, ready to run, and the files written for it. */
export interface AgentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  files: Record<string, string>;
}

/** A local WebSocket route an adapter serves on the bridge, authenticated with the agent token. */
export interface AgentSocket {
  /** Whether another connection can be accepted now. */
  available(): boolean;
  attach(ws: WebSocket): void;
}

/**
 * One agent session, as the core uses it. Emits:
 * - `session` (id) when an unknown session ID is learned from the agent;
 * - `connection` (ready: boolean) when requests can, or can no longer, be delivered;
 * - `delivery` ({ id, state }) when a request reported uncertain is confirmed later;
 * - `update` after any change the status display should reflect;
 * - `fault` (error).
 */
export interface AgentAdapter extends EventEmitter {
  readonly profile: AgentProfile;
  /** Prepares what the agent needs (configuration, helper processes) and returns its command. Throws, with the reason, when the agent cannot run with the companion. */
  launch(connection: { baseUrl: string; token: string }): AgentLaunch | Promise<AgentLaunch>;
  /** The observer: every agent event as a shared Observation, plus conversation and state. */
  readonly observations: AgentObserver;
  /** Sends one request and resolves with how far it got. */
  deliver(request: VoiceRequest): Promise<DeliveryResult>;
  /** Observations so far, oldest first, including any restored from a resumed session. */
  history(): readonly Observation[];
  readonly sockets: Readonly<Record<string, AgentSocket>>;
  /** Stops delivering and observing, and anything launch() started. */
  close(): void | Promise<void>;
}
