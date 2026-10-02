import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter, AgentDefinition, AgentLaunch, AgentSession, VoiceRequest } from '../../core/adapter.ts';
import { piProfile } from './profile.ts';
import { piContext } from './context.ts';
import { readPiArgs } from './arguments.ts';
import { PiObserver } from './observer.ts';
import { PiDelivery } from './delivery.ts';
import { receivedRequest, turnText } from './message.ts';
import { piArgs } from './launch.ts';

// Pi: observed and reached through the companion's extension, which Pi loads
// for this run only. It forwards Pi's events to /hook and takes requests at /pi.
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
    this.sockets = { '/pi': this.delivery };
  }
  launch({ baseUrl, token }: { baseUrl: string; token: string }): AgentLaunch {
    return { command: 'pi', args: piArgs(this.session.root, this.session.agentArgs), env: { FD_BRIDGE_URL: baseUrl, FD_BRIDGE_TOKEN: token }, files: {} };
  }
  deliver(request: VoiceRequest) { return this.delivery.deliver(request); }
  history() { return this.observations.observations; }
  close() { this.delivery.close(); this.observations.close(); }
}

export function doctor() {
  const version = spawnSync('pi', ['--version'], { encoding: 'utf8' });
  // The provider Pi uses by default, or the first one it has a saved login for.
  const dir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  const read = (file: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return {}; } };
  const provider = read('settings.json').defaultProvider ?? Object.keys(read('auth.json'))[0];
  const loggedIn = Boolean(provider) && spawnSync('pi', ['auth', 'check', '--provider', provider, '--no-refresh'], { encoding: 'utf8' }).status === 0;
  return { report: { pi: version.stdout?.trim() || 'not found', piLoggedIn: loggedIn }, ok: version.status === 0 && loggedIn };
}

export const pi: AgentDefinition = {
  profile: piProfile,
  context: piContext,
  readArgs: readPiArgs,
  observationModes: [],
  receivedRequest,
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
