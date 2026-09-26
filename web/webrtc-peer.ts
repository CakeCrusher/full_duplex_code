// The WebRTC connection that carries audio between the page and GPT Live.
const TRANSPORT_FIELDS = ['packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter', 'concealedSamples', 'silentConcealedSamples',
  'concealmentEvents', 'totalSamplesReceived', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
  'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'];

export interface PeerHandlers {
  /** Whether receiver diagnostics are wanted now, and whether they can be sent. */
  active(): boolean;
  connected(): boolean;
  sendStats(stats: Record<string, number | undefined>): void;
  /** Whether the audio graph can play a received track, and playing it. */
  canPlay(): boolean;
  play(received: MediaStream): void;
  fail(message: string): void;
}

export class WebRtcPeer {
  connection: RTCPeerConnection | null = null;
  remoteAudio: HTMLAudioElement | null = null;
  transportTimer: ReturnType<typeof setInterval> | null = null;
  /** Creates the connection for the microphone track and returns the offer to send. */
  async offer(microphone: MediaStream, handlers: PeerHandlers): Promise<string> {
    const connection = this.connection = new RTCPeerConnection();
    // Audit the receiver independently of captions and worklet playback.
    // A final packetsLost count can be zero even when late packets caused
    // audible concealment earlier, so retain the counters over time.
    let samplingTransport = false;
    this.transportTimer = setInterval(async () => {
      if (!handlers.active() || samplingTransport || this.connection !== connection) return;
      samplingTransport = true;
      try {
        const report = await connection.getStats();
        if (!handlers.active() || this.connection !== connection || !handlers.connected()) return;
        for (const stat of report.values()) {
          if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') continue;
          const stats: Record<string, number | undefined> = Object.fromEntries(TRANSPORT_FIELDS.filter(key => Number.isFinite(stat[key])).map(key => [key, stat[key]]));
          stats.clockRate = report.get(stat.codecId)?.clockRate;
          stats.requestedJitterBufferMs = (connection.getReceivers().find(receiver => receiver.track.kind === 'audio') as (RTCRtpReceiver & { jitterBufferTarget?: number }) | undefined)?.jitterBufferTarget;
          handlers.sendStats(stats);
        }
      } catch { /* Missing diagnostics must not interrupt audio. */ }
      finally { samplingTransport = false; }
    }, 1000);
    connection.ontrack = event => {
      if (this.connection !== connection || !handlers.canPlay()) return;
      // Give late network packets a small recovery window in the existing
      // WebRTC receiver. Speech still streams continuously in both directions.
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 200;
      const received = new MediaStream([event.track]);
      // Chrome starts the WebRTC receiver's playout clock through a media
      // element. Keep that element silent: the measured worklet is the only
      // audible output, so the same track cannot play twice.
      const remoteAudio = this.remoteAudio = new Audio(); remoteAudio.srcObject = received; remoteAudio.muted = true;
      remoteAudio.play().catch(error => { if (this.connection === connection) handlers.fail(error.message); });
      handlers.play(received);
    };
    connection.onconnectionstatechange = () => {
      if (this.connection === connection && connection.connectionState === 'failed') handlers.fail('The voice media connection failed. Start voice again to reconnect.');
    };
    for (const track of microphone.getAudioTracks()) connection.addTrack(track, microphone);
    connection.createDataChannel('oai-events');
    await connection.setLocalDescription(await connection.createOffer());
    if (connection.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { connection.removeEventListener('icegatheringstatechange', changed); reject(new Error('Voice network setup timed out. Try again.')); }, 10000);
      function changed() {
        if (connection.iceGatheringState !== 'complete') return;
        clearTimeout(timer); connection.removeEventListener('icegatheringstatechange', changed); resolve();
      }
      connection.addEventListener('icegatheringstatechange', changed); changed();
    });
    return connection.localDescription!.sdp;
  }
  /** GPT Live's answer, relayed by the bridge. */
  answer(sdp: string, fail: (message: string) => void) {
    const connection = this.connection;
    if (!connection) return;
    connection.setRemoteDescription({ type: 'answer', sdp }).catch(error => { if (this.connection === connection) fail(error.message); });
  }
  close() {
    if (this.transportTimer) clearInterval(this.transportTimer); this.transportTimer = null;
    this.connection?.close(); this.connection = null;
    this.remoteAudio?.pause(); if (this.remoteAudio) this.remoteAudio.srcObject = null; this.remoteAudio = null;
  }
}
