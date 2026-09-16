import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_REFERENCE, chunks, ContextQueue, LineReader, VoiceHistory, redact, startupHistory, thinkingText } from '../src/context.js';

test('binary attachments stay in raw hooks while Live receives metadata and all surrounding text', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ABCxyz'.repeat(5000) } };
  const hook = { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_response: [{ type: 'text', text: 'Score 20; no console errors' }, image] }], code: 'const data = "ABCxyz";', future_field: 'preserved' };
  const raw=JSON.stringify(hook), result=JSON.parse(thinkingText(raw));
  assert.equal(hook.tool_calls[0].tool_response[1].source.data.length,30000);
  assert.match(result.tool_calls[0].tool_response[1].source.data,/30000 encoded characters retained/);
  assert.equal(result.tool_calls[0].tool_response[0].text,'Score 20; no console errors');
  assert.equal(result.code,hook.code); assert.equal(result.future_field,'preserved');
  assert.ok(thinkingText(raw).length<1000);
  assert.equal(startupHistory([{text:raw}]).count,1,'restart history uses the same text representation');
  assert.equal(thinkingText('ordinary plain text'),'ordinary plain text');
  assert.equal(thinkingText(JSON.stringify({data:'x'.repeat(20000)})),JSON.stringify({data:'x'.repeat(20000)}),'ordinary data fields are not stripped');
  assert.match(thinkingText(JSON.stringify({type:'image',mimeType:'image/png',data:'ABCxyz'.repeat(5000)})),/30000 encoded characters retained/);
});

test('Read image results keep dimensions and file metadata without sending file.base64', () => {
  const file = { base64: 'iVBOR'.repeat(32000), type: 'image/png', originalSize: 120000,
    dimensions: { originalWidth: 520, originalHeight: 900, displayWidth: 520, displayHeight: 900 } };
  const raw = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { type: 'image', file } });
  const result = JSON.parse(thinkingText(raw)).tool_response.file;
  assert.match(result.base64, /160000 encoded characters retained/);
  assert.deepEqual({ ...result, base64: file.base64 }, file);
  assert.equal(JSON.parse(raw).tool_response.file.base64, file.base64, 'the original audit payload remains intact');
  assert.ok(startupHistory([{ text: raw }]).text.length < 1000, 'resuming voice also omits the binary bytes');
  const ordinary = JSON.stringify({ file: { base64: 'ordinary application data' } });
  assert.equal(thinkingText(ordinary), ordinary, 'untyped data is not assumed to be an attachment');
});

test('context chunks preserve Unicode and stay below the append byte bound', () => {
  const text = 'Hello 世界 👋\n'.repeat(300);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 440));
});

test('context injection stays serial and preserves all fragments when more hooks arrive', async () => {
  const pending = []; const sent = []; const faults = [];
  const live = { state: 'active', append: (_kind, content) => {
    sent.push(content);
    return new Promise(resolve => pending.push(resolve));
  } };
  const queue = new ContextQueue(live, e => faults.push(e));
  const source = 'x'.repeat(440 * 34);
  queue.add('thinking', source);
  queue.add('thinking', 'new observation');
  assert.equal(sent.length, 1, 'one pending injection cannot become an overlapping burst');
  assert.equal(queue.queue.length, 34);
  for (let i = 0; i < 35; i++) {
    assert.equal(queue.inFlight, 1);
    pending[i]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, Math.min(i + 2, 35));
  }
  assert.ok(sent.every(text => text.startsWith(BACKGROUND_REFERENCE)));
  assert.ok(sent.every(text => Buffer.byteLength(text) <= 500), 'source label fits the API bound too');
  assert.equal(sent.map(text => text.slice(BACKGROUND_REFERENCE.length)).join(''), source + 'new observation');
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
  assert.equal(sent, 1);
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
