// Live accepts text context, not image/audio attachments. Keep complete records
// in the observer and audit log, but never inject their base64 bytes as prose.
// All ordinary text, code, tool results and attachment metadata remain.
export function thinkingText(text: string): string {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return text; }
  function visit(value: any): any {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, any> = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (['image', 'audio', 'document'].includes(value.type)) {
      // Tools report the same attachment in different shapes: file.base64 (a
      // file-reading tool), source.data (API content blocks) or data with a
      // mimeType (MCP content).
      if (typeof value.file?.base64 === 'string') {
        result.file = { ...result.file, base64: `[${value.file.base64.length} encoded characters retained in the local hook log; binary attachment is not visible to the voice model]` };
      }
      if (value.source?.type === 'base64' && typeof value.source.data === 'string') {
        result.source = { ...value.source, data: `[${value.source.data.length} encoded characters retained in the local hook log; binary attachment is not visible to the voice model]` };
      }
      if (typeof value.data === 'string' && typeof value.mimeType === 'string') {
        result.data = `[${value.data.length} encoded characters retained in the local hook log; binary attachment is not visible to the voice model]`;
      }
    }
    return result;
  }
  return JSON.stringify(visit(data));
}
