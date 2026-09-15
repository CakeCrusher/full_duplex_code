import test from 'node:test';
import assert from 'node:assert/strict';
import { chunks, ContextQueue, LineReader, VoiceHistory, redact, startupHistory } from '../src/context.js';

test('context chunks preserve Unicode and stay below the append byte bound', () => {
  const text = 'Hello 世界 👋\n'.repeat(300);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 440));
});

test('context delivery refills individual slots without waiting for a batch and stays bounded', async () => {
  const pending = []; const sent = []; const faults = [];
  const live = { state: 'active', append: (_kind, content) => {
    sent.push(content);
    return new Promise(resolve => pending.push(resolve));
  } };
  const queue = new ContextQueue(live, e => faults.push(e));
  const source = 'x'.repeat(440 * 34);
  queue.add('thinking', source);
  assert.equal(sent.length, 32);
  assert.equal(queue.queue.length, 2);
  // A late acknowledgment from an older append must not hold up a free slot.
  pending[7]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 33);
  assert.equal(queue.inFlight, 32);
  pending[3]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.join(''), source);
  for (const resolve of pending) resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.running, false);
  assert.equal(queue.inFlight, 0);
  assert.deepEqual(faults, []);
});

test('stopping context delivery prevents late acknowledgments from sending queued content', async () => {
  const pending = []; let sent = 0;
  const live = { state: 'active', append: () => { sent++; return new Promise(resolve => pending.push(resolve)); } };
  const queue = new ContextQueue(live, error => { throw error; });
  queue.add('thinking', 'x'.repeat(440 * 40));
  queue.stop();
  for (const resolve of pending) resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 32);
  assert.equal(queue.queue.length, 0);
  assert.equal(queue.running, false);
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


test('a later command keeps answered questions in context, not in its request text', () => {
  const h = new VoiceHistory();
  h.add({ type: 'session.input_transcript.delta', delta: 'What port?', start_ms: 0, end_ms: 800 });
  h.add({ type: 'session.output_transcript.delta', delta: 'Port 4317.', start_ms: 1000, end_ms: 1800 });
  h.add({ type: 'session.input_transcript.delta', delta: 'Create ', start_ms: 5000, end_ms: 5400 });
  h.add({ type: 'session.output_transcript.delta', delta: 'Mm hmm', start_ms: 5300, end_ms: 5500 });
  h.add({ type: 'session.input_transcript.delta', delta: 'a file.', start_ms: 5400, end_ms: 5900 });
  const request = h.request(6000);
  assert.equal(request.text, 'Create a file.');
  assert.match(request.context, /What port/);
  assert.match(request.context, /4317/);
  h.markDelivered(request); assert.equal(h.request(6000), null);
});


test('startup context uses a complete chronological prefix and leaves overflow for quiet replay', () => {
  const observations = [{ text: 'first' }, { text: '世界'.repeat(4000) }, { text: 'last' }];
  const history = startupHistory(observations, 100);
  assert.equal(history.count, 1); assert.match(history.text, /first/);
  assert.doesNotMatch(history.text, /last/);
  assert.ok(Buffer.byteLength(history.text) <= 100);
  assert.equal(startupHistory(observations, 0).count, 0);
});
