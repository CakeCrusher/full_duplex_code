import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter, AgentDefinition, AgentLaunch, AgentSession, VoiceRequest } from '../../core/adapter.ts';
import { hookCommand } from '../../core/hook-command.ts';
import { codexProfile } from './profile.ts';
import { codexContext } from './context.ts';
import { readCodexArgs } from './arguments.ts';
import { CodexObserver } from './observer.ts';
import { CodexDelivery, receivedRequest, turnInput } from './delivery.ts';
import { startAppServer, type AppServer } from './app-server.ts';
import { codexArgs, TOKEN_VARIABLE } from './launch.ts';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// Codex: observed through command hooks and its transcript, reached through its
// app server, where requests steer the running turn.
export class CodexAdapter extends EventEmitter implements AgentAdapter {
  readonly profile = codexProfile;
  readonly observations: CodexObserver;
  readonly delivery: CodexDelivery;
  readonly sockets = {};
  session: AgentSession;
  server?: AppServer;
  constructor(session: AgentSession) {
    super();
    this.session = session;
    this.observations = new CodexObserver({ sessionId: session.sessionId, clean: session.clean, log: session.log });
    this.delivery = new CodexDelivery({ log: session.log, turnHint: () => this.observations.activeTurn });
    for (const name of ['connection', 'update', 'fault']) this.delivery.on(name, value => this.emit(name, value));
    // Codex names the session in its first hook; then requests can reach its thread.
    this.observations.on('session', id => { this.emit('session', id); this.delivery.attach(id); });
  }
  async launch({ baseUrl, token }: { baseUrl: string; token: string }): Promise<AgentLaunch> {
    const { root, cwd, agentArgs, log } = this.session;
    const relay = hookCommand(root, baseUrl).map(quote).join(' ');
    // The app server runs Codex's tools, so it gets the operator's environment,
    // without the companion's OpenAI key, plus the relay's token.
    const env: NodeJS.ProcessEnv = { ...process.env, FD_BRIDGE_TOKEN: token }; delete env.OPENAI_API_KEY;
    this.server = await startAppServer({ cwd, env, hooks: relay, log });
    await this.delivery.connect(this.server.url, this.server.token);
    // The terminal will skip hook trust; make sure no other hook waited for review.
    await this.refuseUnreviewedHooks(cwd);
    return { command: 'codex', args: codexArgs(this.server.url, agentArgs), env: { [TOKEN_VARIABLE]: this.server.token }, files: {} };
  }
  async refuseUnreviewedHooks(cwd: string) {
    const listed = await this.delivery.call('hooks/list', { cwds: [cwd] });
    if (listed.error) throw new Error(`Codex could not list its hooks: ${listed.error.message}`);
    const unreviewed = (listed.result?.data ?? []).flatMap((entry: any) => entry.hooks ?? [])
      .filter((hook: any) => hook.source !== 'sessionFlags' && hook.enabled && ['untrusted', 'modified'].includes(hook.trustStatus));
    if (!unreviewed.length) return;
    const list = [...new Set(unreviewed.map((hook: any) => `${hook.sourcePath} (${hook.eventName})`))].join(', ');
    throw new Error(`Codex has hooks you have not reviewed: ${list}. The companion starts Codex with --dangerously-bypass-hook-trust so that its own hooks run, which would run these without review too. Review them with /hooks in Codex first, then start again.`);
  }
  deliver(request: VoiceRequest) { return this.delivery.deliver(request); }
  history() { return this.observations.observations; }
  async close() { this.delivery.close(); this.observations.close(); await this.server?.stop(); }
}

export function doctor() {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  const login = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
  return { report: { codex: version.stdout?.trim() || 'not found', codexLoggedIn: login.status === 0 }, ok: version.status === 0 && login.status === 0 };
}

export const codex: AgentDefinition = {
  profile: codexProfile,
  context: codexContext,
  readArgs: readCodexArgs,
  observationModes: [],
  receivedRequest,
  wire: (request: VoiceRequest) => ({ input: turnInput(request) }),
  create: session => new CodexAdapter(session),
  doctor,
  usage: {
    examples: ['codex', 'codex --model gpt-5.5 --search', '--public codex resume SESSION_ID'],
    notes: `codex: runs attached to the companion's own Codex app server, where requests steer the
  running turn (turn/steer) or start a new one. exec, review, --remote and turning hooks
  off are refused. Sign in with codex login: Codex gets no OPENAI_API_KEY from the companion.`,
  },
};
