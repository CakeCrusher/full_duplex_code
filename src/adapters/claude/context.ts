import type { ContextRule } from '../../core/adapter.ts';

// What of Claude's events reaches GPT Live. Anything not listed is sent as it is;
// image and PDF bytes are omitted by the core for every agent.
export const claudeContext: ContextRule[] = [
  // Hook transport fields, not part of what Claude did. CwdChanged names its own old_cwd and new_cwd.
  { key: ['session_id', 'transcript_path', 'agent_transcript_path', 'scratchpad_dir', 'cwd', 'permission_mode', 'prompt_id', 'effort',
    'turn_id', 'stop_hook_active', 'hook_event_name', 'tool_use_id', 'message_id', 'index', 'final', 'session_crons'], remove: true },
  // Stop repeats the text MessageDisplay already carried; PostToolBatch repeats each PostToolUse.
  { event: 'Stop', remove: true },
  { event: 'PostToolBatch', remove: true },
  // Whole files: the one being written (its result repeats it, and an overwrite's patch
  // spans all of it) and the one before an edit or overwrite.
  { where: { tool_name: 'Write' }, key: ['tool_input.content', 'tool_response.content', 'tool_response.structuredPatch'], truncate: 1200 },
  { key: 'tool_response.originalFile', truncate: 1200 },
  // The text of a file read, and the pages of a PDF read as images.
  { where: { tool_name: 'Read' }, key: 'tool_response.file.content', truncate: 1200 },
  { where: { tool_name: 'Read' }, key: 'tool_response.pages', truncate: 0 },
  // Command output. The command and stderr are always whole.
  { where: { tool_name: 'Bash' }, key: 'tool_response.stdout', truncate: 1200 },
];
