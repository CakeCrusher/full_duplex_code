// Shared by the channel writer and inspector so preview and transport cannot
// silently acquire different wrappers or metadata. MCP adds jsonrpc on write.
export function channelNotification({ id, content }) {
  return { jsonrpc: '2.0', method: 'notifications/claude/channel', params: {
    content, meta: { message_id: id, source_kind: 'voice_operator' },
  } };
}
