import fs from 'node:fs';
import path from 'node:path';
import { hookCommand } from '../../core/hook-command.ts';

// Passive observations only. WorktreeCreate is deliberately absent: merely
// installing that hook replaces Claude's own worktree creation implementation.
export const OBSERVED_HOOKS = [
  'SessionStart', 'Setup', 'InstructionsLoaded', 'UserPromptSubmit', 'UserPromptExpansion',
  'MessageDisplay', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'StopFailure',
  'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeRemove',
  'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch',
  'Elicitation', 'ElicitationResult', 'SessionEnd',
];
export interface ClaudeConfig { mcpFile: string; settingsFile: string }

// The run's MCP configuration (the voice channel) and settings (every hook runs
// the relay), both private to this run.
export function makeClaudeConfig({ root, runDir, baseUrl, channelToken }: { root: string; runDir: string; baseUrl: string; channelToken: string }): ClaudeConfig {
  const mcp = { mcpServers: { voice: { command: process.execPath, args: [path.join(root, 'src/adapters/claude/channel-server.ts')], env: { FD_BRIDGE_URL: baseUrl.replace('http:', 'ws:') + '/channel', FD_BRIDGE_TOKEN: channelToken } } } };
  const hooks: Record<string, unknown> = {};
  const [command, ...args] = hookCommand(root, baseUrl);
  for (const name of OBSERVED_HOOKS) hooks[name] = [{ hooks: [{ type: 'command', command, args, timeout: 2 }] }];
  const mcpFile = path.join(runDir, 'mcp.json'); const settingsFile = path.join(runDir, 'settings.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  return { mcpFile, settingsFile };
}

// The companion's options go first, the operator's own arguments after them,
// unchanged. --settings is last: a single-value option, so the variadic channel
// option before it can never take the operator's prompt as a server name.
export function claudeArgs({ config, sessionId, extraArgs = [] }: { config: ClaudeConfig; sessionId?: string; extraArgs?: readonly string[] }): string[] {
  return [
    '--mcp-config', config.mcpFile,
    '--dangerously-load-development-channels', 'server:voice',
    ...(sessionId ? ['--session-id', sessionId] : []),
    '--settings', config.settingsFile,
    ...extraArgs,
  ];
}
