import test from 'node:test';
import { textFragments, estimatedTokens } from '../src/core/text-fragments.ts';
import assert from 'node:assert/strict';
import { BACKGROUND_REFERENCE } from '../src/core/prompts.ts';
import { ContextQueue } from '../src/core/context-queue.ts';
import { LineReader } from '../src/core/line-reader.ts';
import { VoiceHistory, type SpokenRequest } from '../src/core/voice-history.ts';
import { redact } from '../src/core/redact.ts';
import { startupHistory } from '../src/core/startup-history.ts';
import { thinkingText } from '../src/core/context-text.ts';
import { claude } from '../src/adapters/claude/index.ts';

test('binary attachments stay in raw hooks while Live receives metadata and all surrounding text', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ABCxyz'.repeat(5000) } };
  const hook: any = { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_response: [{ type: 'text', text: 'Score 20; no console errors' }, image] }], code: 'const data = "ABCxyz";', future_field: 'preserved' };
  const raw=JSON.stringify(hook), result=JSON.parse(thinkingText(raw));
  assert.equal(hook.tool_calls[0].tool_response[1].source.data.length,30000);
  assert.match(result.tool_calls[0].tool_response[1].source.data,/30000 encoded characters retained/);
  assert.equal(result.tool_calls[0].tool_response[0].text,'Score 20; no console errors');
  assert.equal(result.code,hook.code); assert.equal(result.future_field,'preserved');
  assert.ok(thinkingText(raw).length<1000);
  assert.equal(startupHistory(claude, [{text:raw}]).count,1,'restart history uses the same text representation');
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
  assert.ok(startupHistory(claude, [{ text: raw }]).text.length < 1000, 'resuming voice also omits the binary bytes');
  const ordinary = JSON.stringify({ file: { base64: 'ordinary application data' } });
  assert.equal(thinkingText(ordinary), ordinary, 'untyped data is not assumed to be an attachment');
});

test('context fragments preserve Unicode and fit the token estimate including source labels', () => {
  const text = 'Hello 世界 👋\n'.repeat(300);
  const prefix='[Claude PostToolUse; part 999999/999999]\n';
  const parts = textFragments(text,prefix);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => estimatedTokens(prefix+p) <= 460));
});

test('context sends every fragment in order before any API acknowledgment', async () => {
  const pending: (() => void)[]=[],sent: string[]=[],faults: Error[]=[];
  const live={state:'active',append:(_kind: string,content: string)=>{sent.push(content);return new Promise<void>(resolve=>pending.push(resolve));}};
  const queue=new ContextQueue(live,error=>faults.push(error),claude);
  const source='{"file":"hello.js","delta":"const count = 123;"}\n'.repeat(600);
  queue.add('thinking',source);queue.add('thinking','new observation');
  assert.ok(sent.length>8);assert.equal(queue.queue.length,0);assert.equal(queue.inFlight,sent.length);
  for(const resolve of pending.reverse())resolve();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(sent.every(text=>text.startsWith(BACKGROUND_REFERENCE)));
  assert.equal(sent.map(text=>text.slice(BACKGROUND_REFERENCE.length)).join(''),source+'new observation');
  assert.equal(queue.running,false);assert.equal(queue.inFlight,0);assert.deepEqual(faults,[]);
});

test('socket backpressure pauses writes without waiting for model acknowledgments', async () => {
  const sent: string[]=[],pending: (() => void)[]=[],ws={bufferedAmount:0};
  const live={state:'active',ws,append:(_kind: string,text: string)=>{sent.push(text);if(sent.length===2)ws.bufferedAmount=70000;return new Promise<void>(resolve=>pending.push(resolve));}};
  const queue=new ContextQueue(live,error=>{throw error;},claude);
  queue.add('thinking','const item = { score: 123, state: "ready" };\n'.repeat(300));
  assert.equal(sent.length,2);assert.ok(queue.queue.length>2);
  ws.bufferedAmount=0;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(sent.length>4,'socket drain releases writes while all earlier ACKs remain pending');
  assert.equal(queue.queue.length,0);assert.equal(queue.inFlight,sent.length);
  pending.forEach(resolve=>resolve());queue.stop();
});

test('stopping delivery cancels backpressure retries and ignores late acknowledgments', async () => {
  const pending: (() => void)[]=[];let sent=0;const ws={bufferedAmount:0};
  const live={state:'active',ws,append:()=>{sent++;ws.bufferedAmount=70000;return new Promise<void>(resolve=>pending.push(resolve));}};
  const queue=new ContextQueue(live,error=>{throw error;},claude);
  queue.add('thinking','x'.repeat(440*40));queue.stop();ws.bufferedAmount=0;
  pending.forEach(resolve=>resolve());
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(sent,1);assert.equal(queue.queue.length,0);assert.equal(queue.running,false);
});

test('fragments blocked by the network use the current speaking mode without changing their source', async () => {
  const sent: string[]=[],ws={bufferedAmount:70000};
  const live={state:'active',ws,append:async(_kind: string,text: string)=>{sent.push(text);ws.bufferedAmount=70000;}};
  const queue=new ContextQueue(live,error=>{throw error;},claude);
  const original='let score = 10; // keep every character\n'.repeat(300);
  queue.add('thinking',original);queue.setSpeakingLevel(0);ws.bufferedAmount=0;queue.pump();
  assert.match(sent[0],/^\[Quiet:/);
  queue.setSpeakingLevel(1);ws.bufferedAmount=0;queue.pump();
  assert.match(sent[1],/^\[Milestones:/);
  while(queue.queue.length){ws.bufferedAmount=0;queue.pump();}
  assert.equal(sent.map(s=>s.slice(s.indexOf('\n')+1)).join(''),original);queue.stop();
});

test('out-of-order acknowledgments retain send order and a rejection stops subsequent observations', async () => {
  const sent: string[]=[],pending: { resolve: (value?: unknown) => void; reject: (error: Error) => void }[]=[],faults: string[]=[];
  const live={state:'active',append:(_kind: string,text: string)=>new Promise((resolve,reject)=>{sent.push(text);pending.push({resolve,reject});})};
  const queue=new ContextQueue(live,error=>faults.push(error.message),claude);
  for(const text of ['one','two','three','four'])queue.add('thinking',text);
  pending[1].resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sent.map(s=>s.slice(BACKGROUND_REFERENCE.length)),['one','two','three','four']);
  assert.equal(queue.inFlight,3);
  pending[0].reject(new Error('rejected first fragment'));await new Promise(resolve=>setImmediate(resolve));
  queue.add('thinking','five');pending[2].resolve();pending[3].resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,4);assert.equal(faults.length,1);assert.match(faults[0],/rejected first fragment/);
  assert.equal(queue.inFlight,0);queue.stop();
});
test('JSONL input survives split UTF-8 bytes and partial lines', () => {
  const found: unknown[] = []; const reader = new LineReader(line => found.push(line));
  const data = Buffer.from(JSON.stringify({ text: 'hello 🌎' }) + '\n');
  for (const byte of data) reader.push(Buffer.from([byte]));
  assert.deepEqual(found, [{ text: 'hello 🌎' }]);
});
const said = (request: SpokenRequest | null) => request?.utterances.map(u => `${u.role}: ${u.text.trim()}`);
test('only a delegation consumes a request, and repeating it cannot resend the same speech', () => {
  const h = new VoiceHistory();
  h.add({ type: 'session.input_transcript.delta', delta: 'Create ', start_ms: 1, end_ms: 100 });
  h.add({ type: 'session.input_transcript.delta', delta: 'a file.', start_ms: 100, end_ms: 200 });
  const request = h.request(220)!; assert.deepEqual(said(request), ['operator: Create a file.']);
  assert.deepEqual(said(h.request(220)), ['operator: Create a file.']);
  h.markDelivered(request); assert.equal(h.request(220), null);
  h.add({ type: 'session.input_transcript.delta', delta: 'Use JavaScript.', start_ms: 300, end_ms: 400 });
  assert.deepEqual(said(h.request(420)), ['operator: Use JavaScript.']);
});
test('known credentials and likely API keys are scrubbed', () => {
  assert.equal(redact('token abcdefghijk', ['abcdefghijk']), 'token [redacted]');
  assert.equal(redact('sk-proj-' + 'a'.repeat(32)), '[redacted API key]');
});


test('a request is the conversation since the previous delegation, one utterance per speaker and pause', () => {
  const h = new VoiceHistory();
  const say = (stream: 'input' | 'output', delta: string, start_ms: number, end_ms: number) => h.add({ type: `session.${stream}_transcript.delta`, delta, start_ms, end_ms });
  say('input', 'Fix the login bug.', 0, 800);
  h.markDelivered(h.request(900)!);
  say('input', 'What port?', 2000, 2800);
  say('output', 'Port 4317.', 3000, 3800);
  say('input', ' Create', 9000, 9400);
  say('output', 'Mm hmm', 9300, 9500);
  say('input', ' a file.', 9400, 9900);
  say('input', ' Then test it.', 12500, 13000);
  say('output', 'Sure.', 13200, 13600);
  say('input', ' One more thing.', 17000, 17500);
  const request = h.request(13100)!;
  assert.deepEqual(said(request), ['operator: What port?', 'intermediary: Port 4317.', 'operator: Create a file.', 'intermediary: Mm hmm', 'operator: Then test it.', 'intermediary: Sure.'],
    'nothing from before the previous delegation; a backchannel does not split an utterance, a pause over 2 s does');
  h.markDelivered(request);
  assert.deepEqual(said(h.request(18000)), ['operator: One more thing.'], 'speech starting over 3 s after a delegation goes with the next request');
  h.markDelivered(h.request(18000)!);
  say('output', 'Done.', 19000, 19500);
  assert.equal(h.request(20000), null, 'the voice assistant alone makes no request');
});


test('startup context keeps the most recent observations in order and notes what it omitted', () => {
  const observations = Array.from({ length: 10 }, (_, i) => ({ text: `observation ${i} ` + 'x'.repeat(100) }));
  const history = startupHistory(claude, observations, 700);
  assert.ok(history.count > 0 && history.count < 10);
  assert.equal(history.omitted, 10 - history.count);
  assert.match(history.text, /observation 9/); assert.doesNotMatch(history.text, /observation 0 /);
  assert.ok(history.text.indexOf('observation 8') < history.text.indexOf('observation 9'), 'chronological order');
  assert.match(history.text, new RegExp(`${history.omitted} earlier observations`));
  assert.ok(Buffer.byteLength(history.text) <= 700);
  assert.equal(startupHistory(claude, observations, 0).count, 0);
  assert.equal(startupHistory(claude, [], 700).text, '');
});

test('an oversized newest observation is excerpted rather than hiding all recent work', () => {
  const history = startupHistory(claude, [{ text: 'older' }, { text: 'START' + '世界'.repeat(4000) + 'FINISH' }], 3000);
  assert.equal(history.count, 2);
  assert.match(history.text, /START/); assert.match(history.text, /FINISH/); assert.match(history.text, /full record in the local hook log/);
  assert.ok(Buffer.byteLength(history.text) <= 3000);
});

test('every fragment names its originating hook and reconstructs the full UTF-8 payload', async () => {
  const sent: { kind: string; text: string }[]=[];const live={state:'active',append:async(kind: string,text: string)=>sent.push({kind,text})};
  const queue=new ContextQueue(live,error=>{throw error;},claude);
  const raw=JSON.stringify({hook_event_name:'PostToolUse',tool_response:'世界👋'.repeat(1000)});
  queue.add('thinking',raw,null,'Claude PostToolUse');
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(sent.length>1);
  assert.ok(sent.every(e=>e.kind==='thinking'&&e.text.startsWith(BACKGROUND_REFERENCE+'[Claude PostToolUse; part ')));
  assert.equal(sent.map(e=>e.text.slice(BACKGROUND_REFERENCE.length).replace(/^\[Claude PostToolUse; part \d+\/\d+\]\n/,'')).join(''),raw);
  queue.stop();
});
