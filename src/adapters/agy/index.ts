import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCommand } from '../../core/command.ts';
import type { AgentAdapter, AgentDefinition, AgentLaunch, AgentSession, VoiceRequest } from '../../core/adapter.ts';
import { agyProfile } from './profile.ts';
import { agyContext } from './context.ts';
import { agyForkArgs, firstMessageArg, logFileArg, readAgyArgs } from './arguments.ts';
import { AgyObserver, forkPoint } from './observer.ts';
import { AgyDelivery } from './delivery.ts';
import { AgyServer } from './server.ts';
import { forkOpening, GREETING, receivedRequest, turnText } from './message.ts';
import { releasePlugin, writePlugin, type AgyPlugin } from './launch.ts';

// The sessions of this fdc by conversation: a fork is made by the session it forks, through its language server.
const sessions = new Map<string, AgyAdapter>();
/** How long after agy settles its opening (fdc's first message) may take to start a turn, before what waits is woken instead. */
const OPENING_MS = 20000;

// Antigravity (agy): observed through the hooks and rules of a plugin of fdc's, its transcript and its log; reached
// through the same hooks (before each model call) and, while it rests, its language server.
export class AgyAdapter extends EventEmitter implements AgentAdapter {
  readonly profile = agyProfile;
  readonly observations: AgyObserver;
  readonly server = new AgyServer();
  readonly delivery: AgyDelivery;
  readonly sockets = {};
  session: AgentSession;
  plugin?: AgyPlugin; connected = false;
  constructor(session: AgentSession) {
    super();
    this.session = session;
    this.observations = new AgyObserver({ sessionId: session.sessionId, clean: session.clean, log: session.log });
    this.delivery = new AgyDelivery({ server: this.server, observer: this.observations, log: session.log });
    this.delivery.on('fault', error => this.emit('fault', error));
    this.observations.on('session', (id: string) => { sessions.set(id, this); this.emit('session', id); this.connect(); });
    this.server.on('ready', () => { session.log({ type: 'agy.server', port: this.server.port }); this.connect(); });
    this.server.on('settled', () => { session.log({ type: 'agy.settled' }); this.connect(); setTimeout(() => this.delivery.openingMissed(), OPENING_MS).unref(); });
    this.server.on('log', event => { this.observations.logged(event); this.emit('update'); });
  }
  /** Requests can go once agy's language server listens and its terminal shows a conversation. */
  connect() { if (!this.connected && this.delivery.ready) { this.connected = true; this.emit('connection', true); } this.emit('update'); }
  async launch({ baseUrl, token }: { baseUrl: string; token: string }): Promise<AgentLaunch> {
    const { root, runDir, cwd, agentArgs, instructions, forkOf } = this.session;
    // The log tells fdc where agy's language server listens: the operator's own log, or one in the run's folder.
    const own = logFileArg(agentArgs), log = own ?? path.join(runDir, 'agy.log');
    this.server.follow(log, own !== undefined && fs.existsSync(log));
    const env = { FD_BRIDGE_TOKEN: token, ...this.server.env }, logging = own ? [] : ['--log-file', log];
    // A fork runs the plugin of the conversation it forks (see fork()), and opens with what it is for.
    if (forkOf) {
      const conversation = await this.fork(forkOf), opening = forkOpening(this.forkNote(forkOf));
      this.open(opening);
      return { command: 'agy', args: [...logging, '--conversation', conversation, '-i', opening, ...agyForkArgs(agentArgs)], env, files: {} };
    }
    const plugin = this.plugin = writePlugin({ root, baseUrl, instructions, cwd });
    if (!plugin.shared) this.session.log({ type: 'agy.plugin_own', workspace: plugin.workspace, why: "another fdc runs in this project: a conversation made by it resumes here without fdc's hooks" });
    // A new conversation opens with a first message: fdc's greeting, unless the operator gave one (-i).
    const greeting = !readAgyArgs(agentArgs).resume && !firstMessageArg(agentArgs);
    if (greeting) this.open(GREETING);
    return { command: 'agy', args: ['--add-dir', plugin.workspace, ...logging, ...greeting ? ['-i', GREETING] : [], ...agentArgs], env, files: { rules: plugin.rules, hooks: plugin.hooks } };
  }
  /** The session opens with fdc's first message: its turn takes what waits, and it is not the operator's. */
  open(text: string) { this.delivery.opening = true; this.observations.opening = text; }
  /** What the fork's instructions add to the main session's (prompts.ts, forkNote): the fork runs the main session's rules (see fork()). */
  forkNote(forkOf: string) {
    const main = sessions.get(forkOf)?.session.instructions ?? '', own = this.session.instructions;
    return (own.startsWith(main) ? own.slice(main.length) : own).trim() || 'This conversation is a fork of the operator\'s main session, for what they turned aside with.';
  }
  /**
   * A fork (forks.ts): Antigravity's own fork of the conversation (what /fork does), made by the main session's language
   * server at the end of its last finished reply, then opened in its window with --conversation, its opening (what the
   * fork is for) and the operator's other options. Taken as this session's at once: requests wait for its opening. The
   * fork keeps the workspace of the conversation it forks, and so runs the main session's plugin: its hooks reach the
   * bridge on the main session's route, which hands this session's events to the fork (endpoints.ts), and its rules are
   * the main session's instructions, which the opening completes. It has no plugin of its own.
   */
  async fork(forkOf: string) {
    const main = sessions.get(forkOf);
    if (!main?.server.port || !main.observations.transcriptPath) throw new Error("Antigravity's main session can't be reached to fork it.");
    const step = forkPoint(main.observations.transcriptPath);
    const id = await main.server.fork(forkOf, step);
    this.session.log({ type: 'agy.forked', from: forkOf, conversation: id, step });
    this.observations.adopt(id);
    return id;
  }
  deliver(request: VoiceRequest) { return this.delivery.deliver(request); }
  answer(event: Record<string, any>) { return this.delivery.answer(event); }
  history() { return this.observations.observations; }
  async close() {
    this.delivery.close(); this.observations.close(); this.server.close();
    for (const [id, adapter] of sessions) if (adapter === this) sessions.delete(id);
    if (this.plugin) releasePlugin(this.plugin);
  }
}

export function doctor() {
  const version = runCommand('agy', ['--version']);
  // agy lists its models only to a signed-in user; listing them calls no model.
  const models = runCommand('agy', ['models']);
  const signedIn = models.status === 0 && /gemini/i.test(models.stdout ?? '');
  return { report: { agy: version.stdout?.trim() || 'not found', agySignedIn: signedIn }, ok: version.status === 0 && signedIn };
}

export const agy: AgentDefinition = {
  canFork: true,
  // In the reply's own temporary folder, sandboxed: nothing of the project, and none of its conversations' list.
  ask: (prompt, outputFile) => ({ command: 'agy', args: ['-p', prompt, '--output-format', 'text', '--sandbox'], cwd: path.dirname(outputFile) }),
  profile: agyProfile,
  context: agyContext,
  readArgs: readAgyArgs,
  observationModes: [],
  receivedRequest,
  toolCall: (event: string, data: any) => event === 'TOOL_RESULT' && typeof data?.tool === 'string' ? data.tool : undefined,
  wire: (request: VoiceRequest) => ({ userMessage: turnText(request) }),
  create: session => new AgyAdapter(session),
  doctor,
  usage: {
    examples: ['agy', 'agy --model gemini-3.8-flash-high', 'agy --conversation CONVERSATION_ID', 'agy --continue --mode accept-edits'],
    notes: `agy: Antigravity loads a plugin of fdc's for this session only (--add-dir, in a temporary
  folder): hooks that report its work and hand it each request at its next model call, and fdc's
  instructions as rules. A new conversation opens with a one-word greeting, since agy opens one only
  with a first message. --conversation and --continue choose the conversation as usual; --print and
  --remote-agent are refused: there would be no session to talk to.`,
  },
};
