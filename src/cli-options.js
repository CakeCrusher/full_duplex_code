import { parseArgs } from 'node:util';

const options = {
  cwd: { type: 'string' }, resume: { type: 'string' }, 'session-id': { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  voice: { type: 'string', default: 'marin' }, observe: { type: 'string', default: 'hooks' },
  port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

export function parseLaunchArgs(args, cwd = process.cwd()) {
  const launcherArgs = []; const extraArgs = [];
  // Only a leading subcommand belongs to the launcher. A Claude option's value
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
    const option = Object.hasOwn(options, name) ? options[name] : undefined;
    if (!option) { extraArgs.push(arg); continue; }
    launcherArgs.push(arg);
    if (option.type === 'string' && !arg.includes('=') && i + 1 < args.length) launcherArgs.push(args[++i]);
  }
  // Validate our own options strictly, without interpreting or rewriting Claude's.
  const { values } = parseArgs({ args: launcherArgs, options });
  values.cwd ??= cwd;
  if (values.resume && values['session-id']) throw new Error('Use either --resume or --session-id, not both.');
  return { values, extraArgs, command };
}
