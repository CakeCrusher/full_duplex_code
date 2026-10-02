import type { AgentArguments } from '../../core/adapter.ts';

// Reads Pi's own command line, unchanged: whether it opens an interactive
// session, and which options would stop the companion from working.

// Subcommands that are not an interactive session run without the companion.
const COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);
const DIRECT = new Set(['-h', '--help', '-v', '--version', '--list-models', '--export']);
// Options that take one value, so that a value is never mistaken for an option.
const ONE_VALUE = new Set(['--provider', '--model', '--api-key', '--thinking', '--models', '--mode', '--session', '--session-id', '--fork',
  '--session-dir', '-n', '--name', '-t', '--tools', '-xt', '--exclude-tools', '-e', '--extension', '--skill', '--prompt-template', '--theme',
  '--use-theme', '--system-prompt', '--append-system-prompt', '--tui-mode']);
const SESSIONS = new Set(['-c', '--continue', '-r', '--resume', '--session', '--fork']);

export class ArgumentConflict extends Error {}

export function readPiArgs(args: readonly string[]): AgentArguments {
  if (args.length && COMMANDS.has(args[0])) return { direct: true, resume: false, assignSession: false };
  let resume = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break; // The rest is Pi's prompt.
    if (!arg.startsWith('-')) continue;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (DIRECT.has(name)) return { direct: true, resume: false, assignSession: false };
    const value = inline ?? (ONE_VALUE.has(name) ? args[++i] : undefined);
    if (name === '-p' || name === '--print') throw new ArgumentConflict(`${name} answers once and exits: there is no interactive session to talk to. Run pi ${name} on its own.`);
    if (name === '--mode' && (value === 'json' || value === 'rpc')) throw new ArgumentConflict(`--mode ${value} replaces the terminal with a ${value === 'json' ? 'one-shot event stream' : 'command protocol'}: there is no interactive session to talk to. Run it on its own.`);
    if (SESSIONS.has(name)) resume = true;
  }
  // Pi names the session; the companion's extension reports it as Pi starts.
  return { direct: false, resume, sessionId: undefined, assignSession: false };
}
