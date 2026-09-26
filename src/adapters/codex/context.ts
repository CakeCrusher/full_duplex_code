import type { ContextRules } from '../../core/adapter.ts';

// Hook transport fields, not part of what Codex did.
const METADATA = new Set(['session_id', 'transcript_path', 'agent_transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'turn_id', 'tool_use_id', 'stop_hook_active']);

export const codexContext: ContextRules = {
  isMetadata: key => METADATA.has(key),
  essentials: data => ({ tool_name: data.tool_name, command: data.tool_input?.command, error: data.error }),
};
