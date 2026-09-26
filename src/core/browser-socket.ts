import type { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';

// Diagnostics from the page's WebRTC receiver that the audit keeps.
const TRANSPORT_FIELDS = ['clockRate', 'requestedJitterBufferMs', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter', 'concealedSamples', 'silentConcealedSamples',
  'concealmentEvents', 'totalSamplesReceived', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
  'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'];

// The bridge's side of /voice: the page's controls, audio levels and audit
// samples in, and every bridge event out.
export function attachBrowser(bridge: Harness, ws: WebSocket) {
  bridge.browser = ws; ws.send(JSON.stringify(bridge.status()));
  ws.send(JSON.stringify({ type: 'timeline_history', ...bridge.timeline.snapshot() }));
  ws.send(JSON.stringify({ type: 'history', events: bridge.uiEvents }));
  ws.on('message', (raw: Buffer, isBinary) => {
    if (isBinary) {
      if (raw.length > 9600 || raw.length % 2) { bridge.fault(new Error('Invalid microphone audio frame')); ws.close(1008); return; }
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
      if (event.type === 'start') bridge.startLive(event.sdp).catch(error => bridge.fault(error));
      if (event.type === 'stop') bridge.live?.close('operator ended voice');
      if (event.type === 'mute') bridge.log({ type: 'voice.mute', muted: Boolean(event.muted) });
      if (event.type === 'microphone_gate' && Number.isFinite(event.threshold) && event.threshold >= 0 && event.threshold <= .05) bridge.log({ type: 'voice.microphone_gate', threshold: event.threshold });
      if (event.type === 'speaking_level') bridge.setSpeakingLevel(event.level).catch(error => bridge.fault(error));
      if (event.type === 'append_instruction') bridge.appendInstruction(event.text).catch(error => bridge.fault(error));
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
      if (event.type === 'audio_transport' && live?.state === 'active' && event.voiceSessionId === live.id
        && Number.isFinite(event.at) && Math.abs(event.at - Date.now()) < 5000 && event.stats && typeof event.stats === 'object') {
        const stats = Object.fromEntries(TRANSPORT_FIELDS.filter(key => Number.isFinite(event.stats[key])).map(key => [key, event.stats[key]]));
        bridge.log({ type: 'audio.transport', at: event.at, liveRun: live.reservation, voiceSessionId: live.id, stats });
      }
      if (event.type === 'audio_level' && [event.at, event.durationMs, event.inputRms, event.outputRms].every(Number.isFinite)
        && Math.abs(event.at - Date.now()) < 5000 && event.durationMs > 0 && event.durationMs <= 500
        && event.inputRms >= 0 && event.inputRms <= 1 && event.outputRms >= 0 && event.outputRms <= 1) {
        bridge.log({ ...event, liveRun: bridge.live?.reservation, backlogMs: Number.isFinite(event.backlogMs) ? event.backlogMs : undefined });
        const items = bridge.timeline.add(event);
        if (items.length) ws.send(JSON.stringify({ type: 'timeline_update', items }));
      }
      if (event.type === 'audio_stopped') { bridge.log({ type: 'audio_stopped', liveRun: bridge.live?.reservation }); bridge.publish({ type: 'audio_stopped' }); bridge.saveTimeline(); }
    } catch (error) { bridge.fault(error as Error); }
  });
  ws.on('error', error => bridge.fault(error));
  ws.on('close', () => { if (bridge.browser === ws) { bridge.browser = null; if (bridge.stopping) return; bridge.publish({ type: 'audio_stopped' }); bridge.saveTimeline(); bridge.live?.close('voice client disconnected'); } });
}
