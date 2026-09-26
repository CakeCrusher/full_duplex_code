import type { AgentArguments } from '../../core/adapter.ts';

// Reads Codex's own command line, unchanged: whether it opens an interactive
// session, and which options would stop the companion from working.

// Subcommands that are not an interactive session run without the companion.
const DIRECT_COMMANDS = new Set(['agents', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor',
  'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'cloud', 'exec-server', 'features', 'help']);
const HEADLESS = new Set(['exec', 'e', 'review']);
const SESSIONS = new Set(['resume', 'fork']);
const DIRECT = new Set(['-h', '--help', '-V', '--version']);
const ONE_VALUE = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-m', '--model', '--local-provider',
  '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
const VARIADIC = new Set(['-i', '--image']);
const HOOK_SWITCHES = /^features\.(?:codex_)?hooks\s*=\s*false$/;

export class ArgumentConflict extends Error {}

export function readCodexArgs(args: readonly string[]): AgentArguments {
  const first = args[0];
  if (first !== undefined && DIRECT_COMMANDS.has(first)) return { direct: true, resume: false, assignSession: false };
  if (first !== undefined && HEADLESS.has(first)) throw new ArgumentConflict(`codex ${first} runs without the interactive terminal, so there is no session to talk to. Run it on its own.`);
  const resume = first !== undefined && SESSIONS.has(first);
  for (let i = resume ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break; // The rest is Codex's prompt.
    if (!arg.startsWith('-')) continue;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (DIRECT.has(name)) return { direct: true, resume: false, assignSession: false };
    const value = inline ?? (ONE_VALUE.has(name) ? args[++i] : undefined);
    if (VARIADIC.has(name)) while (inline === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
    if (name === '--remote' || name === '--remote-auth-token-env') throw new ArgumentConflict(`${name} would attach Codex to another app server; Full-Duplex Code attaches it to its own, which carries the companion's hooks and requests.`);
    if ((name === '--disable' && (value === 'hooks' || value === 'codex_hooks')) || ((name === '-c' || name === '--config') && value !== undefined && HOOK_SWITCHES.test(value.trim()))) {
      throw new ArgumentConflict('turning hooks off hides Codex from the companion, which observes it through hooks.');
    }
  }
  // Codex chooses session IDs itself: its first hook names the session.
  return { direct: false, resume, sessionId: undefined, assignSession: false };
}
