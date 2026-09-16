import fs from 'node:fs';
import path from 'node:path';

const RATE = 24000;
function header(bytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40); return h;
}

// Local, independent tracks: input actually sent, API output on its own clock,
// and browser-rendered output (including silent buffer underruns).
export class AudioAudit {
  constructor({ dir, log, onError }) {
    Object.assign(this, { dir, log, onError }); this.tracks = new Map(); this.closed = false;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (error) { this.fail(error); }
  }
  write(track, pcm, metadata = {}) {
    if (this.closed || !pcm.length) return;
    try {
      if (!['input', 'microphone', 'output', 'playback'].includes(track) || pcm.length % 2) throw new Error('Invalid audit audio');
      let file = this.tracks.get(track);
      if (!file) {
        file = { fd: fs.openSync(path.join(this.dir, `${track}.wav`), 'wx', 0o600), samples: 0 };
        this.tracks.set(track, file); fs.writeSync(file.fd, header(0), 0, 44, 0);
      }
      // Reflected API audio can omit frames. Missing samples are unknown, not
      // confirmed silence. Zero-filled holes preserve their place in the audit;
      // concatenating packets would compress time and disguise missing audio.
      const apiOffset = track === 'output' && Number.isFinite(metadata.startMs) ? Math.round(metadata.startMs * RATE / 1000) : undefined;
      const offset = metadata.offsetSamples ?? apiOffset ?? file.samples;
      // A missing browser packet is visible in the log and remains silence in
      // the recording; never silently squeeze time out of rendered playback.
      if (!Number.isSafeInteger(offset) || offset < file.samples || (apiOffset === undefined && offset > file.samples + RATE * 5)) throw new Error('Playback audit sample discontinuity');
      if (offset !== file.samples) this.log({ type: 'audio.audit_gap', track, expected: file.samples, actual: offset,
        reason: apiOffset !== undefined ? 'missing_api_output' : 'missing_audit_samples',
        startMs: file.samples * 1000 / RATE, endMs: offset * 1000 / RATE,
        durationMs: (offset - file.samples) * 1000 / RATE });
      fs.writeSync(file.fd, pcm, 0, pcm.length, 44 + offset * 2);
      file.samples = offset + pcm.length / 2;
      fs.writeSync(file.fd, header(file.samples * 2), 0, 44, 0);
      this.log({ type: 'audio.packet', track, ...metadata, offsetSamples: offset, samples: pcm.length / 2 });
    } catch (error) { this.fail(error); }
  }
  fail(error) { this.close(); this.onError(new Error(`Local audio audit failed: ${error.message}`)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const file of this.tracks.values()) { try { fs.closeSync(file.fd); } catch {} }
  }
}
