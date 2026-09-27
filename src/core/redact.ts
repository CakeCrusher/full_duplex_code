export function redact(text: unknown, secrets: unknown[] = []): string {
  let result = String(text ?? '');
  for (const secret of secrets.filter((s): s is string => typeof s === 'string' && s.length > 8)) result = result.split(secret).join('[redacted]');
  return result.replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted API key]');
}
