import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startPiTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// Real Pi and real GPT Live voice. Work typed into Pi's terminal; a spoken
// request steered into that running turn, which Pi acts on before it ends; then
// a spoken question GPT Live answers from Pi's observed events. Spends GPT Live
// usage and the model usage Pi is signed in to. Set PI_BIN as for test:pi.
const spokenRequest = synthesize('pi-steer', 'Please ask Pi to also create one more file, named voice dot text, containing the word voice.');
const question = synthesize('pi-question', 'Which files has Pi created so far?');
const work = 'Create three files one at a time, in this order: a.txt, b.txt, c.txt. Each contains just its letter. Before each file, run the shell command `sleep 15`. Write one short sentence before each file saying which file is next. When all are done, say DONE.';
const test = await startPiTestHarness('pi-voice');
const evidence: Record<string, any> = { passed: false };
let voice: Awaited<ReturnType<typeof connectTestVoice>> | undefined;
const events = () => fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const hooks = (name: string) => events().filter(e => e.type === 'agent.hook' && e.name === name);
const spokenSince = (at: number) => voice!.events.filter(e => e.type === 'caption' && e.role === 'intermediary' && e.at >= at).map(e => e.text).join('');
try {
  // Typed work, as the operator would type it into Pi's terminal.
  test.terminal.write(work); await delay(300); test.terminal.write('\r');
  const typed = await until(() => hooks('input').find(e => e.source === 'interactive'), { label: 'Pi received the typed work', timeout: 30000 });
  assert.equal(typed.text, work);
  voice = await connectTestVoice(test.harness);
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting', timeout: 30000 });
  // Speak once Pi starts its next sleep, when its events pause.
  const sleeps = hooks('tool_execution_start').filter(e => String(e.args?.command).includes('sleep')).length;
  await until(() => hooks('tool_execution_start').filter(e => String(e.args?.command).includes('sleep')).length > sleeps, { label: 'Pi started a long command', timeout: 90000 });
  await delay(2500);
  assert.equal(hooks('agent_settled').length, 0, 'Pi is still working on the typed work');
  await voice.speak(spokenRequest);
  await until(() => test.harness.outbox.size >= 1, { label: 'Live delegated the request', timeout: 45000 });
  const [task] = [...test.harness.outbox.values()];
  await until(() => task.state === 'sent', { label: 'request delivered', timeout: 20000 });
  const steered = await until(() => hooks('input').find(e => String(e.text).startsWith(`[Voice request ${task.id}]`)), { label: 'Pi received the request', timeout: 30000 });
  assert.equal(steered.source, 'extension');
  assert.equal(steered.streamingBehavior, 'steer', 'the request reached the running turn');
  await until(() => hooks('agent_settled').length >= 1, { label: 'the run ended', timeout: 300000 });
  assert.equal(hooks('agent_start').length, 1, 'one run: the request joined it instead of starting another');
  assert.match(fs.readFileSync(path.join(test.cwd, 'voice.txt'), 'utf8'), /voice/i);
  for (const letter of ['a', 'b', 'c']) assert.ok(fs.existsSync(path.join(test.cwd, `${letter}.txt`)), `${letter}.txt`);
  const item = test.harness.timeline.snapshot().items.find(i => i.requestId === task.id)!;
  assert.equal(item.state, 'observed'); assert.equal(item.contentMatches, true);
  // GPT Live answers from what it was told about Pi's work.
  await delay(4000);
  const asked = Date.now();
  await voice.speak(question);
  const answer = await until(() => { const text = spokenSince(asked); return /voice/i.test(text) && /\b[abc]\b|a\.txt|b\.txt|c\.txt|a, b|three/i.test(text) ? text : ''; }, { label: 'an answer naming the files', timeout: 45000 });
  await delay(3000);
  Object.assign(evidence, { passed: true, delivery: { id: task.id, state: task.state, streamingBehavior: steered.streamingBehavior }, requestText: task.content,
    files: fs.readdirSync(test.cwd).filter(f => f.endsWith('.txt')).sort(), answer: spokenSince(asked),
    contextRecords: events().filter(e => e.type === 'context.prepared').reduce((n, e) => n + e.sources.length, 0),
    spoken: spokenSince(0) });
  console.log('\nPI VOICE PASSED');
} catch (error) { evidence.error = (error as Error).message; throw error; }
finally {
  if (voice) await voice.close();
  evidence.usageSeconds = test.harness.live?.usageSeconds ?? 0;
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  await test.close();
  console.log(JSON.stringify(evidence, null, 2));
}
