export interface TranscriptDelta { type: string; delta: string; start_ms: number; end_ms: number }
export interface TranscriptFragment { seq: number; role: 'operator' | 'intermediary'; text: string; startMs: number; endMs: number; receivedAt: number }
/** One speaker's speech until they pause for over 2 seconds. */
export type Utterance = Pick<TranscriptFragment, 'role' | 'text' | 'endMs'>;
export interface SpokenRequest { utterances: Utterance[]; through: number }

// Transcripts of one voice connection, and how far they have been delegated.
export class VoiceHistory {
  fragments: TranscriptFragment[] = [];
  delegatedThrough = -1;
  lastInputAt = 0;
  add(event: TranscriptDelta): TranscriptFragment {
    const role = event.type === 'session.input_transcript.delta' ? 'operator' : 'intermediary';
    const fragment: TranscriptFragment = { seq: this.fragments.length, role, text: event.delta, startMs: event.start_ms, endMs: event.end_ms, receivedAt: Date.now() };
    this.fragments.push(fragment);
    if (role === 'operator') this.lastInputAt = fragment.receivedAt;
    return fragment;
  }
  // The conversation since the previous delegation: anything said before it went
  // with the previous request. Transcript arrival can lag the delegation event,
  // so the caller waits briefly before taking this snapshot, and speech starting
  // more than 3 s after the delegation is left for the next request.
  request(offsetMs: number): SpokenRequest | null {
    const since = this.fragments.filter(f => f.seq > this.delegatedThrough && f.startMs <= offsetMs + 3000);
    // Each speaker's speech joins until they pause, so the other speaker's
    // backchannels never split it.
    const utterances: Utterance[] = [], open = new Map<Utterance['role'], Utterance>();
    for (const { role, text, startMs, endMs } of since) {
      const last = open.get(role);
      if (last && startMs - last.endMs <= 2000) { last.text += text; last.endMs = endMs; }
      else { const next = { role, text, endMs }; utterances.push(next); open.set(role, next); }
    }
    const spoken = utterances.filter(u => u.text.trim());
    return spoken.some(u => u.role === 'operator') ? { utterances: spoken, through: since.at(-1)!.seq } : null;
  }
  markDelivered(request: SpokenRequest) { this.delegatedThrough = Math.max(this.delegatedThrough, request.through); }
}
