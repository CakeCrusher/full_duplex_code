import type { ContextRule } from '../../core/adapter.ts';

// What of Codex's events reaches GPT Live, by the rules of Claude's table. Stop
// stays: the observer already sends a final message only when the transcript has
// not. Anything not listed is sent as it is; image bytes are omitted by the core.
export const codexContext: ContextRule[] = [
  // Hook transport fields, not part of what Codex did.
  { key: ['session_id', 'transcript_path', 'agent_transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'turn_id', 'tool_use_id', 'stop_hook_active'], remove: true },
  // A patch can carry whole files, as Claude's Write does; its result names the files.
  { where: { tool_name: 'apply_patch' }, key: 'tool_input.command', truncate: 1200 },
  // Command output, with stderr in the same string, and web results. A command is always whole.
  { where: { tool_name: 'Bash' }, key: 'tool_response', truncate: 1200 },
  { where: { tool_name: 'webrun' }, key: 'tool_response', truncate: 1200 },
];
