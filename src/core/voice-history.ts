export interface TranscriptDelta { type: string; delta: string; start_ms: number; end_ms: number }
export interface TranscriptFragment {
  seq: number; role: 'operator' | 'intermediary'; text: string; startMs: number; endMs: number; receivedAt: number; carried?: boolean;
  /** The request it is on its way to the agent with; it is taken by no other request meanwhile. */
  claim?: string;
  /** The agent received it. */
  sent?: boolean;
  /** Why it is still here after a request took it: fdc handled that request itself, or its delivery was uncertain. */
  note?: string;
  /** The voice moved the page as it answered these words: this goes with them, and the gate still judges them. */
  cued?: string;
  /** A tag in the record placed before these words, such as where a fork began (forks.ts). */
  tag?: string;
}
/** One speaker's speech until they pause for over 2 seconds, and when its first words were heard (wall clock). */
export type Utterance = Pick<TranscriptFragment, 'text' | 'endMs'> & { role: TranscriptFragment['role'] | 'event'; at?: number };
/** A spoken turn as kept for resuming the conversation, with when it was heard (kept since Oct 30). */
export type Turn = Pick<Utterance, 'text' | 'at'> & { role: TranscriptFragment['role'] };
/** An utterance with when it was heard (wall clock). */
export type Spoken = Turn & { at: number };
export interface SpokenRequest {
  utterances: Utterance[]; through: number; unheard?: string[];
  /** The fragments it takes. */
  seqs: number[];
  /** Why some of its speech is going again (see TranscriptFragment.note). */
  notes?: string[];
  /** The operator's latest utterance among words no earlier request took: what this request is for. */
  fresh: string;
  /** The voice already moved the page for some of its words (TranscriptFragment.cued). */
  cued?: boolean;
  /** The ID it goes to the agent by, once claimed. */
  id?: string;
}
// Any sample louder than this is sound; the page's gate sends exact silence, which echoes back at about 1.
const SOUND_PEAK = 64;
// Pieces GPT Live transcribes from noise or leaks from its own stream: part of a control token ("<|stream", "<"), or a
// single piece in another script in the middle of a conversation in Latin script ("्क", "બહાર"). Never the operator's
// words. Rare (15 of 31,238 pieces, Oct 30 to Nov 13, never two in a row), but one of them, given to a woken connection as
// the operator's turn, had it speak Hindi (Nov 4), and two went to the agent as requests by themselves. An operator who
// does speak in another script is heard in it from their second piece in a row: from then on, for this fdc and all its
// connections, no piece is noise for its script.
const LETTER = /[\p{L}\p{M}]/u, LATIN = /\p{Script=Latin}/u;
const otherScript = (text: string) => LETTER.test(text) && !LATIN.test(text);
let spoken = false;
export const phantom = (text: string) => /<\||^[\s<>|\uFFFD]*[<>|\uFFFD][\s<>|\uFFFD]*$/.test(text) || (!spoken && otherScript(text));
/** The script the operator speaks in is unknown again (a new operator, as far as fdc can have one: its tests). */
export const forgetScript = () => { spoken = false; };

// The conversation in the order it was said: a speaker's words join until the other speaks or they pause. Until Nov 14 a
// speaker's words also joined across the other's ("mm-hmm"), which moved lines: 55 of 548 requests of Nov 1 to 13 reached
// the agent out of the order said (the voice's "Here's the next one" before the operator's "ask me another"), and words
// on either side of an interjection fused ("to mm-hmm result" became "toresult").
function utterances(fragments: readonly TranscriptFragment[]): Utterance[] {
  const joined: Utterance[] = [];
  for (const { role, text, startMs, endMs, receivedAt, tag } of fragments) {
    if (tag) joined.push({ role: 'event', text: tag, endMs: startMs, at: receivedAt });
    const last = joined.at(-1);
    if (last?.role === role && startMs - last.endMs <= 2000) { last.text += text; last.endMs = endMs; }
    else joined.push({ role, text, endMs, at: receivedAt });
  }
  return joined.filter(u => u.text.trim());
}

// Transcripts of one voice connection, and how far they have been delegated. A request carries the conversation from the
// cursor (the end of what the agent has, or has on its way) through its own latest words, whole and in order, built when
// it is sent: words an earlier turn kept go with the next request that goes, before the words that follow them.
// delegatedThrough moves only over speech the agent received, so speech fdc handled itself, or whose delivery failed or was
// uncertain, goes with the next request (at least once, never lost).
export class VoiceHistory {
  fragments: TranscriptFragment[] = [];
  delegatedThrough = -1;
  lastInputAt = 0;
  /** A tag waiting for the next words, when none are waiting to be sent. */
  pendingTag?: string;
  /** GPT Live's echo of the audio it heard from the operator (WebRTC only): each stretch and its loudest sample. */
  heard: { startMs: number; endMs: number; peak: number }[] = [];
  add(event: TranscriptDelta): TranscriptFragment {
    const role = event.type === 'session.input_transcript.delta' ? 'operator' : 'intermediary';
    const fragment: TranscriptFragment = { seq: this.fragments.length, role, text: event.delta, startMs: event.start_ms, endMs: event.end_ms, receivedAt: Date.now() };
    // Two pieces in a row in another script: that is how they speak.
    const before = role === 'operator' && otherScript(fragment.text) ? this.fragments.findLast(f => f.role === 'operator') : undefined;
    if (before && otherScript(before.text) && fragment.receivedAt - before.receivedAt <= 3000) spoken = true;
    if (this.pendingTag) { fragment.tag = this.pendingTag; this.pendingTag = undefined; }
    this.fragments.push(fragment);
    if (role === 'operator' && !phantom(fragment.text)) this.lastInputAt = fragment.receivedAt;
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
  /** Operator words GPT Live transcribed from silence (see audible), or pieces that are no speech of theirs (phantom). */
  unheard(fragment: TranscriptFragment) { return fragment.role === 'operator' && (phantom(fragment.text) || (!fragment.carried && this.audible(fragment.startMs, fragment.endMs) === false)); }
  // The conversation since the previous request, through fragment `through`: anything said before it went with the previous
  // request, unless the agent never got it. Transcript arrival can trail the end of the operator's turn, so the caller waits
  // briefly for it first.
  request(through = Infinity): SpokenRequest | null {
    const all = this.fragments.filter(f => f.seq > this.delegatedThrough && f.seq <= through && !f.sent && !f.claim);
    const unheard = all.filter(f => this.unheard(f));
    const spoken = utterances(all.filter(f => !unheard.includes(f)));
    if (!spoken.some(u => u.role === 'operator')) return null;
    const notes = [...new Set(all.flatMap(f => [f.note, f.cued]).filter(note => note !== undefined))];
    const said = utterances(all.filter(f => !f.note && !unheard.includes(f))).filter(u => u.role === 'operator').map(u => u.text.replace(/\s+/g, ' ').trim());
    const fresh = said.at(-1) ?? '';
    // Only the latest words count as moved for: earlier words a cue answered (and no request took) don't make the turn
    // skip the page for what the operator asks now ("highlight your recommendation" after "take me to the options").
    const mine = all.filter(f => f.role === 'operator' && !f.note && !unheard.includes(f)), latest: TranscriptFragment[] = [];
    for (let i = mine.length - 1; i >= 0 && (i === mine.length - 1 || mine[i + 1].startMs - mine[i].endMs <= 2000); i--) latest.unshift(mine[i]);
    const cued = latest.some(f => f.cued);
    return { utterances: spoken, through: all.at(-1)!.seq, seqs: all.map(f => f.seq), fresh, ...cued ? { cued } : {}, ...notes.length ? { notes } : {}, ...unheard.length ? { unheard: unheard.map(f => f.text) } : {} };
  }
  /** Marks the operator's latest words that no request took yet: the voice moved the page for them. */
  cueLatest(note: string) {
    const pending = this.fragments.filter(f => f.role === 'operator' && !f.sent && !f.claim && !f.note);
    let noted = 0;
    // The latest utterance: back to a pause of over 2 s.
    for (let i = pending.length - 1; i >= 0 && (i === pending.length - 1 || pending[i + 1].startMs - pending[i].endMs <= 2000); i--) { pending[i].cued = note; noted++; }
    return noted;
  }
  /** Words the voice tool read and kept, through fragment `through`: why they are still here goes with them to the next request. */
  note(through: number, note: string) { for (const f of this.fragments) if (f.seq <= through && !f.sent && !f.claim && !f.note) f.note = note; }
  /** Places a tag before the operator's latest words no request took yet (the turn that brought it on), else before the next words. */
  tag(text: string) {
    const pending = this.fragments.filter(f => f.role === 'operator' && f.seq > this.delegatedThrough && !f.sent && !f.claim);
    let first: TranscriptFragment | undefined;
    for (let i = pending.length - 1; i >= 0 && (i === pending.length - 1 || pending[i + 1].startMs - pending[i].endMs <= 2000); i--) first = pending[i];
    if (first) first.tag = first.tag ? `${first.tag}\n${text}` : text;
    else this.pendingTag = this.pendingTag ? `${this.pendingTag}\n${text}` : text;
  }
  /** Everything after fragment `through` goes again with the next request: a session catching up on what went elsewhere (a fork). */
  reopen(through: number) {
    for (const f of this.fragments) if (f.seq > through) { f.sent = false; f.claim = undefined; }
    this.delegatedThrough = Math.min(this.delegatedThrough, through);
  }
  /** The request is on its way: no other request takes its speech meanwhile. */
  claim(request: SpokenRequest, id: string) { request.id = id; for (const seq of request.seqs) this.fragments[seq].claim = id; }
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
  turns(): Turn[] { return utterances(this.fragments.filter(f => !f.carried && !this.unheard(f))).flatMap(({ role, text, at }) => role === 'event' ? [] : [{ role, text: text.replace(/\s+/g, ' ').trim(), at }]); }
  /**
   * The conversation as it was heard, up to the operator's latest words (to fragment `through`): each speaker's words until
   * the other speaks or they pause, with when it was heard, for placing it among what GPT Live was sent (perceived.ts).
   * With `since` (the last word read before), all of the operator's words after it are the latest, whatever was said among
   * them: read only to its last pause, "…send it" then "over" was read as "over" and kept. Words carried over from the
   * connection before are its conversation, which GPT Live heard there (record.turns), unless they are among the latest.
   */
  spoken(through = Infinity, since?: number): Spoken[] {
    const latest = since === undefined ? [] : this.fragments.filter(f => f.seq > since && f.seq <= through && f.role === 'operator' && !this.unheard(f));
    const joined: (Spoken & { endMs: number })[] = [];
    for (const f of this.fragments) {
      if (f.seq > through || (latest.length && f.seq >= latest[0].seq) || this.unheard(f) || f.carried) continue;
      const last = joined.at(-1);
      if (last?.role === f.role && f.startMs - last.endMs <= 2000) { last.text += f.text; last.endMs = f.endMs; }
      else joined.push({ role: f.role, text: f.text, at: f.receivedAt, endMs: f.endMs });
    }
    const all = joined.map(({ role, text, at }) => ({ role, text: text.replace(/\s+/g, ' ').trim(), at })).filter(u => u.text);
    const words = latest.map(f => f.text).join('').replace(/\s+/g, ' ').trim();
    if (words) all.push({ role: 'operator', text: words, at: latest[0].receivedAt });
    // GPT Live answering is not part of what the operator's latest words are.
    while (all.length && all.at(-1)!.role !== 'operator') all.pop();
    return all;
  }
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
