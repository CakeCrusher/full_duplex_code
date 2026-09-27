import fs from 'node:fs';
import type { AgentArguments } from '../../core/adapter.ts';

// Reads Claude's own command line, unchanged: which session it opens, whether it
// is a session at all, and which options would stop the companion from working.

// Commands that are not a conversation: run them without the companion.
const COMMANDS = new Set(['agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin', 'plugins',
  'project', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade']);
const DIRECT = new Set(['-h', '--help', '-v', '--version']);
// Options that take one value, and options whose value is optional or variadic,
// so that a value is never mistaken for an option.
const ONE_VALUE = new Set(['--agent', '--agents', '--append-system-prompt', '--autocompact', '--client-data-url', '--debug-file', '--effort', '--environment',
  '--fallback-model', '--input-format', '--json-schema', '--max-budget-usd', '--model', '-n', '--name', '--output-format', '--permission-mode',
  '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix', '--session-id', '--setting-sources', '--settings',
  '--system-prompt', '--system-prompt-snapshot']);
const OPTIONAL_VALUE = new Set(['--cloud', '-d', '--debug', '--from-pr', '--prompt-suggestions', '--remote-control', '-r', '--resume', '--teleport', '-w', '--worktree']);
const VARIADIC = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--file', '--mcp-config', '--tools']);
// Options that break the companion, and why.
const CONFLICTS: Record<string, string> = {
  '--bare': '--bare skips hooks, which Full-Duplex Code needs to observe Claude.',
  '--safe-mode': '--safe-mode turns off hooks and MCP servers, which Full-Duplex Code needs to observe Claude and reach it.',
  '--bg': '--bg runs Claude in the background; Full-Duplex Code needs it in this terminal.',
  '--background': '--background runs Claude in the background; Full-Duplex Code needs it in this terminal.',
  '--cloud': '--cloud runs the session in the cloud, where Full-Duplex Code cannot observe it.',
  '--environment': '--environment runs the session in the cloud, where Full-Duplex Code cannot observe it.',
  '--tmux': '--tmux moves the session into tmux, outside this terminal.',
  '-p': '-p answers once and exits: there is no interactive session to talk to. Run claude -p on its own.',
  '--print': '--print answers once and exits: there is no interactive session to talk to. Run claude --print on its own.',
  '--settings': "Claude keeps only the last --settings, so yours would replace the companion's hooks. Put those settings in .claude/settings.local.json or ~/.claude/settings.json instead.",
};
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export class ArgumentConflict extends Error {}

// The voice channel's MCP server name must stay the companion's.
function definesVoiceServer(config: string) {
  let text = config;
  if (!config.trimStart().startsWith('{')) { try { text = fs.readFileSync(config, 'utf8'); } catch { return false; } }
  try { return Object.hasOwn(JSON.parse(text).mcpServers ?? {}, 'voice'); } catch { return false; }
}

export function readClaudeArgs(args: readonly string[]): AgentArguments {
  if (args.length && COMMANDS.has(args[0])) return { direct: true, resume: false, assignSession: false };
  let sessionId: string | undefined, resumeId: string | undefined, resume = false, fork = false, choosesSession = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break; // The rest is Claude's prompt.
    if (!arg.startsWith('-')) continue;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (DIRECT.has(name)) return { direct: true, resume: false, assignSession: false };
    if (Object.hasOwn(CONFLICTS, name)) throw new ArgumentConflict(CONFLICTS[name]);
    const next = args[i + 1];
    const value = inline ?? (ONE_VALUE.has(name) || (OPTIONAL_VALUE.has(name) && next !== undefined && !next.startsWith('-')) ? next : undefined);
    if (inline === undefined && value !== undefined) i++;
    if (VARIADIC.has(name)) {
      const values = inline !== undefined ? [inline] : [];
      while (inline === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
      if (name === '--mcp-config' && values.some(definesVoiceServer)) throw new ArgumentConflict('--mcp-config defines an MCP server named "voice", which would replace the companion\'s voice channel. Rename that server.');
    }
    if (name === '--session-id') {
      if (!value || !UUID.test(value)) throw new ArgumentConflict('--session-id needs a full session UUID.');
      sessionId = value; choosesSession = true;
    }
    if (name === '-r' || name === '--resume') { resume = true; choosesSession = true; if (value && UUID.test(value)) resumeId = value; }
    if (name === '-c' || name === '--continue' || name === '--from-pr' || name === '--teleport') { resume = true; choosesSession = true; }
    if (name === '--fork-session') fork = true;
  }
  // A fork gets a new ID from Claude; learn it from the first hook.
  return { direct: false, resume, sessionId: fork ? undefined : sessionId ?? resumeId, assignSession: !choosesSession };
}
