import type { WebSocket } from 'ws';
import type { Harness } from './bridge.ts';
import type { Page } from './pages.ts';

// Diagnostics from the page's WebRTC receiver that the audit keeps.
const TRANSPORT_FIELDS = ['clockRate', 'requestedJitterBufferMs', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter', 'concealedSamples', 'silentConcealedSamples',
  'concealmentEvents', 'totalSamplesReceived', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
  'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'];

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
      if (event.type === 'start') bridge.startLive(event.sdp, page).catch(error => bridge.fault(error, page));
      if (event.type === 'speaking_level') bridge.setSpeakingLevel(event.level).catch(error => bridge.fault(error));
      if (event.type === 'append_instruction') bridge.appendInstruction(event.text).catch(error => bridge.fault(error));
      // Only pages that held a microphone send this, after their voice ended.
      if (event.type === 'audio_stopped') { bridge.log({ type: 'audio_stopped', liveRun: bridge.live?.reservation, page: page.id }); bridge.publish({ type: 'audio_stopped' }); bridge.saveTimeline(); }
      // Recorded from the page that is about to start voice too.
      if (event.type === 'mute') bridge.log({ type: 'voice.mute', muted: Boolean(event.muted), page: page.id });
      if (event.type === 'microphone_gate' && Number.isFinite(event.threshold) && event.threshold >= 0 && event.threshold <= .05) bridge.log({ type: 'voice.microphone_gate', threshold: event.threshold, page: page.id });
      if (!runsVoice()) return;
      if (event.type === 'stop') bridge.live?.close('operator ended voice');
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
