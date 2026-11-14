// Voice notes (the bridge's notes.ts): the operator's own spoken notes on the run's timeline, to label how fdc did.
// Recording one pauses this page's session microphone, so neither the voice nor Standby hears it, and records the
// microphone apart; stopping saves the note with its start and end, and the session microphone comes back as the
// operator left it. The button records until pressed again; Right Command and Right Option held anywhere on the Mac
// (the bridge's hotkey.ts) record while they are held.
type Event = { type: string; [field: string]: any };
type Options = {
  button: HTMLButtonElement; hint: HTMLElement;
  send(event: Record<string, unknown>): void;
  /** The session's open microphone, while voice is on or on Standby. */
  stream(): MediaStream | null;
  deviceId(): string;
  /** Pauses the session microphone for a note, or lets it be as the operator left it. */
  pause(paused: boolean): void;
  notice(text: string): void;
};
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const HINTS: Record<string, string> = { ready: 'Hold right ⌘ + right ⌥ anywhere', denied: 'Right ⌘ + ⌥ needs Input Monitoring', starting: 'Voice notes', unavailable: 'Voice notes', off: 'Voice notes' };
async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function mountVoiceNotes({ button, hint, send, stream, deviceId, pause, notice }: Options) {
  let recorder: MediaRecorder | undefined, own: MediaStream | undefined, startedAt = 0, ticker: ReturnType<typeof setInterval> | undefined;
  // The microphone can take a moment: a chord let go meanwhile stops the note as soon as it starts.
  let starting = false, byChord = false, letGo = false;
  const show = () => {
    const on = Boolean(recorder);
    button.textContent = on ? `Stop note · ${clock(Date.now() - startedAt)}` : 'Record a note';
    button.setAttribute('aria-pressed', String(on)); button.classList.toggle('recording', on);
  };
  async function start(chord: boolean) {
    if (recorder || starting) return;
    starting = true; byChord = chord; letGo = false;
    pause(true);
    try {
      const live = stream()?.getAudioTracks().find(track => track.readyState === 'live');
      own = live ? undefined : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(deviceId() ? { deviceId: { exact: deviceId() } } : {}) } });
      const mimeType = TYPES.find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(live ? new MediaStream([live]) : own!, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
      const id = crypto.randomUUID();
      // Each piece goes in order, and the end after the last.
      let chain = Promise.resolve();
      rec.ondataavailable = ({ data }) => { if (data.size) chain = chain.then(async () => send({ type: 'note_audio', id, data: await base64(data) })); };
      rec.onstop = () => { const at = Date.now(); chain = chain.then(() => send({ type: 'note_end', id, at })); finish(); };
      rec.start(1000); recorder = rec; startedAt = Date.now();
      send({ type: 'note_start', id, at: startedAt, mimeType: rec.mimeType || mimeType || '' });
      ticker = setInterval(show, 500); show();
      if (letGo) rec.stop();
    } catch (error) {
      finish();
      notice((error as Error).name === 'NotAllowedError' ? 'Allow microphone access in Chrome to record a note.' : `The note did not record: ${(error as Error).message}`);
    } finally { starting = false; }
  }
  function stop() { if (recorder?.state === 'recording') recorder.stop(); else if (starting) letGo = true; }
  function finish() { clearInterval(ticker); own?.getTracks().forEach(track => track.stop()); own = undefined; recorder = undefined; pause(false); show(); }
  button.onclick = () => recorder ? stop() : void start(false);
  button.hidden = false; show();
  return {
    handle(event: Event) {
      if (event.type === 'note_hotkey') { if (event.down) void start(true); else if (byChord) stop(); }
      if (event.type === 'status' && typeof event.noteHotkey === 'string') {
        hint.textContent = HINTS[event.noteHotkey] ?? 'Voice notes';
        hint.title = event.noteHotkey === 'denied' ? 'Allow the terminal app running fdc in System Settings › Privacy & Security › Input Monitoring, then restart fdc.' : '';
      }
    },
  };
}
