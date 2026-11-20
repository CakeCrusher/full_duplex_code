import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCommand } from '../../core/command.ts';
import type { AgentAdapter, AgentDefinition, AgentLaunch, AgentSession, VoiceRequest } from '../../core/adapter.ts';
import { piProfile } from './profile.ts';
import { piContext } from './context.ts';
import { piForkArgs, readPiArgs } from './arguments.ts';
import { PiObserver } from './observer.ts';
import { PiDelivery } from './delivery.ts';
import { receivedRequest, turnText } from './message.ts';
import { piArgs } from './launch.ts';
import { INSTRUCTIONS_VARIABLE } from './extension.ts';

// Pi: observed and reached through the companion's extension, which Pi loads
// for this run only. It forwards Pi's events to /hook and takes requests at /pi.
/** A session's name, as Pi shows it: its file's latest session_info entry (--name, /name; an empty one clears it). */
export function sessionTitle(file: string | undefined): string | undefined {
  if (!file) return;
  let lines: string[]; try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return; }
  for (const line of lines.reverse()) {
    if (!line.includes('"session_info"')) continue;
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'session_info') return typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
  }
}

export class PiAdapter extends EventEmitter implements AgentAdapter {
  readonly profile = piProfile;
  readonly observations: PiObserver;
  readonly delivery: PiDelivery;
  readonly sockets: Record<string, PiDelivery>;
  session: AgentSession;
  constructor(session: AgentSession) {
    super();
    this.session = session;
    this.observations = new PiObserver({ sessionId: session.sessionId, clean: session.clean, log: session.log });
    this.observations.on('session', id => this.emit('session', id));
    this.delivery = new PiDelivery(session.log);
    for (const name of ['connection', 'delivery', 'update', 'fault']) this.delivery.on(name, value => this.emit(name, value));
    this.sockets = { [`${session.prefix ?? ''}/pi`]: this.delivery };
  }
  launch({ baseUrl, token }: { baseUrl: string; token: string }): AgentLaunch {
    const { forkOf, prefix } = this.session;
    // A fork (forks.ts): Pi's own --fork of the session, named (--name), with the operator's options but not their choice
    // of session or name.
    const { name } = this.session;
    const args = forkOf ? [...piForkArgs(this.session.agentArgs), '--fork', forkOf, ...name ? ['--name', name] : []] : this.session.agentArgs;
    return { command: 'pi', args: piArgs(this.session.root, args), env: { FD_BRIDGE_URL: baseUrl, FD_BRIDGE_TOKEN: token, [INSTRUCTIONS_VARIABLE]: this.session.instructions, ...prefix && { FD_BRIDGE_PREFIX: prefix } }, files: {} };
  }
  deliver(request: VoiceRequest) { return this.delivery.deliver(request); }
  history() { return this.observations.observations; }
  /** Its name in the session file (written as Pi goes), else the one Pi reported last, should the file not have it yet. */
  async sessionName() { return sessionTitle(this.observations.sessionFile) ?? this.observations.name; }
  close() { this.delivery.close(); this.observations.close(); }
}

export function doctor() {
  const version = runCommand('pi', ['--version']);
  // The provider Pi uses by default, or the first one it has a saved login for.
  const dir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  const read = (file: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return {}; } };
  const provider = read('settings.json').defaultProvider ?? Object.keys(read('auth.json'))[0];
  const loggedIn = Boolean(provider) && runCommand('pi', ['auth', 'check', '--provider', provider, '--no-refresh']).status === 0;
  return { report: { pi: version.stdout?.trim() || 'not found', piLoggedIn: loggedIn }, ok: version.status === 0 && loggedIn };
}

export const pi: AgentDefinition = {
  canFork: true,
  ask: prompt => ({ command: 'pi', args: ['-p', '--no-session', '--no-tools', prompt] }),
  profile: piProfile,
  context: piContext,
  readArgs: readPiArgs,
  observationModes: [],
  receivedRequest,
  toolCall: (event: string, data: any) => event === 'tool_execution_end' && typeof data?.toolName === 'string' ? data.toolName : undefined,
  // What the extension hands Pi: sendUserMessage(text, { deliverAs }).
  wire: (request: VoiceRequest) => ({ text: turnText(request), deliverAs: 'steer' }),
  create: session => new PiAdapter(session),
  doctor,
  usage: {
    examples: ['pi', 'pi --model sonnet:high', 'pi --continue'],
    notes: `pi: loads the companion's extension for this run only (-e), which forwards Pi's events
  and hands it each request as a steer. --continue, --resume, --session and --fork choose the
  conversation as usual. --print and --mode json or rpc are refused: they open no session to talk to.`,
  },
};
