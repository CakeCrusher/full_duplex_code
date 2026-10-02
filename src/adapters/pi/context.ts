import type { ContextRule } from '../../core/adapter.ts';

// What of Pi's events reaches GPT Live, by the rules of Claude's table. Anything
// not listed is sent as it is; image bytes are omitted by the core.
export const piContext: ContextRule[] = [
  // Transport fields, not part of what Pi did.
  { key: ['session_id', 'session_file', 'toolCallId', 'parentToolCallId', 'cwd'], remove: true },
  // A finished message repeats an event already sent: the operator's input, a
  // tool's end, or Pi's system prompt. The assistant's reply is the one to keep.
  { event: 'message_end', where: { 'message.role': 'user' }, remove: true },
  { event: 'message_end', where: { 'message.role': 'toolResult' }, remove: true },
  { event: 'message_end', where: { 'message.role': 'system' }, remove: true },
  // In a reply: the provider's bookkeeping, signatures that encrypt the model's
  // reasoning, private reasoning, and tool arguments that tool_execution_start carries.
  { event: 'message_end', key: ['message.api', 'message.provider', 'message.model', 'message.usage', 'message.timestamp', 'message.responseId',
    'message.rawStopReason', 'message.thinkingLevel', 'message.content.thinkingSignature', 'message.content.textSignature',
    'message.content.thinking', 'message.content.id', 'message.content.arguments'], remove: true },
  // When Pi cuts a tool's output short, it keeps a copy of the output it kept, beside
  // the facts of the cut (bash, read, grep, find, ls). The output itself is in content.
  { key: 'result.details.truncation.content', remove: true },
  // A model is a long definition; its name comes first.
  { event: 'model_select', key: ['model', 'previousModel'], truncate: 200 },
  // The whole file being written, and the text of a file read.
  { where: { toolName: 'write' }, key: 'args.content', truncate: 1200 },
  { where: { toolName: 'read' }, key: 'result.content.text', truncate: 1200 },
  // An edit's patch repeats its diff.
  { where: { toolName: 'edit' }, key: 'result.details.patch', remove: true },
  // Command output, with stderr in the same text as in Codex, and its second copy
  // for scripts. The command is always whole.
  { where: { toolName: 'bash' }, key: 'result.content.text', truncate: 1200 },
  { where: { toolName: 'bash' }, key: 'result.structuredContent.output', remove: true },
  // A script's output, which can hold a screenshot as text, and its list of calls:
  // each call inside the script arrives as its own tool events.
  { where: { toolName: 'codemode' }, key: 'result.content.text', truncate: 1200 },
  { where: { toolName: 'codemode' }, key: ['result.details', 'result.nestedCalls'], remove: true },
];
