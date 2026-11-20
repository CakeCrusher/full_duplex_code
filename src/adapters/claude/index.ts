import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { runCommand } from '../../core/command.ts';
import type { AgentAdapter, AgentDefinition, AgentLaunch, AgentSession, VoiceRequest } from '../../core/adapter.ts';
import { claudeProfile } from './profile.ts';
import { claudeContext } from './context.ts';
import { ClaudeObserver } from './observer.ts';
import { ChannelDelivery } from './delivery.ts';
import { channelNotification, receivedRequest } from './channel-message.ts';
import { claudeArgs, makeClaudeConfig } from './launch.ts';
import { forkArgs, readClaudeArgs } from './arguments.ts';

// Claude Code: observed through command hooks (and its transcript on resume),
// reached through the voice channel MCP server, whose instructions (fdc's) are
// in its system prompt.
// Claude Code asks before it loads a channel that is not on its list (fdc's voice channel is loaded as a development
// one), and waits for Enter on the answer it has selected: this one. The operator answers it themselves in their own
// terminal when they start fdc; in a fork's window, which they asked not to have to go to, fdc does.
const CHANNEL_PROMPT = 'I am using this for local development';

/**
 * A session's name, as /resume lists it: the operator's (--name, /rename: its latest custom-title record), else the
 * title Claude made up for it (ai-title). Claude writes both again and again as the session goes on, so the end of its
 * transcript holds them; a transcript small enough is read whole.
 */
export function sessionTitle(file: string | undefined, tailBytes = 4 * 1024 * 1024): string | undefined {
  if (!file) return;
  let text: string;
  try {
    const size = fs.statSync(file).size, fd = fs.openSync(file, 'r');
    const read = (from: number) => { const buffer = Buffer.alloc(size - from); fs.readSync(fd, buffer, 0, buffer.length, from); return buffer.toString('utf8'); };
    try { text = read(Math.max(0, size - tailBytes)); if (!/"type":"(custom|ai)-title"/.test(text) && size > tailBytes && size <= 16 * tailBytes) text = read(0); }
    finally { fs.closeSync(fd); }
  } catch { return; }
  let ai: string | undefined;
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('-title"')) continue;
    let record: any; try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) return record.customTitle.trim();
    if (record?.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) ai ??= record.aiTitle.trim();
  }
  return ai;
}

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
    this.observations.on('session', id => this.emit('session', id));
    this.delivery = new ChannelDelivery(session.log);
    for (const name of ['connection', 'delivery', 'update', 'fault']) this.delivery.on(name, value => this.emit(name, value));
    this.sockets = { [`${session.prefix ?? ''}/channel`]: this.delivery };
  }
  launch({ baseUrl, token }: { baseUrl: string; token: string }): AgentLaunch {
    const { root, runDir, sessionId, agentArgs, instructions, prefix, forkOf } = this.session;
    const config = makeClaudeConfig({ root, runDir, baseUrl, channelToken: token, instructions, prefix });
    // A fork: Claude's own fork of the session, named (--name) and with the operator's options, but not their choice of
    // session, name or prompt. Its window is one the operator is not at: fdc answers Claude's question about the voice
    // channel there (CHANNEL_PROMPT).
    if (forkOf) return { command: 'claude', args: claudeArgs({ config, extraArgs: ['--resume', forkOf, '--fork-session', ...this.session.name ? ['--name', this.session.name] : [], ...forkArgs(agentArgs, runDir)] }), env: { FD_BRIDGE_TOKEN: token }, files: { ...config }, confirm: CHANNEL_PROMPT };
    // A new conversation gets the launcher's session ID; otherwise Claude's own arguments choose it.
    const assigned = readClaudeArgs(agentArgs).assignSession ? sessionId : undefined;
    return { command: 'claude', args: claudeArgs({ config, sessionId: assigned, extraArgs: agentArgs }), env: { FD_BRIDGE_TOKEN: token }, files: { ...config } };
  }
  deliver(request: VoiceRequest) { return this.delivery.deliver(request); }
  history() { return this.observations.observations; }
  async sessionName() { return sessionTitle(this.observations.transcriptPath); }
  close() { this.delivery.close(); this.observations.close(); }
}

export function doctor() {
  const version = runCommand('claude', ['--version']);
  const auth = runCommand('claude', ['auth', 'status']);
  let loggedIn = false; try { loggedIn = JSON.parse(auth.stdout).loggedIn; } catch {}
  return { report: { claude: version.stdout?.trim() || 'not found', claudeLoggedIn: loggedIn }, ok: version.status === 0 && loggedIn };
}

export const claude: AgentDefinition = {
  canFork: true,
  ask: prompt => ({ command: 'claude', args: ['-p', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--output-format', 'text'], stdin: prompt }),
  profile: claudeProfile,
  context: claudeContext,
  readArgs: readClaudeArgs,
  observationModes: ['hooks', 'transcript'],
  receivedRequest,
  toolCall: (event: string, data: any) => /^PostToolUse(Failure)?$/.test(event) && typeof data?.tool_name === 'string' ? data.tool_name : undefined,
  // Claude's UserPromptSubmit hook adds context to the prompt it reports.
  vouch: (event: Record<string, any>, delivered: (id: string) => boolean, note: string) => {
    const request = event.hook_event_name === 'UserPromptSubmit' && typeof event.prompt === 'string' ? receivedRequest(event.prompt) : undefined;
    return request && delivered(request.id) ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } } : undefined;
  },
  wire: (request: VoiceRequest) => channelNotification(request),
  create: session => new ClaudeAdapter(session),
  doctor,
  usage: {
    examples: ['claude', 'claude --dangerously-skip-permissions', '--public claude --resume SESSION_ID --model opus'],
    notes: `claude: Claude's permission mode controls tool approvals. --resume, --continue and
  --session-id choose the conversation as usual. --settings, --bare, --safe-mode,
  --print, --bg, --cloud and --tmux are refused: they would hide Claude from the companion.`,
  },
};
