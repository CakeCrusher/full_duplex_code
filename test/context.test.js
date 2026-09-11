import test from 'node:test';
import assert from 'node:assert/strict';
import { chunks, LineReader, VoiceHistory, redact } from '../src/context.js';

test('context chunks preserve Unicode and stay below the append byte bound', () => {
  const text = 'Hello 世界 👋\n'.repeat(300);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 440));
});
test('JSONL input survives split UTF-8 bytes and partial lines', () => {
  const found = []; const reader = new LineReader(line => found.push(line));
  const data = Buffer.from(JSON.stringify({ text: 'hello 🌎' }) + '\n');
  for (const byte of data) reader.push(Buffer.from([byte]));
  assert.deepEqual(found, [{ text: 'hello 🌎' }]);
});
test('only a delegation consumes a request, and repeating it cannot resend the same speech', () => {
  const h = new VoiceHistory();
  h.add({ type: 'session.input_transcript.delta', delta: 'Create ', start_ms: 1, end_ms: 100 });
  h.add({ type: 'session.input_transcript.delta', delta: 'a file.', start_ms: 100, end_ms: 200 });
  const request = h.request(220); assert.equal(request.text, 'Create a file.');
  assert.equal(h.request(220).text, 'Create a file.');
  h.markDelivered(request); assert.equal(h.request(220), null);
  h.add({ type: 'session.input_transcript.delta', delta: 'Use JavaScript.', start_ms: 300, end_ms: 400 });
  assert.equal(h.request(420).text, 'Use JavaScript.');
});
test('known credentials and likely API keys are scrubbed', () => {
  assert.equal(redact('token abcdefghijk', ['abcdefghijk']), 'token [redacted]');
  assert.equal(redact('sk-proj-' + 'a'.repeat(32)), '[redacted API key]');
});
