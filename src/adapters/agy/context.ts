import type { ContextRule } from '../../core/adapter.ts';

// What of Antigravity's events reaches GPT Live. The observer builds each record from what its source says, without the
// hooks' transport fields; anything not listed is sent as it is, and image bytes are omitted by the core.
export const agyContext: ContextRule[] = [
  // fdc's own first message, which opens a new conversation or a fork.
  { event: 'OPENING', remove: true },
  // What a tool was asked: a whole file being written, or an edit's text, can be long (a path or a command is short).
  { event: 'TOOL_RESULT', key: 'args', truncate: 1500 },
  { event: 'TOOL_CALL', key: 'calls.args', truncate: 1500 },
  { event: 'ToolConfirmation', key: 'args', truncate: 1500 },
  // What it answered: a file read, a command's output, a page fetched.
  { event: 'TOOL_RESULT', key: 'output', truncate: 1200 },
  // Antigravity's notes in the conversation, such as a background task's end with its output.
  { event: 'SYSTEM_MESSAGE', key: 'text', truncate: 800 },
];
