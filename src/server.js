import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Budget } from './budget.js';
import { LiveSession, liveInstructions } from './live.js';
import { DEFAULT_SPEAKING_LEVEL, speakingPolicy } from './voice-policy.js';
import { Mediator } from './mediator.js';
import { AgentObserver, makeClaudeConfig } from './agent.js';
import { redact, MAX_HOOK_BYTES, startupHistory } from './context.js';
import { Timeline } from './timeline.js';
import { channelNotification } from './channel-message.js';
import { AudioAudit } from './audio-audit.js';

const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req, maxBytes = 1024 * 1024) {
  let size = 0; const buffers = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('Request too large'); buffers.push(chunk); }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}

export class Harness {
  constructor({ root, runDir, cwd, sessionId, apiKey, voice = 'marin', observation = 'hooks', port = 0 }) {
    Object.assign(this, { root, runDir, cwd, sessionId, apiKey, voice, observation, port });
    this.speakingLevel = DEFAULT_SPEAKING_LEVEL;
    this.speakingUpdate = { state: 'next_session', level: this.speakingLevel };
    this.additionalInstructions = [];
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    this.browserToken = randomBytes(32).toString('hex'); this.channelToken = randomBytes(32).toString('hex');
    this.clean = text => redact(text, [apiKey, this.browserToken, this.channelToken]);
    this.log = event => fs.appendFileSync(path.join(runDir, 'events.jsonl'), this.clean(JSON.stringify({ at: Date.now(), ...event })) + '\n', { mode: 0o600 });
    this.budget = new Budget(path.join(root, '.runs', 'budget.json')); this.outbox = new Map(); this.uiEvents = [];
    this.timeline = new Timeline();
    this.observer = new AgentObserver({ sessionId, observation, clean: this.clean, log: this.log });
    this.observer.on('input', event => { this.log({ type: 'agent.input', ...event }); this.publish({ type: 'agent_input', ...event }); });
    this.observer.on('text', event => { this.log({ type: 'agent.text', ...event }); this.publish({ type: 'agent_text', ...event }); });
    this.observer.on('observation', event => this.publish({ type: 'agent_observation', ...event }));
    this.observer.on('status', event => { this.log({ type: 'agent.status', ...event }); this.publish({ type: 'agent_status', ...event }); });
    this.observer.on('fault', error => this.fault(error));
  }
  publish(event) {
    event = { at: Date.now(), ...event };
    const items = this.timeline.add(event);
    if (items.length && this.browser?.readyState === WebSocket.OPEN) this.browser.send(JSON.stringify({ type: 'timeline_update', items }));
    if (['caption', 'task', 'fault', 'agent_input', 'agent_text'].includes(event.type)) { this.uiEvents.push(event); if (this.uiEvents.length > 600) this.uiEvents.shift(); }
    if (this.browser?.readyState === WebSocket.OPEN) this.browser.send(JSON.stringify(event));
  }
  fault(error) { this.log({ type: 'bridge.fault', message: error.message }); this.publish({ type: 'fault', message: this.clean(error.message) }); }
  saveTimeline() { fs.writeFileSync(path.join(this.runDir, 'timeline.json'), this.clean(JSON.stringify(this.timeline.snapshot())), { mode: 0o600 }); }
  status() {
    const budget = this.budget.summary();
    const speakingUpdate = ['new', 'connecting', 'active'].includes(this.live?.state)
      ? this.speakingUpdate : { state: 'next_session', level: this.speakingLevel };
    const prompt = {
      instructions: this.live?.instructions ?? this.instructions(),
      mode: this.live?.id ? this.live.state === 'closed' ? 'previous' : 'session' : 'preview',
      speakingPreference: speakingPolicy(this.speakingLevel),
      additional: this.additionalInstructions.map(item => ({ ...item, state: item.sessionId === this.live?.id && this.live?.state === 'active' ? item.state : 'next_session' })),
    };
    const context = this.mediator?.context;
    const contextDelivery = { waiting: context?.queue.length ?? 0, inFlight: context?.inFlight ?? 0 };
    return { type: 'status', agent: this.observer.state, channel: Boolean(this.channelReady), live: this.live?.state ?? 'disconnected', cwd: this.cwd, sessionId: this.sessionId, usageSeconds: this.live?.usageSeconds ?? 0, committedUsd: budget.committedUsd, runDir: this.runDir, observation: this.observation, speakingLevel: this.speakingLevel, speakingUpdate, prompt, contextDelivery };
  }
  instructions() {
    const additional = this.additionalInstructions.map(item => item.text).join('\n\n');
    return liveInstructions(this.speakingLevel) + (additional ? `\n\nAdditional operator instructions:\n${additional}` : '');
  }
  async appendInstruction(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Enter an instruction first.');
    text = this.clean(text.trim());
    if (Buffer.byteLength(text) > 440) throw new Error('Please shorten this instruction before appending it.');
    if (this.additionalInstructions.reduce((size, item) => size + Buffer.byteLength(item.text), 0) + Buffer.byteLength(text) > 16000) throw new Error('This companion already has many additional instructions. Start a new companion to add more.');
    const live = this.live;
    if (['new', 'connecting', 'closing'].includes(live?.state)) throw new Error('Wait for the voice connection to settle, then append your instruction.');
    const item = { id: randomUUID(), text, state: live?.state === 'active' ? 'pending' : 'next_session', sessionId: live?.state === 'active' ? live.id : undefined };
    this.additionalInstructions.push(item);
    this.log({ type: 'voice.instruction', ...item }); this.publish(this.status());
    if (live?.state !== 'active') return;
    try {
      await live.append('instructions', text);
      if (this.live !== live || live.state !== 'active') return;
      Object.assign(item, { state: 'acknowledged', acknowledgedAt: Date.now() });
      this.log({ type: 'voice.instruction_acknowledged', ...item });
    } catch (error) {
      if (this.live !== live || live.state !== 'active') return;
      Object.assign(item, { state: 'failed', error: this.clean(error.message) });
      this.fault(error);
    }
    this.publish(this.status());
  }
  async setSpeakingLevel(level) {
    const policy = speakingPolicy(level);
    this.speakingLevel = level;
    this.mediator?.context.setSpeakingLevel(level);
    const live = this.live;
    const update = this.speakingUpdate = {
      state: live?.state === 'active' ? 'pending' : ['new', 'connecting'].includes(live?.state) ? 'starting' : 'next_session',
      level, confirmedLevel: this.speakingUpdate.confirmedLevel, sessionId: live?.id,
    };
    this.log({ type: 'voice.speaking_level', ...update }); this.publish(this.status());
    if (live?.state !== 'active') return;
    try {
      await live.append('instructions', policy);
      // An older acknowledgment must never confirm a newer slider selection
      // or a preference in a replacement voice connection.
      if (this.speakingUpdate !== update || this.live !== live || live.state !== 'active') return;
      Object.assign(update, { state: 'acknowledged', confirmedLevel: level, acknowledgedAt: Date.now(), source: 'append' });
      this.log({ type: 'voice.speaking_level_acknowledged', ...update });
    } catch (error) {
      if (this.speakingUpdate !== update || this.live !== live || live.state !== 'active') return;
      Object.assign(update, { state: 'failed', error: this.clean(error.message) });
      this.fault(error);
    }
    this.publish(this.status());
  }
  async start() {
    this.http = http.createServer((req, res) => this.handleHttp(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: this.clean(error.message) }));
    }));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: protocols => protocols.has('fd-voice') ? 'fd-voice' : false });
    this.http.on('upgrade', (req, socket, head) => {
      const route = req.url;
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers['sec-websocket-protocol']?.split(',').map(s => s.trim())[1];
      const validOrigin = !req.headers.origin || req.headers.origin === this.baseUrl;
      const auth = route === '/channel' ? equal(token, this.channelToken) : route === '/voice' && equal(token, this.browserToken);
      const occupied = route === '/channel' ? this.channel?.readyState === WebSocket.OPEN : this.browser?.readyState === WebSocket.OPEN;
      if (!auth || !validOrigin || req.headers.host !== new URL(this.baseUrl).host || occupied || this.stopping) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => route === '/channel' ? this.attachChannel(ws) : this.attachBrowser(ws));
    });
    await new Promise((resolve, reject) => { this.http.once('error', reject); this.http.listen(this.port, '127.0.0.1', resolve); });
    this.baseUrl = `http://127.0.0.1:${this.http.address().port}`;
    this.browserUrl = `${this.baseUrl}/#${this.browserToken}`;
    this.config = makeClaudeConfig({ root: this.root, runDir: this.runDir, baseUrl: this.baseUrl, channelToken: this.channelToken });
    // This private descriptor permits repeatable local tests without exposing the API key.
    fs.writeFileSync(path.join(this.runDir, 'connection.json'), JSON.stringify({ baseUrl: this.baseUrl, browserToken: this.browserToken, sessionId: this.sessionId, cwd: this.cwd }, null, 2), { mode: 0o600 });
    this.statusTimer = setInterval(() => this.publish(this.status()), 1000);
    this.log({ type: 'bridge.started', sessionId: this.sessionId, cwd: this.cwd, baseUrl: this.baseUrl });
    return this;
  }
  async handleHttp(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(this.baseUrl).host || (req.headers.origin && req.headers.origin !== this.baseUrl)) { res.writeHead(403); return res.end(); }
    if (req.url === '/hook' && req.method === 'POST') {
      if (!equal(req.headers.authorization, `Bearer ${this.channelToken}`)) { res.writeHead(403); return res.end(); }
      const event = await body(req, MAX_HOOK_BYTES);
      if (event.session_id !== this.sessionId) { res.writeHead(409); return res.end('{}'); }
      // Never wait for a model or a network append before returning to Claude.
      this.observer.hook(event);
      res.setHeader('Content-Type', 'application/json'); return res.end('{}');
    }
    if (req.url === '/api/status' && req.method === 'GET') {
      if (!equal(req.headers.authorization, `Bearer ${this.browserToken}`)) { res.writeHead(403); return res.end(); }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(this.status()));
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/timeline.js': ['timeline.js', 'text/javascript'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/audio-worklet.js': ['audio-worklet.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (req.method !== 'GET' || !files[req.url]) { res.writeHead(404); return res.end(); }
    const [name, type] = files[req.url]; res.setHeader('Content-Type', `${type}; charset=utf-8`);
    return res.end(fs.readFileSync(path.join(this.root, 'web', name)));
  }
  attachChannel(ws) {
    this.channel = ws;
    ws.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString());
        this.log(event);
        if (event.type === 'channel.ready') {
          this.channelReady = true; clearTimeout(this.channelLostTimer);
          for (const task of this.outbox.values()) if (task.state === 'queued') this.dispatch(task);
        }
        const task = this.outbox.get(event.id ?? event.message_id);
        if (task && event.type === 'channel.sent') {
          task.state = 'sent'; this.publishRequest(task);
          this.confirmDelivery(task);
        }
        this.publish(this.status());
      } catch (error) { this.fault(error); }
    });
    ws.on('error', error => this.fault(error));
    ws.on('close', () => {
      if (this.channel !== ws) return;
      this.channelReady = false; this.publish(this.status());
      if (this.stopping) return;
      for (const task of this.outbox.values()) if (task.state === 'dispatching') { task.state = 'uncertain'; this.publishRequest(task); this.fault(new Error('A voice message has uncertain delivery; it will not be automatically resent.')); }
      this.channelLostTimer = setTimeout(() => { if (!this.channelReady) this.live?.close('Claude channel disconnected'); }, 10000);
    });
  }
  deliver(task) {
    if (this.outbox.size >= 1000) throw new Error('Too many voice tasks in one session');
    if (this.outbox.has(task.id)) return;
    const entry = { ...task, content: this.clean(task.content), state: 'queued' }; this.outbox.set(task.id, entry);
    this.publishRequest(entry);
    if (this.channelReady) this.dispatch(entry);
  }
  confirmDelivery(task) {
    const live = this.live;
    if (task.confirmationSent || !task.voiceSessionId || live?.state !== 'active' || task.voiceSessionId !== live.id) return;
    task.confirmationSent = true;
    // Delivery is an operator-facing fact, independent of the hook backlog.
    // The channel confirms its notification write; this does not claim that
    // Claude has started or completed the work. Never replay it in a new voice session.
    live.append('commentary', 'Your request has been sent to Claude Code.', task.delegationId ?? null).catch(error => {
      if (this.live === live && live.state === 'active') this.fault(new Error(`The request was sent, but its voice confirmation failed: ${error.message}`));
    });
  }
  publishRequest(task) {
    const event = { type: 'task', id: task.id, text: task.content, notification: channelNotification(task), state: task.state, queuedAt: task.queuedAt };
    this.log(event); this.publish(event);
  }
  dispatch(task) {
    task.state = 'dispatching';
    this.publishRequest(task);
    this.channel.send(JSON.stringify({ type: 'channel.deliver', id: task.id, content: task.content }), error => { if (error) { task.state = 'uncertain'; this.publishRequest(task); this.fault(error); } });
  }
  attachBrowser(ws) {
    this.browser = ws; ws.send(JSON.stringify(this.status()));
    ws.send(JSON.stringify({ type: 'timeline_history', ...this.timeline.snapshot() }));
    ws.send(JSON.stringify({ type: 'history', events: this.uiEvents }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (raw.length > 9600 || raw.length % 2) { this.fault(new Error('Invalid microphone audio frame')); ws.close(1008); return; }
        this.lastAudioAt = Date.now();
        try {
          const sending = this.live?.state === 'active';
          this.live?.audio(raw);
          if (sending) this.audit?.write('input', raw);
        } catch (error) { this.fault(error); }
        return;
      }
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'start') this.startLive(event.sdp).catch(error => this.fault(error));
        if (event.type === 'stop') this.live?.close('operator ended voice');
        if (event.type === 'mute') this.log({ type: 'voice.mute', muted: Boolean(event.muted) });
        if (event.type === 'microphone_gate' && Number.isFinite(event.threshold) && event.threshold >= 0 && event.threshold <= .05) this.log({ type: 'voice.microphone_gate', threshold: event.threshold });
        if (event.type === 'speaking_level') this.setSpeakingLevel(event.level).catch(error => this.fault(error));
        if (event.type === 'append_instruction') this.appendInstruction(event.text).catch(error => this.fault(error));
        if (event.type === 'playback_audio' && this.audit && event.voiceSessionId === this.live?.id
          && typeof event.pcm === 'string' && event.pcm.length <= 14000
          && Number.isSafeInteger(event.offsetSamples) && event.offsetSamples >= 0 && Number.isFinite(event.at)) {
          const pcm = Buffer.from(event.pcm, 'base64');
          if (pcm.length && pcm.length <= 9600 && pcm.length % 2 === 0) this.audit.write('playback', pcm, { offsetSamples: event.offsetSamples, at: event.at });
          if (typeof event.microphone === 'string' && event.microphone.length <= 14000) {
            const microphone = Buffer.from(event.microphone, 'base64');
            if (microphone.length === pcm.length) this.audit.write('microphone', microphone, { offsetSamples: event.offsetSamples, at: event.at });
          }
        }
        if (event.type === 'audio_level' && [event.at, event.durationMs, event.inputRms, event.outputRms].every(Number.isFinite)
          && Math.abs(event.at - Date.now()) < 5000 && event.durationMs > 0 && event.durationMs <= 500
          && event.inputRms >= 0 && event.inputRms <= 1 && event.outputRms >= 0 && event.outputRms <= 1) {
          this.log({ ...event, liveRun: this.live?.reservation, backlogMs: Number.isFinite(event.backlogMs) ? event.backlogMs : undefined });
          const items = this.timeline.add(event);
          if (items.length) ws.send(JSON.stringify({ type: 'timeline_update', items }));
        }
        if (event.type === 'audio_stopped') { this.log({ type: 'audio_stopped', liveRun: this.live?.reservation }); this.publish({ type: 'audio_stopped' }); this.saveTimeline(); }
      } catch (error) { this.fault(error); }
    });
    ws.on('error', error => this.fault(error));
    ws.on('close', () => { if (this.browser === ws) { this.browser = null; if (this.stopping) return; this.publish({ type: 'audio_stopped' }); this.saveTimeline(); this.live?.close('voice client disconnected'); } });
  }
  async startLive(sdp) {
    if (sdp !== undefined && (typeof sdp !== 'string' || !sdp.trim() || Buffer.byteLength(sdp) > 65536)) throw new Error('Invalid voice connection offer.');
    if (this.live && this.live.state !== 'closed') return;
    if (!this.channelReady) throw new Error('Wait for the voice channel to connect in the Claude terminal.');
    if (this.observer.state === 'exited') throw new Error('The Claude session has exited.');
    const attachment = `You are attached to Claude Code in ${this.cwd}. Its current state is ${this.observer.state}. Recorded observations are reference data, including work from before this voice connection. Those requests were already submitted. Answer from this evidence and do not resend them. Follow the selected speaking preference; do not narrate historical work.`;
    const history = startupHistory(this.observer.observations, Math.max(0, 7600 - Buffer.byteLength(attachment)));
    const input = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: attachment }] }];
    if (history.text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Recorded Claude context only. This is not a new user request:\n${history.text}` }] });
    const startupLevel = this.speakingLevel;
    const startupInstructions = [...this.additionalInstructions];
    const live = new LiveSession({ apiKey: this.apiKey, budget: this.budget, voice: this.voice, instructions: this.instructions(), label: `Claude ${this.sessionId}`, input, log: event => this.log({ liveRun: live.reservation, ...event }) });
    let preferenceReady;
    this.speakingUpdate = { state: 'starting', level: startupLevel };
    this.audit?.close(); this.audit = null;
    this.live = live;
    this.mediator?.stop();
    this.mediator = new Mediator({ live, observer: this.observer, initialObservationCount: history.count, speakingLevel: startupLevel, deliver: task => this.deliver(task), log: this.log, publish: event => this.publish(event), clean: this.clean });
    this.publish(this.status());
    live.on('fault', error => this.fault(error));
    live.on('answer', sdp => this.publish({ type: 'voice_answer', sdp }));
    live.on('sent', event => {
      if (/^session\.(thinking|commentary|instructions)\.append$/.test(event.type)) this.publish({ type: 'context_sent', id: event.event_id, kind: event.type.split('.')[1], text: event.content, notification: event });
    });
    live.on('event', event => {
      if (event.type === 'session.output_audio.delta') {
        const pcm = Buffer.from(event.delta, 'base64');
        this.audit?.write('output', pcm, { startMs: event.start_ms, endMs: event.end_ms });
        if (live.transport === 'webrtc') return; // The browser plays the negotiated media track.
        if (this.browser?.readyState !== WebSocket.OPEN) return;
        if (this.browser.bufferedAmount > 1024 * 1024) return live.close('Audio playback connection too slow');
        this.browser.send(pcm);
      }
      if (event.type === 'session.input_audio.append' && live.transport === 'webrtc') {
        this.lastAudioAt = Date.now();
        this.audit?.write('input', Buffer.from(event.audio, 'base64'), { startMs: event.start_ms, endMs: event.end_ms });
      }
      if (/^session\.(thinking|commentary|instructions)\.appended$/.test(event.type)) this.publish({ type: 'context_ack', id: event.client_event_id, startMs: event.start_ms, endMs: event.end_ms });
      if (event.type === 'session.started') {
        for (const item of startupInstructions) Object.assign(item, { state: 'acknowledged', sessionId: live.id, acknowledgedAt: Date.now(), error: undefined });
        this.speakingUpdate = { state: 'acknowledged', level: startupLevel, confirmedLevel: startupLevel, sessionId: live.id, acknowledgedAt: Date.now(), source: 'startup' };
        if (this.speakingLevel !== startupLevel) preferenceReady = this.setSpeakingLevel(this.speakingLevel);
        this.audit = new AudioAudit({ dir: path.join(this.runDir, 'audio', live.reservation), log: event => this.log({ liveRun: live.reservation, ...event }), onError: error => this.fault(error) });
        this.publish({ type: 'voice_started', sessionId: live.id });
        this.publish(this.status());
      }
    });
    live.on('closed', result => { clearInterval(this.audioWatchdog); this.mediator?.stop(); this.publish({ type: 'voice_closed', ...result }); this.publish(this.status()); this.saveTimeline(); });
    this.lastAudioAt = Date.now();
    await live.start(sdp);
    this.audioWatchdog = setInterval(() => { if (Date.now() - this.lastAudioAt > 5000) live.close('Microphone audio stream stopped'); }, 1000);
    await preferenceReady;
    if (this.speakingLevel !== 0 && live.state === 'active') await live.greet();
  }
  async close() {
    if (this.stopping) return; this.stopping = true;
    clearInterval(this.statusTimer); clearInterval(this.audioWatchdog); clearTimeout(this.channelLostTimer);
    if (this.live) await this.live.close('harness stopped');
    this.mediator?.stop(); this.observer.close();
    this.audit?.close(); this.saveTimeline();
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close(); await new Promise(resolve => this.http.close(resolve));
  }
}
