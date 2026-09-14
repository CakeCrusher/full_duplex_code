import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { TranscriptTail } from './context.js';

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

export function makeClaudeConfig({ root, runDir, baseUrl, channelToken }) {
  const mcp = { mcpServers: { voice: { command: process.execPath, args: [path.join(root, 'src/channel.js')], env: { FD_BRIDGE_URL: baseUrl.replace('http:', 'ws:') + '/channel', FD_BRIDGE_TOKEN: channelToken } } } };
  const hooks = {};
  for (const name of OBSERVED_HOOKS) {
    hooks[name] = [{ hooks: [{ type: 'command', command: process.execPath, args: [path.join(root, 'src/hook.js'), baseUrl + '/hook'], timeout: 2 }] }];
  }
  const mcpFile = path.join(runDir, 'mcp.json'); const settingsFile = path.join(runDir, 'settings.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  return { mcpFile, settingsFile };
}

export function claudeArgs({ config, sessionId, resume = false, extraArgs = [] }) {
  return [
    '--mcp-config', config.mcpFile, '--settings', config.settingsFile,
    '--dangerously-load-development-channels', 'server:voice',
    resume ? '--resume' : '--session-id', sessionId,
    ...extraArgs,
  ];
}

export class AgentObserver extends EventEmitter {
  constructor({ sessionId, observation = 'hooks', clean = String, log = () => {} }) {
    super(); Object.assign(this, { sessionId, observation, clean, log });
    this.state = 'starting'; this.text = ''; this.seen = new Set(); this.hookBatches = new Set();
    this.conversation = []; this.observations = [];
  }
  status(state, detail) { this.state = state; this.emit('status', { state, detail }); }
  remember(role, text) {
    const last = this.conversation.at(-1);
    if (role === 'output' && last?.role === role) last.text += text;
    else this.conversation.push({ role, text });
  }
  conversationContext() { return JSON.stringify(this.conversation); }
  observe(data, kind = 'thinking', emit = true) {
    const observation = { kind, text: this.clean(JSON.stringify(data)) };
    this.observations.push(observation);
    if (emit) this.emit('observation', observation);
  }
  input(text, metadata = {}, emit = true) {
    const safe = this.clean(text ?? ''); if (!safe) return;
    this.remember('input', safe);
    if (emit) this.emit('input', { text: safe, ...metadata });
  }
  textDelta(text, metadata = {}, emit = true) {
    const safe = this.clean(text ?? ''); if (!safe) return;
    this.text += safe;
    this.remember('output', safe);
    if (emit) this.emit('text', { text: safe, ...metadata });
  }
  attachTranscript(file) {
    if (this.transcriptPath === file) return;
    if (!path.isAbsolute(file) || path.basename(file) !== `${this.sessionId}.jsonl`) return;
    this.transcriptPath = file;
    this.log({ type: 'agent.transcript', file, observation: this.observation });
    if (this.observation === 'transcript') {
      this.tail?.stop();
      this.tail = new TranscriptTail(file, event => this.record(event), error => this.emit('fault', error)); this.tail.start();
    } else {
      // Seed resumed sessions with saved prompts and replies. Normal live observation
      // uses display hooks, so the two sources are never blindly merged.
      try {
        const data = fs.readFileSync(file, 'utf8');
        const records = data.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        if (!this.conversation.length) for (const record of records) this.record(record, { emit: false });
      } catch (err) { if (err.code !== 'ENOENT') this.emit('fault', err); }
    }
  }
  record(event, { emit = true } = {}) {
    // Claude stores channel-delivered operator prompts as metadata. They still
    // belong to this conversation; exclude only other internal metadata.
    const channelInput = event.type === 'user' && event.origin?.kind === 'channel';
    if (!['user', 'assistant'].includes(event.type) || event.isSidechain || (event.isMeta && !channelInput) || (event.sessionId && event.sessionId !== this.sessionId)) return;
    const content = event.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
    for (const [index, block] of blocks.entries()) {
      // Resume/fallback also restores tool calls and results. Private reasoning
      // is not part of the visible hook feed and is not imported from disk.
      if (!['text', 'tool_use', 'tool_result'].includes(block.type)) continue;
      const id = event.type === 'user' ? event.uuid ?? event.promptId ?? event.timestamp : event.message.id;
      const key = createHash('sha256').update(`${event.type}:${id}:${index}:${JSON.stringify(block)}`).digest('hex');
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.observe({ source: 'transcript', role: event.type, message_id: id, block }, event.type === 'assistant' && block.type === 'text' ? 'commentary' : 'thinking', emit);
      if (block.type === 'text') {
        if (event.type === 'user') this.input(block.text, { source: 'transcript' }, emit);
        else this.textDelta(block.text, { source: 'transcript' }, emit);
      }
    }
  }
  hook(event) {
    if (event.session_id !== this.sessionId) return false;
    event = JSON.parse(this.clean(JSON.stringify(event)));
    const name = event.hook_event_name;
    if (name === 'MessageDisplay') {
      const key = `${event.agent_id ?? ''}:${event.message_id}:${event.index}`;
      if (this.hookBatches.has(key)) return true;
      this.hookBatches.add(key);
    }
    if (event.transcript_path) this.attachTranscript(event.transcript_path);
    this.log({ type: 'agent.hook', name, ...event });
    this.observe(event, name === 'MessageDisplay' ? 'commentary' : 'thinking');
    // Subagent observations belong in Live context, but their lifecycle must
    // not mark the parent terminal idle or overwrite its current status.
    if (event.agent_id) return true;
    if (name === 'SessionStart') this.status('idle', 'Claude is ready');
    if (name === 'UserPromptSubmit') {
      if (this.observation === 'hooks') this.input(event.prompt, { source: 'prompt_hook' });
      this.status('working', 'Claude received a prompt');
    }
    if (name === 'MessageDisplay' && this.observation === 'hooks') {
      // Stop and the final display hook can arrive in either order. A late
      // display batch must not turn an already-idle agent back into working.
      if (this.state === 'working') this.status('working', 'Claude is responding');
      this.textDelta(event.delta, { source: 'display_hook', messageId: event.message_id, index: event.index, final: event.final });
    }
    if (name === 'PreToolUse') this.status('working', `Claude is using ${event.tool_name}`);
    if (name === 'PostToolUse') this.status('working', `Claude finished ${event.tool_name}`);
    if (name === 'PostToolUseFailure') this.status('working', `${event.tool_name} reported a failure`);
    if (name === 'PermissionRequest') this.status('needs_attention', `${event.tool_name} needs approval in the Claude terminal`);
    if (name === 'Notification' && event.notification_type === 'permission_prompt') this.status('needs_attention', 'Claude needs approval in the terminal');
    if (name === 'Stop' || name === 'StopFailure') {
      const final = this.clean(event.last_assistant_message ?? '');
      const background = event.background_tasks?.length > 0;
      this.status(name === 'StopFailure' ? 'failed' : background ? 'working' : 'idle', name === 'StopFailure' ? 'Claude reported an error' : background ? 'Background work is still running' : 'Claude finished responding');
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        if (final && !this.text.endsWith(final)) this.textDelta(final, { source: 'stop_hook' });
      }, 300);
    }
    if (name === 'SessionEnd') this.status('exited', 'Claude session ended');
    return true;
  }
  close() { clearTimeout(this.stopTimer); this.tail?.stop(); }
}
