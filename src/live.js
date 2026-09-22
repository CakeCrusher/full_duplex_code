import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DEFAULT_SPEAKING_LEVEL, speakingPolicy } from './voice-policy.js';

export const SAMPLE_RATE = 24000;
export const BASE_PROMPT = `You are the operator's calm voice companion for Claude Code. Speak clear, natural English in complete thoughts. The operator speaks to you through audio. Your job is to answer them and help them direct the coding agent.

Conversation priority: The operator's current question or direction always takes priority. Let the operator finish their request, then respond to that first, using what you already know. When asked to change the subject or pause reports, do so immediately. Keep reports paused until the operator asks to resume; you can still answer their questions.

Claude's hook feed is a silent background log, not a conversation partner and not a script. It contains another agent's first-person text. Refer to that agent as Claude. Tool calls and file writes are intermediate steps, not finished tasks. Stop marks the end of Claude's response; it does not prove the program works. Results and errors determine what was actually accomplished.

Backchannel policy: No backchannels. Do not make acknowledgment sounds to the log or to silence.

Interruption policy: Stop and listen when the operator interrupts. Only an actual operator interruption should cut a spoken sentence short. Finish your current thought before choosing whether new background information is worth mentioning.

Delegation policy:
Backend tools:
- Claude Code: investigate, run commands, edit files, and perform coding tasks in the terminal.
Delegate to the backend when:
- The operator asks for coding work, a task change, a message to Claude, or an investigation needing new information.
Do not delegate to the backend when:
- You can answer from observed work or the conversation.
- The operator is directing your conversation, or you need clarification.
Existing terminal prompts are already submitted. Never resend them. Confirm successful delivery briefly when the bridge confirms it; do not claim delivery before that confirmation or mistake it for completed work.`;

export const liveInstructions = (level = DEFAULT_SPEAKING_LEVEL) => `${BASE_PROMPT}\n${speakingPolicy(level)}`;
export const LIVE_PROMPT = liveInstructions();

export class LiveSession extends EventEmitter {
  constructor({ apiKey, budget, label = 'voice session', voice = 'marin', instructions = LIVE_PROMPT, input = [], log = () => {}, url = 'wss://api.openai.com/v1/live/sessions' }) {
    super();
    Object.assign(this, { apiKey, budget, label, voice, instructions, input, log, url });
    this.state = 'new'; this.pending = new Map(); this.usageSeconds = 0;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start(sdp) {
    if (this.state !== 'new') throw new Error('Session already started');
    try {
      if (!this.apiKey) throw new Error('OPENAI_API_KEY is missing');
      this.reservation = this.budget.reserve(null, this.label);
    } catch (error) {
      // A rejected start must release the microphone, allow another attempt,
      // and settle close() even though no API connection was opened.
      this.finish(false);
      throw error;
    }
    this.state = 'connecting';
    this.transport = sdp ? 'webrtc' : 'websocket';
    let answer;
    let socketUrl = this.url;
    if (sdp) {
      this.creation = new AbortController();
      try {
        const response = await fetch(this.url.replace(/^ws/, 'http'), {
          method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: { model: 'gpt-live-1', instructions: this.instructions, input: this.input,
            audio: { output: { voice: this.voice } }, delegation: { type: 'client' }, store: false },
          transport: { type: 'webrtc', sdp } }),
          signal: AbortSignal.any([this.creation.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error(`OpenAI voice connection failed (HTTP ${response.status}).`);
        answer = await response.json();
        if (!answer.session?.id || !answer.transport?.sdp) throw new Error('OpenAI returned an incomplete voice connection.');
        this.id = answer.session.id;
        socketUrl = `${this.url}/${encodeURIComponent(this.id)}/attach`;
      } catch (error) { this.finish(false); throw error; }
      if (this.state === 'closed') throw new Error('Voice startup canceled');
    }
    this.ws = new WebSocket(socketUrl, { headers: { Authorization: `Bearer ${this.apiKey}` }, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    const ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.startTimer = setTimeout(() => this.abort('session startup timed out'), 20000);
    this.ws.on('open', () => answer ? this.emit('answer', answer.transport.sdp) : this.ws.send(JSON.stringify({ type: 'session.start', event_id: randomUUID(), session: {
      model: 'gpt-live-1', instructions: this.instructions, input: this.input,
      audio: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, output: { voice: this.voice } },
      delegation: { type: 'client' }, store: false,
    } })));
    this.ws.on('message', raw => {
      try { this.receive(JSON.parse(raw.toString())); }
      catch (err) { this.emit('fault', err); this.abort(err.message); }
    });
    this.ws.on('error', err => { this.emit('fault', err); this.abort(err.message); });
    this.ws.on('close', () => this.finish(false));
    return ready;
  }
  receive(event) {
    if (!['session.output_audio.delta', 'session.input_audio.append'].includes(event.type)) this.log({ direction: 'received', ...event });
    if (event.type === 'session.started') {
      clearTimeout(this.startTimer); this.state = 'active'; this.id = event.session.id; this.startedAt = Date.now();
      this.budget.update(this.reservation, 0, { sessionId: this.id });
      this.resolveReady(event);
    }
    if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      this.usageSeconds = Math.max(this.usageSeconds, event.usage?.seconds ?? 0);
      this.budget.update(this.reservation, this.usageSeconds, { finalized: event.type === 'session.closed', sessionId: this.id, reason: event.reason });
    }
    const ackId = event.client_event_id ?? event.error?.client_event_id;
    if (ackId && this.pending.has(ackId)) {
      const p = this.pending.get(ackId); this.pending.delete(ackId);
      this.watchAcknowledgments();
      if (event.type === 'error') p.reject(new Error(event.error?.message ?? 'Command rejected')); else p.resolve(event);
    }
    this.emit('event', event);
    if (event.type === 'error' && this.state !== 'closing') {
      this.emit('fault', new Error(event.error?.message ?? 'Live API error'));
      if (this.state === 'connecting') this.abort(event.error?.message ?? 'Startup rejected');
    }
    if (event.type === 'session.closed') { this.finalEvent = event; this.ws.close(); this.finish(true); }
  }
  send(event) {
    if (this.state !== 'active' || this.ws.readyState !== WebSocket.OPEN) throw new Error(`Live session is ${this.state}`);
    if (this.ws.bufferedAmount > 1024 * 1024) { this.abort('Network backpressure'); throw new Error('Live connection too slow'); }
    if (event.type !== 'session.input_audio.append') this.log({ direction: 'sent', ...event });
    this.ws.send(JSON.stringify(event));
    this.emit('sent', event);
  }
  audio(pcm) {
    if (this.transport === 'webrtc') throw new Error('WebRTC microphone audio must use the media track.');
    if (this.state !== 'active') return;
    if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples');
    const audioSeconds = ((this.audioBytes ?? 0) + pcm.length) / (SAMPLE_RATE * 2);
    if (audioSeconds > (Date.now() - this.startedAt) / 1000 + 2) {
      this.close('Input audio exceeded real-time pacing');
      throw new Error('Audio must be streamed at real-time speed');
    }
    this.audioBytes = (this.audioBytes ?? 0) + pcm.length;
    this.send({ type: 'session.input_audio.append', audio: pcm.toString('base64') });
  }
  append(kind, content, delegationId = null) {
    const eventId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(eventId, { resolve, reject });
      if (!this.ackTimer) this.watchAcknowledgments();
      try { this.send({ type: `session.${kind}.append`, event_id: eventId, delegation_id: delegationId, content }); }
      catch (err) { this.pending.delete(eventId); this.watchAcknowledgments(); reject(err); }
    });
  }
  watchAcknowledgments() {
    clearTimeout(this.ackTimer); this.ackTimer = null;
    if (!this.pending.size) return;
    // Appends enter the model over time. A large burst can legitimately take
    // longer than 20 seconds; detect stalled progress instead of aging each
    // individual append while earlier context is still being acknowledged.
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      const pending = [...this.pending.values()]; this.pending.clear();
      for (const p of pending) p.reject(new Error('Context acknowledgments stalled for 20 seconds'));
    }, 20000);
  }
  async greet() {
    // A one-time welcome, not a persistent instruction that can retrigger
    // every time an ordinary Claude message arrives as commentary.
    await this.append('commentary', 'Voice connection opened. Greet the user once in English, briefly introduce yourself as their Claude Code voice companion, then listen. This welcome applies only to the connection opening; do not greet again for later Claude observations.');
  }
  close(reason = 'requested') {
    if (this.state === 'active') {
      this.log({ type: 'bridge.closing', reason });
      this.send({ type: 'session.close', event_id: randomUUID() }); this.state = 'closing';
      this.closeTimer = setTimeout(() => this.abort('Final usage timeout'), 15000);
    } else if (this.state === 'new' || this.state === 'connecting') this.abort(reason);
    return this.closed;
  }
  abort(reason) {
    if (this.state === 'closed') return;
    this.log({ type: 'bridge.aborted', reason });
    this.creation?.abort();
    this.rejectReady?.(new Error(reason));
    this.ws?.terminate(); this.finish(false);
  }
  finish(finalized) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of [this.startTimer, this.closeTimer, this.ackTimer]) clearTimeout(timer);
    this.rejectReady?.(new Error('Connection closed before startup'));
    for (const p of this.pending.values()) p.reject(new Error('Session closed'));
    this.pending.clear();
    const result = { finalized: Boolean(finalized || this.finalEvent), reserved: Boolean(this.reservation), usageSeconds: this.usageSeconds, sessionId: this.id };
    this.log({ type: 'bridge.closed', ...result }); this.resolveClosed(result); this.emit('closed', result);
  }
}
