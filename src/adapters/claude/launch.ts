import fs from 'node:fs';
import path from 'node:path';

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
// Claude waits for some hooks, so the relay must start quickly. Node strips a
// .ts file's types on every start unless its compile cache is on; this turns
// the cache on before the relay loads. Percent-encoded, so no shell quoting applies.
export const COMPILE_CACHE = 'data:text/javascript,' + encodeURIComponent("import{enableCompileCache}from'node:module';enableCompileCache()").replace(/[()']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// The run's MCP configuration (the voice channel) and settings (every hook runs
// the relay), both private to this run.
export function makeClaudeConfig({ root, runDir, baseUrl, channelToken }: { root: string; runDir: string; baseUrl: string; channelToken: string }): ClaudeConfig {
  const mcp = { mcpServers: { voice: { command: process.execPath, args: [path.join(root, 'src/adapters/claude/channel-server.ts')], env: { FD_BRIDGE_URL: baseUrl.replace('http:', 'ws:') + '/channel', FD_BRIDGE_TOKEN: channelToken } } } };
  const hooks: Record<string, unknown> = {};
  for (const name of OBSERVED_HOOKS) {
    hooks[name] = [{ hooks: [{ type: 'command', command: process.execPath, args: ['--import', COMPILE_CACHE, path.join(root, 'src/core/hook-relay.ts'), baseUrl + '/hook'], timeout: 2 }] }];
  }
  const mcpFile = path.join(runDir, 'mcp.json'); const settingsFile = path.join(runDir, 'settings.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  return { mcpFile, settingsFile };
}

export function claudeArgs({ config, sessionId, resume = false, extraArgs = [] }: { config: ClaudeConfig; sessionId: string; resume?: boolean; extraArgs?: string[] }): string[] {
  return [
    '--mcp-config', config.mcpFile, '--settings', config.settingsFile,
    '--dangerously-load-development-channels', 'server:voice',
    resume ? '--resume' : '--session-id', sessionId,
    ...extraArgs,
  ];
}
