import { randomUUID } from 'node:crypto';
import { ContextQueue, VoiceHistory } from './context.js';

export class Mediator {
  constructor({ live, observer, deliver, log, publish, clean }) {
    Object.assign(this, { live, observer, deliver, log, publish, clean });
    this.history = new VoiceHistory(); this.seenDelegations = new Set(); this.timers = new Set();
    this.context = new ContextQueue(live, error => {
      this.fault(error);
      live.close('Claude context delivery failed');
    });
    // Reopening voice restores all observations, including tools and anything
    // captured while voice was off. Historical assistant messages stay quiet.
    for (const observation of observer.observations) this.forward(observation, true);
    this.onObservation = event => this.forward(event);
    this.onLive = event => this.liveEvent(event);
    live.on('event', this.onLive); observer.on('observation', this.onObservation);
  }
  forward(event, historical = false) {
    this.context.add(historical ? 'thinking' : event.kind, `Claude Code observation${historical ? ' (history)' : ''}:\n${event.text}\n`);
  }
  fault(error) { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: error.message }); }
  liveEvent(event) {
    if (event.type === 'session.started') this.context.pump();
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event);
      this.publish({ type: 'caption', ...fragment, voiceSessionId: this.live.id, voiceStartedAt: this.live.startedAt });
    }
    if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
      const id = event.delegation.id;
      if (this.seenDelegations.has(id)) return;
      this.seenDelegations.add(id);
      const createdAt = Date.now();
      const attempt = () => {
        const sinceInput = Date.now() - this.history.lastInputAt;
        if (sinceInput < 450 && Date.now() - createdAt < 3000) return this.schedule(attempt, 200);
        this.delegate(id, event.offset_ms);
      };
      this.schedule(attempt, 650);
    }
  }
  schedule(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  delegate(delegationId, offsetMs) {
    if (this.live.state !== 'active') return;
    const request = this.history.request(offsetMs);
    if (!request || !request.text.trim()) {
      this.log({ type: 'bridge.delegation_suppressed', delegationId, reason: 'No new operator speech to send' });
      this.context.add('thinking', 'No new operator speech is available to send. Answer from the observed Claude session; already submitted requests must not be resent.', delegationId);
      return;
    }
    const content = this.clean(`User request (transcribed speech):\n${request.text}${request.context ? `\n\nEarlier voice conversation for reference only:\n${request.context}` : ''}`);
    try {
      this.deliver({ id: randomUUID(), content, delegationId, text: this.clean(request.text), queuedAt: Date.now() });
      this.history.markDelivered(request);
      this.context.add('thinking', 'The user request was queued for Claude Code. Follow the automatic Claude observations for its response and actual results. Do not resend it or treat delivery as completion.', delegationId);
    } catch (error) {
      this.fault(error);
      this.context.add('commentary', 'The voice bridge could not queue your request for Claude. Please check the terminal connection.', delegationId);
    }
  }
  stop() {
    this.context.stop(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('observation', this.onObservation);
  }
}
