import test from 'node:test';
import { textFragments, estimatedTokens } from '../src/core/text-fragments.ts';
import assert from 'node:assert/strict';
import { ContextQueue } from '../src/core/context-queue.ts';
import { Floor } from '../src/core/floor.ts';
import { LineReader } from '../src/core/line-reader.ts';
import { VoiceHistory, type SpokenRequest } from '../src/core/voice-history.ts';
import { redact } from '../src/core/redact.ts';
import { recentHistory } from '../src/core/recent-history.ts';
import { contextData } from '../src/core/context-rules.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { pi } from '../src/adapters/pi/index.ts';
// Every observation append starts with this label.

test('base64 is omitted wherever it appears, for any agent; ordinary text of any length is not', () => {
  const screenshot = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ'.repeat(5000) } };
  const mcp = { type: 'image', data: 'iVBORw0K'.repeat(5000), mimeType: 'image/png' };
  const read = { type: 'image', file: { base64: 'iVBOR'.repeat(32000), type: 'image/png', dimensions: { originalWidth: 520, originalHeight: 900 } } };
  const generated = { type: 'input_image', image_url: 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(2000), detail: 'high' };
  const prose = 'A long paragraph of ordinary text, kept whole. '.repeat(2000);
  const printed = 'Script completed\nOutput:\n{"content":[{"type":"text","text":"Captured"},{"type":"image","data":"' + '/9j/4AAQ'.repeat(1000) + '=="}]}';
  const raw = JSON.stringify({ tool_response: [{ type: 'text', text: 'Score 20' }, screenshot, mcp, read, generated], code: 'const data = "ABCxyz";', prose, printed });
  const data: any = contextData(claude, { name: 'PostToolUse', text: raw });
  assert.equal(data.tool_response[1].source.data, '[omitted: 40,000 chars]');
  assert.equal(data.tool_response[2].data, '[omitted: 40,000 chars]');
  assert.deepEqual(data.tool_response[3], { type: 'image', file: { base64: '[omitted: 160,000 chars]', type: 'image/png', dimensions: { originalWidth: 520, originalHeight: 900 } } });
  assert.equal(data.tool_response[4].image_url, '[omitted: 22,022 chars]');
  assert.equal(data.tool_response[0].text, 'Score 20'); assert.equal(data.code, 'const data = "ABCxyz";'); assert.equal(data.prose, prose);
  assert.equal(data.printed, 'Script completed\nOutput:\n{"content":[{"type":"text","text":"Captured"},{"type":"image","data":"[omitted: 8,002 chars]"}]}', 'base64 printed inside text');
  assert.equal(JSON.parse(raw).tool_response[1].source.data.length, 40000, 'the original stays intact for the local log');
  assert.ok(recentHistory(claude, [{ name: 'PostToolUse', text: JSON.stringify({ tool_response: [screenshot] }) }]).text.length < 1000, 'resuming voice also omits the bytes');
});

test('startup context is filtered as live context is', () => {
  const observations = [
    { name: 'UserPromptSubmit', text: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<channel source="voice" message_id="3f1e2d4c-5b6a-4978-8a9b-0c1d2e3f4a5b" source_kind="voice_operator">\nUser request (transcribed speech): …\n</channel>' }) },
    { name: 'MessageDisplay', text: JSON.stringify({ hook_event_name: 'MessageDisplay', session_id: 's', delta: 'The page is ready.' }) },
    { name: 'Stop', text: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'The page is ready.' }) },
  ];
  const history = recentHistory(claude, observations);
  assert.equal(history.count, 2);
  assert.match(history.text, /\[voice request 3f1e2d4c: the voice command you already have; Claude has received it\]/);
  assert.match(history.text, /"delta":"The page is ready\."/);
  assert.doesNotMatch(history.text, /last_assistant_message|session_id/);
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
  assert.equal(sent.join(''),source+'new observation','agent context goes as it is, with no stamp on each part');
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

test('agent context waits while the operator talks, even mid-batch, at most ten seconds, and keeps its order', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent: string[]=[],floor=new Floor(),ws={bufferedAmount:0};
  const live={state:'active',ws,append:(_kind: string,text: string)=>{sent.push(text);if(sent.length===2)floor.hear();return new Promise<void>(()=>{});}};
  const queue=new ContextQueue(live,error=>{throw error;},claude,{floor});
  queue.add('thinking','const item = { score: 123, state: "ready" };\n'.repeat(300));
  assert.equal(sent.length,2,'the operator started talking during the batch');
  queue.add('thinking','No new operator speech is available to send.','delegation-1');
  t.mock.timers.tick(1900);assert.equal(sent.length,2);
  t.mock.timers.tick(200);assert.ok(sent.length>4,'two seconds after they stop, the rest goes in');
  assert.ok(sent.some(text=>text.includes('No new operator speech')),'in order, behind the batch');
  const before=sent.length;
  floor.hear();queue.add('thinking','late observation');
  for(let i=0;i<30;i++){floor.hear();t.mock.timers.tick(500);}
  assert.equal(sent.length,before+1,'never more than ten seconds');
  queue.stop();
});

test('an answer about a delegation does not wait for the operator when nothing is ahead of it', () => {
  const sent: string[]=[],floor=new Floor();
  const live={state:'active',append:(_kind: string,text: string)=>{sent.push(text);return new Promise<void>(()=>{});}};
  const queue=new ContextQueue(live,error=>{throw error;},claude,{floor});
  floor.hear();
  queue.add('thinking','No new operator speech is available to send.','delegation-1');
  assert.equal(sent.length,1);
  queue.add('thinking','observation');
  assert.equal(sent.length,1,'agent context still waits');
  queue.stop();
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

test('out-of-order acknowledgments retain send order and a rejection stops subsequent observations', async () => {
  const sent: string[]=[],pending: { resolve: (value?: unknown) => void; reject: (error: Error) => void }[]=[],faults: string[]=[];
  const live={state:'active',append:(_kind: string,text: string)=>new Promise((resolve,reject)=>{sent.push(text);pending.push({resolve,reject});})};
  const queue=new ContextQueue(live,error=>faults.push(error.message),claude);
  for(const text of ['one','two','three','four'])queue.add('thinking',text);
  pending[1].resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sent,['one','two','three','four']);
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
test('only delivery consumes a request, and repeating it cannot resend the same speech', () => {
  const h = new VoiceHistory();
  h.add({ type: 'session.input_transcript.delta', delta: 'Create ', start_ms: 1, end_ms: 100 });
  h.add({ type: 'session.input_transcript.delta', delta: 'a file.', start_ms: 100, end_ms: 200 });
  const request = h.request()!; assert.deepEqual(said(request), ['operator: Create a file.']);
  assert.deepEqual(said(h.request()), ['operator: Create a file.']);
  h.markDelivered(request); assert.equal(h.request(), null);
  h.add({ type: 'session.input_transcript.delta', delta: 'Use JavaScript.', start_ms: 300, end_ms: 400 });
  assert.deepEqual(said(h.request()), ['operator: Use JavaScript.']);
});
test('words GPT Live transcribed from the silence it heard are not passed on as the operator\'s', () => {
  const h = new VoiceHistory();
  const echo = (start_ms: number, end_ms: number, level: number) => h.hearAudio({ start_ms, end_ms, audio: Buffer.from(new Int16Array((end_ms - start_ms) * 24).fill(level).buffer).toString('base64') });
  for (let ms = 0; ms < 20000; ms += 200) echo(ms, ms + 200, ms >= 2000 && ms < 4000 ? 9000 : 1);
  h.add({ type: 'session.input_transcript.delta', delta: 'Add a test.', start_ms: 2200, end_ms: 3600 });
  h.add({ type: 'session.input_transcript.delta', delta: 'a brief outcome only', start_ms: 9000, end_ms: 9400 });
  const request = h.request()!;
  assert.deepEqual(said(request), ['operator: Add a test.']); assert.deepEqual(request.unheard, ['a brief outcome only']);
  h.markDelivered(request);
  h.add({ type: 'session.input_transcript.delta', delta: 'the', start_ms: 15000, end_ms: 15200 });
  assert.equal(h.request(), null, 'nothing heard, nothing to send');
  h.add({ type: 'session.input_transcript.delta', delta: 'Ship it.', start_ms: 30000, end_ms: 30600 });
  assert.deepEqual(said(h.request()), ['operator: Ship it.'], 'without an echo of that stretch, the words are kept');
  assert.equal(h.audible(3800, 4400), true, 'a second either side counts');
});
test('compaction summaries do not reach GPT Live; the compaction itself does', () => {
  const claudeData: any = contextData(claude, { name: 'PostCompact', text: JSON.stringify({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'The user said "ship it".' }) });
  assert.deepEqual(claudeData, { trigger: 'auto' });
  const piData: any = contextData(pi, { name: 'session_compact', text: JSON.stringify({ type: 'session_compact', reason: 'threshold', compactionEntry: { type: 'compaction', summary: 'The user said "ship it".', tokensBefore: 90000, details: {} } }) });
  assert.equal(piData.compactionEntry.summary, undefined); assert.equal(piData.reason, 'threshold');
});
test('the nameless sub-agents of Claude\'s own helpers do not reach GPT Live; real sub-agents do', () => {
  const stop = (agent_type: string) => contextData(claude, { name: 'SubagentStop', text: JSON.stringify({ hook_event_name: 'SubagentStop', agent_type, last_assistant_message: 'Summary: the user said "ship it".' }) });
  assert.equal(stop(''), undefined);
  assert.match(JSON.stringify(stop('general-purpose')), /ship it/);
});
test('known credentials and likely API keys are scrubbed', () => {
  assert.equal(redact('token abcdefghijk', ['abcdefghijk']), 'token [redacted]');
  assert.equal(redact('sk-proj-' + 'a'.repeat(32)), '[redacted API key]');
});


test('a request is the conversation since the previous request, one utterance per speaker and pause', () => {
  const h = new VoiceHistory();
  const say = (stream: 'input' | 'output', delta: string, start_ms: number, end_ms: number) => h.add({ type: `session.${stream}_transcript.delta`, delta, start_ms, end_ms });
  say('input', 'Fix the login bug.', 0, 800);
  h.markDelivered(h.request()!);
  say('input', 'What port?', 2000, 2800);
  say('output', 'Port 4317.', 3000, 3800);
  say('input', ' Create', 9000, 9400);
  say('output', 'Mm hmm', 9300, 9500);
  say('input', ' a file.', 9400, 9900);
  say('input', ' Then test it.', 12500, 13000);
  say('output', 'Sure.', 13200, 13600);
  const request = h.request()!;
  assert.deepEqual(said(request), ['operator: What port?', 'intermediary: Port 4317.', 'operator: Create a file.', 'intermediary: Mm hmm', 'operator: Then test it.', 'intermediary: Sure.'],
    'nothing from before the previous request; a backchannel does not split an utterance, a pause over 2 s does');
  assert.equal(request.fresh, 'Then test it.', 'the latest words are what the turn is read for');
  h.claim(request, 'r1');
  say('input', ' One more thing.', 17000, 17500);
  assert.deepEqual(said(h.request()), ['operator: One more thing.'], 'words said while a request is on its way go with the next one');
  h.commit('r1'); h.markDelivered(h.request()!);
  say('output', 'Done.', 19000, 19500);
  assert.equal(h.request(), null, 'the voice assistant alone makes no request');
});


test('startup context keeps the most recent observations in order and notes what it omitted', () => {
  const observations = Array.from({ length: 10 }, (_, i) => ({ name: 'PostToolUse', text: JSON.stringify({ result: `observation ${i} ` + 'x'.repeat(100) }) }));
  const history = recentHistory(claude, observations, 700);
  assert.ok(history.count > 0 && history.count < 10);
  assert.equal(history.omitted, 10 - history.count);
  assert.match(history.text, /observation 9/); assert.doesNotMatch(history.text, /observation 0 /);
  assert.ok(history.text.indexOf('observation 8') < history.text.indexOf('observation 9'), 'chronological order');
  assert.match(history.text, new RegExp(`${history.omitted} earlier records`));
  assert.ok(Buffer.byteLength(history.text) <= 700);
  assert.equal(recentHistory(claude, observations, 0).count, 0);
  assert.equal(recentHistory(claude, [], 700).text, '');
  // The conversation among the agent's events, in the order they happened, as the agent reads requests (Jev's history).
  const mixed = recentHistory(claude, [observations[0], { role: 'operator', text: 'Add a dark  mode toggle.' }, observations[1], { role: 'intermediary', text: 'On it.' }]);
  assert.match(mixed.text, /observation 0 [^]*\nuser: Add a dark mode toggle\.\nClaude Code observation \(history\):\n[^\n]*observation 1 [^]*\nvoice assistant: On it\.\n$/);
});

test('an oversized newest observation is excerpted rather than hiding all recent work', () => {
  const history = recentHistory(claude, [{ name: 'PostToolUse', text: '{"result":"older"}' }, { name: 'PostToolUse', text: JSON.stringify({ result: 'START' + '世界'.repeat(4000) + 'FINISH' }) }], 3000);
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
  assert.ok(sent.every(e=>e.kind==='thinking'&&e.text.startsWith('[Claude PostToolUse; part ')));
  assert.equal(sent.map(e=>e.text.replace(/^\[Claude PostToolUse; part \d+\/\d+\]\n/,'')).join(''),raw);
  queue.stop();
});

test("the latest words a turn is read for are all of the operator's since the last reading, across their pauses and what the voice said among them", () => {
  const h = new VoiceHistory();
  const say = (stream: 'input' | 'output', delta: string, start_ms: number, end_ms: number) => h.add({ type: `session.${stream}_transcript.delta`, delta, start_ms, end_ms });
  say('input', 'Run the tests.', 0, 900);
  say('output', 'Sure.', 1000, 1400);
  say('input', "Okay, that's it, send it", 5000, 6500);
  say('output', 'Mm-hmm.', 6600, 6900);
  say('input', ' over.', 9500, 9900);
  const read = h.spoken(Infinity, 0).map(({ role, text }) => `${role}: ${text}`);
  assert.deepEqual(read, ['operator: Run the tests.', 'intermediary: Sure.', "operator: Okay, that's it, send it over."]);
  assert.deepEqual(h.spoken().map(({ text }) => text).at(-1), 'over.', 'without it, only the words after their last pause');
});
