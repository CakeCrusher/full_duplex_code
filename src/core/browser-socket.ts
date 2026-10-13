import type { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import type { Page } from './pages.ts';

// Diagnostics from the page's WebRTC receiver and sender that the audit keeps.
const TRANSPORT_FIELDS = ['clockRate', 'requestedJitterBufferMs', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter', 'concealedSamples', 'silentConcealedSamples',
  'concealmentEvents', 'totalSamplesReceived', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
  'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'];
const OUTBOUND_FIELDS = ['packetsSent', 'bytesSent', 'retransmittedPacketsSent', 'nackCount', 'targetBitrate', 'totalPacketSendDelay',
  'remotePacketsLost', 'remoteJitter', 'roundTripTime', 'fractionLost', 'currentRoundTripTime', 'availableOutgoingBitrate'];
const PEER_STATES = ['new', 'checking', 'connecting', 'connected', 'completed', 'disconnected', 'failed', 'closed'];

// The bridge's side of /voice for one page: the page's controls, audio levels
// and audit samples in, and bridge events out. Any page can change settings and
// start voice; audio and voice controls count only from the page running voice.
export function attachPage(bridge: Harness, ws: WebSocket, via: Page['via']) {
  const { pages } = bridge;
  const page = pages.add(ws, via);
  pages.send(page, { type: 'page', id: page.id });
  pages.send(page, bridge.status());
  pages.send(page, { type: 'timeline_history', ...bridge.timeline.snapshot() });
  pages.send(page, { type: 'history', events: bridge.uiEvents });
  const runsVoice = () => bridge.voiceSessions.page === page;
  ws.on('message', (raw: Buffer, isBinary) => {
    if (isBinary) {
      if (!runsVoice()) return;
      if (raw.length > 9600 || raw.length % 2) { bridge.fault(new Error('Invalid microphone audio frame'), page); ws.close(1008); return; }
      bridge.voiceSessions.lastAudioAt = Date.now();
      try {
        const sending = bridge.live?.state === 'active';
        bridge.live?.audio(raw);
        if (sending) bridge.audit?.write('input', raw);
      } catch (error) { bridge.fault(error as Error); }
      return;
    }
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'start') bridge.startLive(event.sdp, page, event.mode === 'resume' ? 'resume' : 'fresh', event.automatic === true).catch(error => bridge.fault(error, page));
      if (event.type === 'append_instruction') bridge.appendInstruction(event.text).catch(error => bridge.fault(error));
      if (event.type === 'page_ready' && ['granted', 'prompt', 'denied', 'unknown'].includes(event.microphone)) { page.ready = { microphone: event.microphone, clicked: event.clicked === true }; bridge.publish(bridge.status()); }
      if (event.type === 'voice_on_failed') { bridge.log({ type: 'sessions.voice_on_failed', page: page.id, message: event.message }); bridge.sessionSwitch.failed(event.message); }
      if (event.type === 'instruction_remove') bridge.removeInstruction(event.id).catch(error => bridge.fault(error));
      // Only pages that held a microphone send this, after their voice ended.
      if (event.type === 'audio_stopped') { bridge.log({ type: 'audio_stopped', liveRun: bridge.live?.reservation, page: page.id }); bridge.publish({ type: 'audio_stopped' }); bridge.saveTimeline(); }
      // Recorded from the page that is about to start voice too.
      if (event.type === 'mute') bridge.log({ type: 'voice.mute', muted: Boolean(event.muted), page: page.id });
      if (event.type === 'microphone_gate' && Number.isFinite(event.threshold) && event.threshold >= 0 && event.threshold <= .05) bridge.log({ type: 'voice.microphone_gate', threshold: event.threshold, page: page.id });
      if (!runsVoice()) return;
      // The page's own microphone levels: the watchdog tells a stalled GPT Live stream from a silent page by them.
      if (event.type === 'audio_level') bridge.voiceSessions.pageAudioAt = Date.now();
      if (event.type === 'stop') bridge.live?.close('operator ended voice');
      // A backlogged page drops its audit copy first; the audit records the gap.
      if (event.type === 'audit_paused' || event.type === 'audit_resumed') {
        bridge.log({ type: `audio.${event.type}`, liveRun: bridge.live?.reservation, buffered: Number.isFinite(event.buffered) ? event.buffered : undefined, dropped: Number.isSafeInteger(event.dropped) ? event.dropped : undefined });
        if (event.type === 'audit_paused') bridge.audit?.allowGap('playback', 'microphone');
      }
      if (event.type === 'peer_state' && [event.connectionState, event.iceConnectionState].every(state => PEER_STATES.includes(state)))
        bridge.log({ type: 'audio.peer_state', at: Number.isFinite(event.at) ? event.at : undefined, receivedAt: Date.now(), liveRun: bridge.live?.reservation, connectionState: event.connectionState, iceConnectionState: event.iceConnectionState });
      if (event.type === 'playback_audio' && bridge.audit && event.voiceSessionId === bridge.live?.id
        && typeof event.pcm === 'string' && event.pcm.length <= 14000
        && Number.isSafeInteger(event.offsetSamples) && event.offsetSamples >= 0 && Number.isFinite(event.at)) {
        const pcm = Buffer.from(event.pcm, 'base64');
        if (pcm.length && pcm.length <= 9600 && pcm.length % 2 === 0) bridge.audit.write('playback', pcm, { offsetSamples: event.offsetSamples, at: event.at });
        if (typeof event.microphone === 'string' && event.microphone.length <= 14000) {
          const microphone = Buffer.from(event.microphone, 'base64');
          if (microphone.length === pcm.length) bridge.audit.write('microphone', microphone, { offsetSamples: event.offsetSamples, at: event.at });
        }
      }
      const live = bridge.live;
      // Late stats are kept, with their arrival time: a backlog is exactly when they matter.
      if (event.type === 'audio_transport' && live?.state === 'active' && event.voiceSessionId === live.id
        && Number.isFinite(event.at) && event.stats && typeof event.stats === 'object') {
        const outbound = event.direction === 'outbound', fields = outbound ? OUTBOUND_FIELDS : TRANSPORT_FIELDS;
        const stats = Object.fromEntries(fields.filter(key => Number.isFinite(event.stats[key])).map(key => [key, event.stats[key]]));
        bridge.log({ type: 'audio.transport', at: event.at, receivedAt: Date.now(), direction: outbound ? 'outbound' : undefined, liveRun: live.reservation, voiceSessionId: live.id, stats });
      }
      if (event.type === 'audio_level' && [event.at, event.durationMs, event.inputRms, event.outputRms].every(Number.isFinite)
        && Math.abs(event.at - Date.now()) < 5000 && event.durationMs > 0 && event.durationMs <= 500
        && event.inputRms >= 0 && event.inputRms <= 1 && event.outputRms >= 0 && event.outputRms <= 1) {
        bridge.log({ ...event, liveRun: bridge.live?.reservation, backlogMs: Number.isFinite(event.backlogMs) ? event.backlogMs : undefined });
        // The voice page's microphone tells the core when the operator is talking.
        if (page === bridge.voiceSessions.page) bridge.voiceSessions.mediator?.hear(event);
        const items = bridge.timeline.add(event);
        if (items.length) pages.broadcast({ type: 'timeline_update', items });
      }
    } catch (error) { bridge.fault(error as Error, page); }
  });
  // One page's connection trouble is logged, not shown on every page.
  ws.on('error', error => bridge.log({ type: 'page.error', page: page.id, message: error.message }));
  ws.on('close', (code, reason) => {
    const hadVoice = runsVoice();
    pages.remove(ws, code, reason.toString());
    if (!hadVoice || bridge.stopping) return;
    bridge.publish({ type: 'audio_stopped' }); bridge.saveTimeline(); bridge.live?.close('voice client disconnected');
  });
}
