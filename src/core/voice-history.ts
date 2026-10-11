export interface TranscriptDelta { type: string; delta: string; start_ms: number; end_ms: number }
export interface TranscriptFragment { seq: number; role: 'operator' | 'intermediary'; text: string; startMs: number; endMs: number; receivedAt: number; carried?: boolean }
/** One speaker's speech until they pause for over 2 seconds. */
export type Utterance = Pick<TranscriptFragment, 'role' | 'text' | 'endMs'>;
/** A spoken turn as kept for resuming the conversation. */
export type Turn = Pick<Utterance, 'role' | 'text'>;
export interface SpokenRequest { utterances: Utterance[]; through: number; unheard?: string[] }
// Any sample louder than this is sound; the page's gate sends exact silence, which echoes back at about 1.
const SOUND_PEAK = 64;

// Each speaker's speech joins until they pause, so the other speaker's
// backchannels never split it.
function utterances(fragments: readonly TranscriptFragment[]): Utterance[] {
  const joined: Utterance[] = [], open = new Map<Utterance['role'], Utterance>();
  for (const { role, text, startMs, endMs } of fragments) {
    const last = open.get(role);
    if (last && startMs - last.endMs <= 2000) { last.text += text; last.endMs = endMs; }
    else { const next = { role, text, endMs }; joined.push(next); open.set(role, next); }
  }
  return joined.filter(u => u.text.trim());
}

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
  /** Operator words GPT Live transcribed from silence (see audible). */
  unheard(fragment: TranscriptFragment) { return fragment.role === 'operator' && !fragment.carried && this.audible(fragment.startMs, fragment.endMs) === false; }
  // The conversation since the previous delegation: anything said before it went
  // with the previous request. Transcript arrival can lag the delegation event,
  // so the caller waits briefly before taking this snapshot, and speech starting
  // more than 3 s after the delegation is left for the next request.
  request(offsetMs: number): SpokenRequest | null {
    const all = this.fragments.filter(f => f.seq > this.delegatedThrough && f.startMs <= offsetMs + 3000);
    const unheard = all.filter(f => this.unheard(f));
    const spoken = utterances(all.filter(f => !unheard.includes(f)));
    if (!spoken.some(u => u.role === 'operator')) return null;
    return { utterances: spoken, through: all.at(-1)!.seq, ...unheard.length ? { unheard: unheard.map(f => f.text) } : {} };
  }
  markDelivered(request: SpokenRequest) { this.delegatedThrough = Math.max(this.delegatedThrough, request.through); }
  /** This connection's own conversation, for resuming it in a later one. */
  turns(): Turn[] { return utterances(this.fragments.filter(f => !f.carried && !this.unheard(f))).map(({ role, text }) => ({ role, text: text.replace(/\s+/g, ' ').trim() })); }
  /** Speech a dropped connection had not passed on, placed before this one's so that its next request includes it. */
  carry(from: VoiceHistory) {
    const pending = from.fragments.filter(f => f.seq > from.delegatedThrough && !from.unheard(f));
    const shift = (pending.at(-1)?.endMs ?? 0) + 5000;
    for (const f of pending) this.fragments.push({ ...f, seq: this.fragments.length, startMs: f.startMs - shift, endMs: f.endMs - shift, carried: true });
  }
}
