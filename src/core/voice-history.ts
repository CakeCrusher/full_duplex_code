export interface TranscriptDelta { type: string; delta: string; start_ms: number; end_ms: number }
export interface TranscriptFragment { seq: number; role: 'operator' | 'intermediary'; text: string; startMs: number; endMs: number; receivedAt: number }
export interface SpokenRequest { text: string; context: string; through: number }

// Transcripts of one voice connection, and which operator speech was delegated.
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
  request(offsetMs: number): SpokenRequest | null {
    // Transcript arrival can lag the delegation event. The caller waits briefly
    // before taking this snapshot; no transcript fragment itself triggers work.
    const eligible = this.fragments.filter(f => f.role === 'operator' && f.seq > this.delegatedThrough && f.startMs <= offsetMs + 3000);
    if (!eligible.length) return null;
    // Earlier questions may have been answered without delegation. Keep them
    // as context, not part of a later command. A pause separates utterances;
    // Live backchannels alone must not split the operator's full-duplex speech.
    let start = eligible.length - 1;
    while (start > 0 && eligible[start].startMs - eligible[start - 1].endMs <= 2000) start--;
    const newest = eligible.slice(start);
    const before = this.fragments.filter(f => f.seq < newest[0].seq).slice(-80);
    const context = before.reduce<{ role: string; text: string }[]>((lines, f) => {
      const last = lines.at(-1);
      if (last?.role === f.role) last.text += f.text;
      else lines.push({ role: f.role, text: f.text });
      return lines;
    }, []).map(f => `${f.role}: ${f.text}`).join('\n').slice(-6000);
    const text = newest.map(f => f.text).join('');
    return { text, context, through: newest.at(-1)!.seq };
  }
  markDelivered(request: SpokenRequest) { this.delegatedThrough = Math.max(this.delegatedThrough, request.through); }
}
