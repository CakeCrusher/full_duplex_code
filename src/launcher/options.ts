import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

// Full-Duplex Code's own options come before the agent's name. Everything after
// the name is the agent's own command line, passed through unchanged.
const options = {
  voice: { type: 'string', default: 'marin' }, observe: { type: 'string' },
  port: { type: 'string' }, public: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsOptionsConfig;

export interface LaunchValues { voice: string; observe?: string; port?: string; public: boolean; help?: boolean }
export interface LaunchCommand { values: LaunchValues; command?: 'doctor' | 'usage'; agent?: string; agentArgs: string[] }
/** A mistake in the command line, reported without a stack trace. */
export class UsageError extends Error {}

export function parseLaunchArgs(args: readonly string[]): LaunchCommand {
  const ours: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-') || arg === '-') break;
    const name = arg === '-h' ? 'help' : arg.startsWith('--') ? arg.slice(2).split('=')[0] : undefined;
    const option = name !== undefined && Object.hasOwn(options, name) ? options[name as keyof typeof options] : undefined;
    if (!option) throw new UsageError(`Unknown option ${arg}. Full-Duplex Code's options go before the agent's name, and the agent's own options after it: fdc [options] <agent> [agent options]`);
    ours.push(arg);
    if (option.type === 'string' && !arg.includes('=') && i + 1 < args.length) ours.push(args[++i]);
  }
  let values;
  try { values = parseArgs({ args: ours, options }).values as LaunchValues; }
  catch (error) { throw new UsageError((error as Error).message); }
  const [first, ...rest] = args.slice(i);
  if (first === 'doctor') return { values, command: 'doctor', agent: rest[0], agentArgs: [] };
  if (first === 'usage') return { values, command: 'usage', agentArgs: [] };
  return { values, agent: first, agentArgs: rest };
}
