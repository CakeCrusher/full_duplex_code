export interface TranscriptDelta { type: string; delta: string; start_ms: number; end_ms: number }
export interface TranscriptFragment {
  seq: number; role: 'operator' | 'intermediary'; text: string; startMs: number; endMs: number; receivedAt: number; carried?: boolean;
  /** The request it is on its way to the agent with; it is taken by no other request meanwhile. */
  claim?: string;
  /** The agent received it. */
  sent?: boolean;
  /** Why it is still here after a request took it: fdc handled that request itself, or its delivery was uncertain. */
  note?: string;
}
/** One speaker's speech until they pause for over 2 seconds. */
export type Utterance = Pick<TranscriptFragment, 'role' | 'text' | 'endMs'>;
/** A spoken turn as kept for resuming the conversation. */
export type Turn = Pick<Utterance, 'role' | 'text'>;
export interface SpokenRequest {
  utterances: Utterance[]; through: number; unheard?: string[];
  /** The fragments it takes. */
  seqs: number[];
  /** Why some of its speech is going again (see TranscriptFragment.note). */
  notes?: string[];
  /** The operator's latest utterance among words no earlier request took: what this request is for. */
  fresh: string;
  /** Their words before it that no earlier request took: GPT Live answered them, or they began what this finishes. */
  earlier?: string;
  /** The fragments of `fresh`. */
  freshSeqs?: number[];
}
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

// Transcripts of one voice connection, and how far they have been delegated: delegatedThrough
// moves only over speech the agent received, so speech fdc handled itself, or whose delivery
// failed or was uncertain, goes with the next request (at least once, never lost).
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
    const heard = this.heard, last = heard.at(-1), loud = peak > SOUND_PEAK;
    // Following on from a stretch of the same kind, sound or silence: one stretch, up to five seconds.
    if (last && startMs >= last.startMs && startMs - last.endMs <= 50 && (last.peak > SOUND_PEAK) === loud && endMs - last.startMs <= 5000) { last.endMs = Math.max(last.endMs, endMs); last.peak = Math.max(last.peak, peak); }
    // The echo arrives in order; a stretch that doesn't is put in its place.
    else if (!last || last.startMs <= startMs) heard.push({ startMs, endMs, peak });
    else heard.splice(this.firstFrom(startMs), 0, { startMs, endMs, peak });
    // The whole session is kept (resumed turns are checked at its end), within reason.
    if (heard.length > 120000) heard.splice(0, 20000);
  }
  /** The first stretch starting at or after `ms`: stretches are kept in order of their start. */
  firstFrom(ms: number) {
    let low = 0, high = this.heard.length;
    while (low < high) { const middle = (low + high) >> 1; if (this.heard[middle].startMs >= ms) high = middle; else low = middle + 1; }
    return low;
  }
  /**
   * Whether GPT Live heard any sound around a stretch of its transcript: false only when its echo
   * covers the stretch, a second either side included, and all of it was silence. GPT Live's
   * transcript of the operator sometimes holds words it heard in silence, such as text from its
   * own context; those were never said.
   */
  audible(startMs: number, endMs: number): boolean | undefined {
    const from = startMs - 1000, to = endMs + 1000, heard = this.heard;
    let covered = 0;
    // No stretch is longer than five seconds, so one that reaches into [from, to] starts after from - 5 s.
    for (let i = this.firstFrom(from - 5000); i < heard.length && heard[i].startMs < to; i++) {
      const stretch = heard[i];
      if (stretch.endMs <= from) continue;
      if (stretch.peak > SOUND_PEAK) return true;
      covered += Math.min(stretch.endMs, to) - Math.max(stretch.startMs, from);
    }
    return covered >= .9 * (to - from) ? false : undefined;
  }
  /** Operator words GPT Live transcribed from silence (see audible). */
  unheard(fragment: TranscriptFragment) { return fragment.role === 'operator' && !fragment.carried && this.audible(fragment.startMs, fragment.endMs) === false; }
  // The conversation since the previous delegation: anything said before it went
  // with the previous request, unless the agent never got it. Transcript arrival can lag the
  // delegation event, so the caller waits briefly before taking this snapshot, and speech
  // starting more than 3 s after the delegation is left for the next request.
  request(offsetMs: number): SpokenRequest | null {
    const all = this.fragments.filter(f => f.seq > this.delegatedThrough && !f.sent && !f.claim && f.startMs <= offsetMs + 3000);
    const unheard = all.filter(f => this.unheard(f));
    const spoken = utterances(all.filter(f => !unheard.includes(f)));
    if (!spoken.some(u => u.role === 'operator')) return null;
    const notes = [...new Set(all.map(f => f.note).filter(note => note !== undefined))];
    const said = utterances(all.filter(f => !f.note && !unheard.includes(f))).filter(u => u.role === 'operator').map(u => u.text.replace(/\s+/g, ' ').trim());
    const fresh = said.at(-1) ?? '', earlier = said.slice(0, -1).join(' ');
    // The latest utterance's own fragments: back from the last new operator piece to a pause of over 2 s.
    const mine = all.filter(f => f.role === 'operator' && !f.note && !unheard.includes(f)), freshSeqs: number[] = [];
    for (let i = mine.length - 1; i >= 0 && (i === mine.length - 1 || mine[i + 1].startMs - mine[i].endMs <= 2000); i--) freshSeqs.unshift(mine[i].seq);
    return { utterances: spoken, through: all.at(-1)!.seq, seqs: all.map(f => f.seq), fresh, freshSeqs, ...earlier ? { earlier } : {}, ...notes.length ? { notes } : {}, ...unheard.length ? { unheard: unheard.map(f => f.text) } : {} };
  }
  /** Notes the operator's latest words that no request took yet (the voice moved the page for them). */
  noteLatest(note: string) {
    const pending = this.fragments.filter(f => f.role === 'operator' && !f.sent && !f.claim && !f.note);
    let noted = 0;
    // The latest utterance: back to a pause of over 2 s.
    for (let i = pending.length - 1; i >= 0 && (i === pending.length - 1 || pending[i + 1].startMs - pending[i].endMs <= 2000); i--) { pending[i].note = note; noted++; }
    return noted;
  }
  /** The request is on its way: no other request takes its speech meanwhile. */
  claim(request: SpokenRequest, id: string) { for (const seq of request.seqs) this.fragments[seq].claim = id; }
  /** The request didn't reach the agent: its speech goes with the next one, with why. */
  release(id: string, note?: string) {
    let released = 0;
    for (const f of this.fragments) if (f.claim === id && !f.sent) { f.claim = undefined; if (note) f.note = note; released++; }
    return released;
  }
  /** The agent received the request. */
  commit(id: string) { this.markSent(this.fragments.filter(f => f.claim === id)); }
  markDelivered(request: SpokenRequest) { this.markSent(request.seqs.map(seq => this.fragments[seq])); }
  markSent(fragments: TranscriptFragment[]) {
    for (const f of fragments) f.sent = true;
    // Only over speech the agent has, with none missing before it.
    while (this.fragments[this.delegatedThrough + 1]?.sent) this.delegatedThrough++;
  }
  /** This connection's own conversation, for resuming it in a later one. */
  turns(): Turn[] { return utterances(this.fragments.filter(f => !f.carried && !this.unheard(f))).map(({ role, text }) => ({ role, text: text.replace(/\s+/g, ' ').trim() })); }
  /** Speech a dropped connection had not passed on, placed before this one's so that its next request includes it. */
  carry(from: VoiceHistory) {
    const pending = from.fragments.filter(f => !f.sent && !f.claim && !from.unheard(f));
    const shift = (pending.at(-1)?.endMs ?? 0) + 5000;
    for (const f of pending) {
      this.fragments.push({ ...f, seq: this.fragments.length, startMs: f.startMs - shift, endMs: f.endMs - shift, carried: true });
      // Taken over: the dropped connection hands it off no more.
      f.claim = 'carried';
    }
  }
}
