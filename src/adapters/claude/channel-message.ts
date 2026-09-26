import type { ReceivedRequest } from '../../core/adapter.ts';

// Shared by the channel writer and inspector so preview and transport cannot
// silently acquire different wrappers or metadata. MCP adds jsonrpc on write.
export function channelNotification({ id, content }: { id: string; content: string }) {
  return { jsonrpc: '2.0', method: 'notifications/claude/channel', params: {
    content, meta: { message_id: id, source_kind: 'voice_operator' },
  } } as const;
}

// Claude shows a channel message to its hooks as
// <channel source="voice" message_id="…" …>\n…content…\n</channel>.
export function receivedRequest(prompt: string): ReceivedRequest | undefined {
  const attributes = prompt.match(/^<channel\s([^>]*)>/)?.[1];
  const id = attributes && /\bsource="voice"/.test(attributes) ? attributes.match(/\bmessage_id="([^"]+)"/)?.[1] : undefined;
  if (!id) return undefined;
  return { id, content: prompt.match(/^<channel\s[^>]*>\r?\n([\s\S]*)\r?\n<\/channel>$/)?.[1] };
}
