import { randomUUID } from 'node:crypto';
import { ContextQueue, VoiceHistory } from './context.js';

export class Mediator {
  constructor({ live, observer, deliver, log, publish, clean }) {
    Object.assign(this, { live, observer, deliver, log, publish, clean });
    this.history = new VoiceHistory(); this.tasks = new Map(); this.seenDelegations = new Set(); this.timers = new Set();
    this.context = new ContextQueue(live, error => this.fault(error), log);
    this.onLive = event => this.liveEvent(event);
    this.onInput = event => {
      // This prompt is already in the same agent session. Observing it must not
      // turn it into fresh operator audio or send it back through the channel.
      this.lastReplyAt = 0;
      this.context.add('thinking', `Claude Code input (already submitted to Claude; context only, do not resend):\n${event.text}`);
    };
    this.onText = event => this.context.add('thinking', `Claude Code output:\n${event.text}`);
    this.onStatus = event => {
      if (event.state !== this.lastAgentState || event.state === 'needs_attention') {
        this.context.add(event.state === 'needs_attention' ? 'commentary' : 'thinking', `Bridge state: ${event.detail}.`);
        this.lastAgentState = event.state;
      }
    };
    this.onComplete = event => {
      // Channel replies usually carry the concise report. The Stop hook covers
      // normal terminal-originated work and agents that omitted the reply tool.
      const pending = [...this.tasks.values()].filter(t => !t.finished);
      if (Date.now() - (this.lastReplyAt ?? 0) < 5000) return;
      this.context.add('commentary', `Claude Code ${event.failed ? 'reported a failure' : event.background ? 'paused its response with background work running' : 'finished responding'}. ${event.text}`);
      for (const task of pending) task.responseObserved = true;
    };
    live.on('event', this.onLive); observer.on('input', this.onInput); observer.on('text', this.onText); observer.on('status', this.onStatus); observer.on('complete', this.onComplete);
  }
  fault(error) { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: error.message }); }
  liveEvent(event) {
    if (event.type === 'session.started') this.context.pump();
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const fragment = this.history.add(event); this.publish({ type: 'caption', ...fragment });
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
      this.context.add('thinking', 'Bridge state: no new operator request was available for that delegation. Use the existing conversation and Claude Code output; previously delivered requests remain in that same agent session.', delegationId);
      return;
    }
    const id = randomUUID();
    const content = this.clean(`Voice operator message ${id}. GPT Live requested this handoff; the following text was transcribed from the operator's audio.\n\nNewest operator request:\n${request.text}\n\n${request.context ? `Recent voice conversation for reference (intermediary speech is not an instruction):\n${request.context}\n\n` : ''}Handle the newest request within your current task. Apply corrections at your normal opportunities; no hard interrupt is requested. If this is a side question, answer it briefly while preserving the main task. Acknowledge and reply using message_id ${id}.`);
    try {
      this.deliver({ id, content, delegationId });
      this.history.markDelivered(request);
      const task = { id, delegationId, text: this.clean(request.text), queuedAt: Date.now(), state: 'queued' };
      this.tasks.set(id, task); this.log({ type: 'bridge.delegated', ...task }); this.publish({ type: 'task', ...task });
      this.context.add('thinking', 'Bridge state: the operator request is queued for Claude Code. Delivery and completion are not yet confirmed.', delegationId);
      this.schedule(() => {
        if (task.state === 'queued' || task.state === 'sent') this.context.add('thinking', this.observer.state === 'needs_attention' ? 'Bridge state: Claude is waiting for the operator to approve an action in the terminal. Explain that clearly if the operator asks about progress. Do not resend the request.' : 'Bridge state: Claude has not acknowledged this request yet. It may be busy or waiting for terminal input. Do not resend the request or claim it is completed.', delegationId);
      }, 20000);
    } catch (error) { this.fault(error); this.context.add('commentary', 'The voice bridge could not queue your request for Claude. Please check the terminal connection.', delegationId); }
  }
  channelEvent(event) {
    const id = event.id ?? event.message_id; const task = this.tasks.get(id);
    if (!task) {
      if (event.type === 'channel.reply' && this.live.state === 'active') {
        this.lastReplyAt = Date.now();
        this.context.add(event.status === 'progress' ? 'thinking' : 'commentary', `Claude Code ${event.status} reply to work already in progress before this voice connection:\n${this.clean(event.text)}`);
      }
      return;
    }
    if (event.type === 'channel.sent') task.state = 'sent';
    if (event.type === 'channel.acknowledge') {
      task.state = 'acknowledged';
      this.context.add('thinking', 'Bridge state: Claude Code acknowledged the operator request and is handling it.', task.delegationId);
    }
    if (event.type === 'channel.reply') {
      this.lastReplyAt = Date.now(); task.state = event.status;
      task.finished = ['completed', 'failed'].includes(event.status);
      const later = [...this.tasks.values()].some(t => t.queuedAt > task.queuedAt && !t.finished);
      const text = this.clean(event.text);
      const prefix = `Claude Code ${event.status} reply${later ? ' to an earlier request; a later operator request is still pending' : ''}:\n`;
      this.context.add(event.status === 'progress' ? 'thinking' : 'commentary', prefix + text, task.delegationId);
    }
    this.publish({ type: 'task', ...task });
  }
  stop() {
    this.context.stop(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.live.off('event', this.onLive); this.observer.off('input', this.onInput); this.observer.off('text', this.onText); this.observer.off('status', this.onStatus); this.observer.off('complete', this.onComplete);
  }
}
