// Compact visual history. This is independent of the complete context sent to
// GPT Live: grouping here changes only how the browser draws observations.
export class Timeline {
  constructor(origin = Date.now()) {
    this.origin = origin; this.sequence = 0; this.items = new Map();
    this.audio = new Map(); this.transcripts = new Map(); this.requests = new Map(); this.context = new Map();
  }
  item(fields) {
    const item = { id: `event-${++this.sequence}`, ...fields };
    this.items.set(item.id, item);
    return item;
  }
  snapshot() { return { origin: this.origin, items: [...this.items.values()] }; }
  add(event) {
    const at = event.at ?? Date.now(); const changed = [];
    if (event.type === 'audio_level') {
      // Gated audio is already filtered. Show quiet word tails too; applying
      // the opening threshold again would hide audio that we actually send.
      const inputThreshold = Number.isFinite(event.gateThreshold) ? Number.MIN_VALUE : .008;
      for (const [track, rms, threshold] of [['operator', event.inputRms, inputThreshold], ['speech', event.outputRms, .003]]) {
        let item = this.audio.get(track);
        if (rms >= threshold) {
          const start = at - event.durationMs;
          if (!item || start - item.end > 220 || !item.active) {
            item = this.item({ track, start, end: at, active: true, peak: rms,
              label: track === 'operator' ? 'Microphone' : 'Live speech',
              source: track === 'operator' ? 'Microphone activity from the signal sent to Live, after mute and the noise gate' : 'Audio rendered by the browser; bars split after 220 ms below the level threshold, not at sentence boundaries',
            });
            this.audio.set(track, item);
          }
          item.end = Math.max(item.end, at); item.peak = Math.max(item.peak, rms);
          changed.push(item);
        } else if (item?.active && at - item.end > 220) { item.active = false; changed.push(item); }
      }
    }
    if (event.type === 'voice_closed' || event.type === 'audio_stopped') {
      for (const item of this.audio.values()) if (item.active) { item.active = false; changed.push(item); }
      this.audio.clear();
    }
    if (event.type === 'caption') {
      // API transcript offsets belong to a voice connection, not the entire
      // launcher lifetime. Restarts get a fresh origin and grouping key.
      const base = event.voiceStartedAt ?? event.receivedAt - event.endMs;
      const start = base + event.startMs; const end = base + event.endMs;
      const key = `${event.voiceSessionId ?? 'voice'}:${event.role}`;
      let item = this.transcripts.get(key);
      if (!item || start - item.end > 1200 || start < item.start) {
        item = this.item({ track: 'transcript', role: event.role, start, end, text: '', fragments: 0,
          label: event.role === 'operator' ? 'Input transcript' : 'Live', source: 'API transcript, not verified microphone speech; approximate session timestamps',
          voiceSessionId: event.voiceSessionId,
        });
        this.transcripts.set(key, item);
      }
      item.text += event.text; item.end = Math.max(item.end, end); item.fragments++;
      item.receivedAt = at; changed.push(item);
    }
    if (event.type === 'agent_observation') {
      changed.push(this.item({ track: 'claude', start: at, end: at, label: event.name ?? 'Transcript observation', text: event.text,
        source: 'Complete observation received by bridge; binary attachment bytes stay local. Inspect Context to Live for exactly what was sent.',
      }));
    }
    if (event.type === 'context_sent') {
      const item = this.item({ track: 'context', start: at, end: at, label: ({ thinking: 'Thinking', commentary: 'Commentary', instructions: 'Speaking preference' })[event.kind], kind: event.kind,
        text: event.text, notification: event.notification, state: 'sent', source: 'Exact context append sent to Live; bar ends at acknowledgment, not consumption' });
      this.context.set(event.id, item); changed.push(item);
    }
    if (event.type === 'context_ack') {
      const item = this.context.get(event.id);
      if (item) { item.end = at; item.state = 'acknowledged'; item.injectionStartMs = event.startMs; item.injectionEndMs = event.endMs; changed.push(item); }
    }
    if (event.type === 'task') {
      let item = this.requests.get(event.id);
      if (!item) {
        item = this.item({ track: 'requests', requestId: event.id, start: event.queuedAt ?? at, end: at, label: 'Voice request',
          text: event.text, state: event.state, source: 'Request delivery, not agent execution time',
        });
        this.requests.set(event.id, item);
      }
      item.text = event.text ?? item.text;
      item.notification = event.notification ?? item.notification;
      if (item.observedContent !== undefined) item.contentMatches = item.observedContent === item.text;
      if (item.state !== 'observed') { item.state = event.state; item.end = Math.max(item.end, at); }
      if (event.state === 'sent') item.sentAt ??= at;
      changed.push(item);
    }
    if (event.type === 'agent_input') {
      const attributes = event.text.match(/^<channel\s([^>]*)>/)?.[1];
      const channelId = /\bsource="voice"/.test(attributes ?? '') && attributes.match(/\bmessage_id="([^"]+)"/)?.[1];
      const request = channelId && this.requests.get(channelId);
      if (request) {
        request.state = 'observed'; request.observedAt = at; request.end = Math.max(request.end, at);
        request.observedPrompt = event.text;
        request.observedContent = event.text.match(/^<channel\s[^>]*>\r?\n([\s\S]*)\r?\n<\/channel>$/)?.[1];
        if (request.observedContent !== undefined) request.contentMatches = request.observedContent === request.text;
        changed.push(request);
      }
      else changed.push(this.item({ track: 'requests', start: at, end: at, label: channelId ? 'Voice request' : 'Typed request',
        text: event.text, state: 'observed', source: 'UserPromptSubmit received — already in Claude',
      }));
    }
    return changed;
  }
}
