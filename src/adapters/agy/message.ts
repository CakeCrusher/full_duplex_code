import type { ReceivedRequest, VoiceRequest } from '../../core/adapter.ts';

// A voice request as Antigravity receives it: labeled, so Antigravity and the timeline can tell it from typed input. It
// reaches the conversation as a user message that the companion's hook adds before a model call (delivery.ts), which
// Antigravity records, like typed input, inside <USER_REQUEST> tags followed by metadata of its own.
export const turnText = ({ id, content }: Pick<VoiceRequest, 'id' | 'content'>) => `[Voice request ${id}]\n${content}`;

/** The words of a user message as Antigravity records it, without its tags and the metadata after them (the time, a setting changed). */
export function requestText(content: string): string {
  return content.match(/^<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/)?.[1] ?? content;
}

export function receivedRequest(prompt: string): ReceivedRequest | undefined {
  const match = requestText(prompt).match(/^\[Voice request ([0-9a-f-]{36})\]\n([\s\S]*)$/);
  return match ? { id: match[1], content: match[2] } : undefined;
}

// Starts a turn while Antigravity is idle: a message to the conversation through its language server (agentapi), which
// wakes it as a background task's completion would. Antigravity records it as a system message "not actually sent by the
// user", so it carries no request: the request itself comes with the turn's first model call, as the operator's message.
export const WAKE = 'Full-Duplex Code: the operator spoke to you by voice, and their words are their message in this turn. If there is no such message, there is nothing to do: reply with one word, Waiting.';

// A new conversation's first message, which fdc passes as Antigravity starts (-i): Antigravity opens a conversation only
// with a first message, and only an open one can be reached. Answered with a word, one short model call.
export const GREETING = 'Voice is on (Full-Duplex Code): the user may now speak requests to you through its voice companion. Reply with one word: Ready.';
// A fork's first message, which opens it in its window (-i) as soon as agy has loaded it: what the fork is for. The
// request that opened the fork comes with it, at the same model call.
export const forkOpening = (note: string) => `Full-Duplex Code: ${note}`;
