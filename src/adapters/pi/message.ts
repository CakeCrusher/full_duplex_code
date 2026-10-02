import type { ReceivedRequest, VoiceRequest } from '../../core/adapter.ts';

// A voice request as Pi receives it: labeled, so Pi and the timeline can tell it
// from typed input. Shared by the extension, which sends it, and the observer,
// which recognizes it when Pi reports it as input.
export const turnText = ({ id, content }: Pick<VoiceRequest, 'id' | 'content'>) => `[Voice request ${id}]\n${content}`;
export function receivedRequest(prompt: string): ReceivedRequest | undefined {
  const match = prompt.match(/^\[Voice request ([0-9a-f-]{36})\]\n([\s\S]*)$/);
  return match ? { id: match[1], content: match[2] } : undefined;
}
