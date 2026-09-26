import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter, AgentDefinition, AgentLaunch, AgentSession, VoiceRequest } from '../../core/adapter.ts';
import { claudeProfile } from './profile.ts';
import { claudeContext } from './context.ts';
import { ClaudeObserver } from './observer.ts';
import { ChannelDelivery } from './delivery.ts';
import { channelNotification, receivedRequest } from './channel-message.ts';
import { claudeArgs, makeClaudeConfig } from './launch.ts';

// Claude Code: observed through command hooks (and its transcript on resume),
// reached through the voice channel MCP server.
export class ClaudeAdapter extends EventEmitter implements AgentAdapter {
  readonly profile = claudeProfile;
  readonly observations: ClaudeObserver;
  readonly delivery: ChannelDelivery;
  readonly sockets: Record<string, ChannelDelivery>;
  session: AgentSession;
  constructor(session: AgentSession) {
    super();
    this.session = session;
    this.observations = new ClaudeObserver({ sessionId: session.sessionId, observation: session.observation, clean: session.clean, log: session.log });
    this.delivery = new ChannelDelivery(session.log);
    for (const name of ['connection', 'delivery', 'update', 'fault']) this.delivery.on(name, value => this.emit(name, value));
    this.sockets = { '/channel': this.delivery };
  }
  launch({ baseUrl, token }: { baseUrl: string; token: string }): AgentLaunch {
    const { root, runDir, sessionId, resume, agentArgs } = this.session;
    const config = makeClaudeConfig({ root, runDir, baseUrl, channelToken: token });
    return { command: 'claude', args: claudeArgs({ config, sessionId, resume, extraArgs: agentArgs }), env: { FD_BRIDGE_TOKEN: token }, files: { ...config } };
  }
  deliver(request: VoiceRequest) { return this.delivery.deliver(request); }
  history() { return this.observations.observations; }
  close() { this.delivery.close(); this.observations.close(); }
}

export function doctor() {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  let loggedIn = false; try { loggedIn = JSON.parse(auth.stdout).loggedIn; } catch {}
  return { report: { claude: version.stdout?.trim() || 'not found', claudeLoggedIn: loggedIn }, ok: version.status === 0 && loggedIn };
}

export const claude: AgentDefinition = {
  profile: claudeProfile,
  context: claudeContext,
  receivedRequest,
  wire: (request: VoiceRequest) => channelNotification(request),
  create: session => new ClaudeAdapter(session),
  doctor,
  usage: {
    examples: ['--dangerously-skip-permissions', '--cwd /project --resume UUID --model opus --permission-mode plan'],
    afterStart: `Claude opens in your terminal. Open the companion URL and click Start voice once
to enable the microphone and speaker. Claude's permission mode controls tool
approvals. End voice stops API billing while leaving Claude available.`,
  },
};
