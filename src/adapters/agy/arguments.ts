import type { AgentArguments } from '../../core/adapter.ts';

// Reads Antigravity's own command line (agy), unchanged: whether it opens an interactive session, and which options would
// stop the companion from working. agy reads options the Go way: one dash or two, the value after `=` or as the next
// argument.

// Subcommands that are not an interactive session run without the companion.
const COMMANDS = new Set(['acp', 'agent', 'agents', 'agentapi', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'remote-control', 'update']);
const DIRECT = new Set(['h', 'help', 'version']);
// Options that take one value, so that a value is never mistaken for an option.
const ONE_VALUE = new Set(['add-dir', 'agent', 'conversation', 'effort', 'i', 'prompt-interactive', 'input-format', 'json-schema', 'log-file', 'mode',
  'model', 'output-format', 'print-timeout', 'project', 'settings', 'p', 'print', 'prompt']);
// Print mode: one answer, then agy exits.
const PRINT = new Set(['p', 'print', 'prompt', 'output-format', 'input-format', 'json-schema', 'print-timeout']);
const SESSION = new Set(['c', 'continue', 'conversation']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ArgumentConflict extends Error {}

export interface Option { name: string; value?: string; args: string[] }
/** Each option with its value, as written. Stops at `--`. */
export function options(args: readonly string[]): Option[] {
  const out: Option[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') continue;
    const body = arg.replace(/^--?/, ''), eq = body.indexOf('='), name = eq === -1 ? body : body.slice(0, eq);
    if (eq !== -1) out.push({ name, value: body.slice(eq + 1), args: [arg] });
    else if (ONE_VALUE.has(name) && i + 1 < args.length) out.push({ name, value: args[i + 1], args: [arg, args[++i]] });
    else out.push({ name, args: [arg] });
  }
  return out;
}

export function readAgyArgs(args: readonly string[]): AgentArguments {
  if (args.length && COMMANDS.has(args[0])) return { direct: true, resume: false, assignSession: false };
  let resume = false, sessionId: string | undefined;
  for (const { name, value } of options(args)) {
    if (DIRECT.has(name)) return { direct: true, resume: false, assignSession: false };
    if (PRINT.has(name)) throw new ArgumentConflict(`--${name} runs agy once without its terminal: there is no session to talk to. Run it on its own.`);
    if (name === 'remote-agent') throw new ArgumentConflict("--remote-agent runs the conversation on another machine, where the companion's hooks don't run and its requests can't reach it.");
    if (SESSION.has(name)) resume = true;
    // A whole ID names the session; agy also takes the start of one, which only the session itself can resolve.
    if (name === 'conversation' && value && UUID.test(value)) sessionId = value;
  }
  // Antigravity names a new conversation itself, as its first message opens it.
  return { direct: false, resume, sessionId, assignSession: false };
}

/** The log file the operator chose for agy, if any: the companion follows it (server.ts). */
export const logFileArg = (args: readonly string[]) => options(args).findLast(option => option.name === 'log-file')?.value;
/** The operator's own first message (-i), which opens a new conversation in place of fdc's greeting. */
export const firstMessageArg = (args: readonly string[]) => options(args).some(option => option.name === 'i' || option.name === 'prompt-interactive');

/**
 * The operator's options for a fork of their session (forks.ts): everything that shapes how Antigravity works (model, effort,
 * mode, permissions, directories, settings), without what chooses the conversation, its first message, its log (each
 * session has its own) or its project (the fork stays where the session it forks is), and without Remote Control, which
 * the main session has.
 */
export function agyForkArgs(args: readonly string[]): string[] {
  const DROP = new Set([...SESSION, 'i', 'prompt-interactive', 'log-file', 'project', 'new-project', 'remote-control']);
  return options(args).filter(option => !DROP.has(option.name)).flatMap(option => option.args);
}
