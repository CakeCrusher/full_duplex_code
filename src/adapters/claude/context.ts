import type { ContextRules } from '../../core/adapter.ts';

// Hook transport fields, not part of what Claude did.
const METADATA = new Set(['session_id', 'transcript_path', 'scratchpad_dir', 'permission_mode', 'prompt_id', 'effort', 'turn_id', 'stop_hook_active', 'hook_event_name', 'tool_use_id', 'message_id', 'index', 'final', 'session_crons']);

export const claudeContext: ContextRules = {
  // Every hook carries the working directory; it matters only when it changes.
  isMetadata: (key, name) => METADATA.has(key) || (key === 'cwd' && name !== 'CwdChanged'),
  essentials(data) {
    const result = data.tool_response;
    return { tool_name: data.tool_name, error: data.error, exitCode: result?.exitCode ?? result?.exit_code,
      stderr: result?.stderr, file_path: data.tool_input?.file_path ?? result?.filePath };
  },
};
