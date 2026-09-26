import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

const options = {
  cwd: { type: 'string' }, resume: { type: 'string' }, 'session-id': { type: 'string' },
  voice: { type: 'string', default: 'marin' }, observe: { type: 'string', default: 'hooks' },
  port: { type: 'string' }, public: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsOptionsConfig;

export interface LaunchValues {
  cwd: string; resume?: string; 'session-id'?: string; voice: string; observe: string; port?: string; public: boolean; help?: boolean;
}

export function parseLaunchArgs(args: string[], cwd = process.cwd()) {
  const launcherArgs: string[] = []; const extraArgs: string[] = [];
  // Only a leading subcommand belongs to the launcher. An agent option's value
  // (for example --model usage) must never be mistaken for a launcher command.
  const command = ['doctor', 'usage'].includes(args[0]) ? args[0] : undefined;
  for (let i = command ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      // An explicit second separator bypasses launcher parsing, including --help.
      extraArgs.push(...args.slice(i + 1));
      break;
    }
    const name = arg === '-h' ? 'help' : arg.startsWith('--') ? arg.slice(2).split('=')[0] : undefined;
    const option = name !== undefined && Object.hasOwn(options, name) ? options[name as keyof typeof options] : undefined;
    if (!option) { extraArgs.push(arg); continue; }
    launcherArgs.push(arg);
    if (option.type === 'string' && !arg.includes('=') && i + 1 < args.length) launcherArgs.push(args[++i]);
  }
  // Validate our own options strictly, without interpreting or rewriting the agent's.
  const { values: parsed } = parseArgs({ args: launcherArgs, options });
  const values = { ...parsed, cwd: parsed.cwd ?? cwd } as LaunchValues;
  if (values.resume && values['session-id']) throw new Error('Use either --resume or --session-id, not both.');
  return { values, extraArgs, command };
}
