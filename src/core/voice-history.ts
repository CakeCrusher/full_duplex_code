export interface TranscriptDelta { type: string; delta: string; start_ms: number; end_ms: number }
export interface TranscriptFragment { seq: number; role: 'operator' | 'intermediary'; text: string; startMs: number; endMs: number; receivedAt: number }
/** One speaker's speech until they pause for over 2 seconds. */
export type Utterance = Pick<TranscriptFragment, 'role' | 'text' | 'endMs'>;
export interface SpokenRequest { utterances: Utterance[]; through: number; unheard?: string[] }
// Any sample louder than this is sound; the page's gate sends exact silence, which echoes back at about 1.
const SOUND_PEAK = 64;

// Transcripts of one voice connection, and how far they have been delegated.
export class VoiceHistory {
  fragments: TranscriptFragment[] = [];
  delegatedThrough = -1;
  lastInputAt = 0;
  /** GPT Live's echo of the audio it heard from the operator (WebRTC only): each stretch and its loudest sample. */
  heard: { startMs: number; endMs: number; peak: number }[] = [];
  add(event: TranscriptDelta): TranscriptFragment {
    const role = event.type === 'session.input_transcript.delta' ? 'operator' : 'intermediary';
    const fragment: TranscriptFragment = { seq: this.fragments.length, role, text: event.delta, startMs: event.start_ms, endMs: event.end_ms, receivedAt: Date.now() };
    this.fragments.push(fragment);
    if (role === 'operator') this.lastInputAt = fragment.receivedAt;
    return fragment;
  }
  hearAudio({ audio, start_ms: startMs, end_ms: endMs }: { audio: string; start_ms: number; end_ms: number }) {
    const pcm = Buffer.from(audio, 'base64'); let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    this.heard.push({ startMs, endMs, peak });
    while (this.heard.length && this.heard[0].endMs < endMs - 300000) this.heard.shift();
  }
  /**
   * Whether GPT Live heard any sound around a stretch of its transcript: false only when its echo
   * covers the stretch, a second either side included, and all of it was silence. GPT Live's
   * transcript of the operator sometimes holds words it heard in silence, such as text from its
   * own context; those were never said.
   */
  audible(startMs: number, endMs: number): boolean | undefined {
    const from = startMs - 1000, to = endMs + 1000;
    const around = this.heard.filter(h => h.endMs > from && h.startMs < to);
    if (around.some(h => h.peak > SOUND_PEAK)) return true;
    const covered = around.reduce((sum, h) => sum + Math.min(h.endMs, to) - Math.max(h.startMs, from), 0);
    return covered >= .9 * (to - from) ? false : undefined;
  }
  // The conversation since the previous delegation: anything said before it went
  // with the previous request. Transcript arrival can lag the delegation event,
  // so the caller waits briefly before taking this snapshot, and speech starting
  // more than 3 s after the delegation is left for the next request.
  request(offsetMs: number): SpokenRequest | null {
    const all = this.fragments.filter(f => f.seq > this.delegatedThrough && f.startMs <= offsetMs + 3000);
    const unheard = all.filter(f => f.role === 'operator' && this.audible(f.startMs, f.endMs) === false);
    const since = all.filter(f => !unheard.includes(f));
    // Each speaker's speech joins until they pause, so the other speaker's
    // backchannels never split it.
    const utterances: Utterance[] = [], open = new Map<Utterance['role'], Utterance>();
    for (const { role, text, startMs, endMs } of since) {
      const last = open.get(role);
      if (last && startMs - last.endMs <= 2000) { last.text += text; last.endMs = endMs; }
      else { const next = { role, text, endMs }; utterances.push(next); open.set(role, next); }
    }
    const spoken = utterances.filter(u => u.text.trim());
    const through = all.at(-1)?.seq ?? this.delegatedThrough;
    if (!spoken.some(u => u.role === 'operator')) return null;
    return { utterances: spoken, through, ...unheard.length ? { unheard: unheard.map(f => f.text) } : {} };
  }
  markDelivered(request: SpokenRequest) { this.delegatedThrough = Math.max(this.delegatedThrough, request.through); }
}
