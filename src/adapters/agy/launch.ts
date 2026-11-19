import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hookCommand } from '../../core/hook-command.ts';
import { browserSocket } from '../../core/browser.ts';

// What Antigravity loads for an fdc session: a plugin of fdc's (its hooks, which run the relay, and its rules, which hold
// fdc's instructions and so reach the system prompt of every conversation, new or resumed, and after compaction). agy
// takes a plugin from a folder of the workspace, so fdc adds one of its own (--add-dir): the operator's project and their
// own configuration are left as they are.
//
// One folder per project, rewritten as each session starts. agy keeps the workspace a conversation was made in and, on
// resuming it or opening a fork of it, runs the plugin of that folder over a same-named one the command line adds
// (agy 1.5.12): a folder of each session's own left the resumed conversation with hooks to a bridge long closed. Emptied as
// fdc stops, so agy run without fdc on such a conversation runs none of it. Another fdc already running in the project
// keeps it: this session gets a folder of its own (and a conversation made by that other one resumes here without hooks).
//
// agy lists workspace folders in order of their paths, and the agent works in the first: the system's temporary folder
// (/var/folders on macOS, /tmp) comes after any project. The folder is read-only to the agent, and its rules say it is
// not the project.

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const PLUGIN = 'fdc-voice';
// The events fdc follows. Never PreToolUse: agy reads an answer without a decision as a denial, and blocks every tool.
const EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop'];
// Matched by tool for tool events, and listed flat for the others (agy's hooks.json).
const TOOL_EVENTS = new Set(['PostToolUse']);

export interface AgyPlugin { workspace: string; rules: string; hooks: string; /** The project's own folder, rather than one of this session's. */ shared: boolean; /** Its MCP servers, when it brings the browser tools. */ servers?: string }
export interface McpServer { command: string; args: string[]; env: Record<string, string> }

/**
 * Open Claude in Chrome's MCP server, as Chrome finds its native host: the browser tools the voice presents pages
 * through (fdc reaches the same pages by the same host: browser.ts). The operator gives them to Claude, Codex and Pi in
 * their own configuration; agy gets them from fdc's plugin, unless its own MCP configuration has them already. agy asks
 * before each call to them, as for any MCP tool, unless the operator allows it.
 */
export function browserServer(home = os.homedir()): McpServer | undefined {
  const config = (() => { try { return fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'); } catch { return ''; } })();
  if (config.includes('open-claude-in-chrome')) return;
  for (const dir of ['Library/Application Support/Google/Chrome/NativeMessagingHosts', '.config/google-chrome/NativeMessagingHosts']) {
    let host: string;
    try { host = path.dirname(JSON.parse(fs.readFileSync(path.join(home, dir, 'com.anthropic.open_claude_in_chrome.json'), 'utf8')).path); } catch { continue; }
    // Its plain server: the hybrid one beside it also starts a code runner, which the browser tools don't need.
    for (const script of ['mcp-server.js', 'codemode/server-hybrid.js']) if (fs.existsSync(path.join(host, script))) return { command: process.execPath, args: [path.join(host, script)], env: { OCIC_PIPE: browserSocket() } };
  }
}

/** The project's plugin folder: in the temporary folder, by the project's path. */
export const projectFolder = (cwd: string, tmp = os.tmpdir()) => path.join(tmp, PLUGIN, createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 12));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const writable = (folder: string) => { for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600); fs.chmodSync(folder, 0o700); };

/** Writes the session's plugin (its hooks go to `baseUrl`'s /hook) into the project's folder, unless another fdc holds it, and returns where its parts are. */
export function writePlugin({ root, baseUrl, instructions, cwd, tmp = os.tmpdir(), browser }: { root: string; baseUrl: string; instructions: string; cwd: string; tmp?: string; browser?: McpServer }): AgyPlugin {
  let workspace = projectFolder(cwd, tmp), shared = true;
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const owner = path.join(workspace, '.owner');
  let held: number | undefined; try { held = Number(fs.readFileSync(owner, 'utf8')); } catch {}
  if (held && held !== process.pid && alive(held)) { workspace = fs.mkdtempSync(path.join(tmp, `${PLUGIN}-`)); shared = false; }
  else { writable(workspace); fs.writeFileSync(owner, String(process.pid)); }
  const dir = path.join(workspace, '.agents', 'plugins', PLUGIN);
  fs.mkdirSync(path.join(dir, 'rules'), { recursive: true, mode: 0o700 });
  const handler = { type: 'command', command: hookCommand(root, baseUrl).map(quote).join(' '), timeout: 10 };
  const hooks = path.join(dir, 'hooks.json'), rules = path.join(dir, 'rules', 'AGENTS.md');
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: PLUGIN, description: "Full-Duplex Code's voice companion: its hooks and instructions, while fdc runs." }, null, 2));
  fs.writeFileSync(hooks, JSON.stringify({ [PLUGIN]: Object.fromEntries(EVENTS.map(event => [event, TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler] }] : [handler]])) }, null, 2));
  fs.writeFileSync(rules, `${instructions}\n\nThe workspace folder ${workspace} is Full-Duplex Code's own (its hooks and these instructions): it is not part of the user's project, which is ${cwd}. Work in the project, never in that folder.\n`);
  const servers = path.join(dir, 'mcp_config.json');
  if (browser) fs.writeFileSync(servers, JSON.stringify({ mcpServers: { 'open-claude-in-chrome': browser } }, null, 2)); else fs.rmSync(servers, { force: true });
  readOnly(workspace);
  return { workspace, rules, hooks, shared, ...browser && { servers } };
}

// Read-only, so that nothing is made there by mistake.
function readOnly(workspace: string) {
  for (const entry of fs.readdirSync(workspace, { recursive: true, withFileTypes: true })) if (!entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o444);
  for (const entry of fs.readdirSync(workspace, { recursive: true, withFileTypes: true })) if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o555);
  fs.chmodSync(workspace, 0o555);
}

/** As fdc stops: the plugin is emptied (no hooks, no rules), so agy run without fdc on a conversation made here runs none of it; a session's own folder is removed. */
export function releasePlugin(plugin: AgyPlugin) {
  try {
    writable(plugin.workspace);
    if (!plugin.shared) return fs.rmSync(plugin.workspace, { recursive: true, force: true });
    fs.writeFileSync(plugin.hooks, '{}\n'); fs.writeFileSync(plugin.rules, ''); if (plugin.servers) fs.rmSync(plugin.servers, { force: true });
    fs.rmSync(path.join(plugin.workspace, '.owner'), { force: true });
    readOnly(plugin.workspace);
  } catch {}
}
