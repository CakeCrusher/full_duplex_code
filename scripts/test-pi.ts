import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { voiceRequest } from '../src/core/prompts.ts';
import { ObservationProjector } from '../src/core/observation-feed.ts';
import { pi } from '../src/adapters/pi/index.ts';
import { turnText } from '../src/adapters/pi/message.ts';
import { startPiTestHarness, until } from './test-support.ts';

// Real Pi in a terminal with the companion's extension, without GPT Live: a
// request as Pi's first turn, a second one steered into a running turn, then the
// session continued, ready with its conversation as history. Spends a little of
// the model usage Pi is signed in to, and no GPT Live. Set PI_BIN to run Pi from
// a checkout (its pi-test.sh) when no pi is on the PATH.
const evidence: Record<string, any> = { passed: false };
type Test = Awaited<ReturnType<typeof startPiTestHarness>>;
const events = (test: Test) => fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const hooks = (test: Test, name: string) => events(test).filter(e => e.type === 'agent.hook' && e.name === name);
const replies = (test: Test) => hooks(test, 'message_end').filter(e => e.message?.role === 'assistant' && e.message.stopReason === 'stop')
  .map(e => e.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''));

async function deliver(test: Test, content: string) {
  const request = { id: randomUUID(), content };
  test.harness.deliver(request);
  const entry = test.harness.outbox.get(request.id)!;
  await until(() => entry.state === 'sent', { label: 'request delivered', timeout: 20000 });
  const input = await until(() => hooks(test, 'input').find(e => e.text === turnText(request)), { label: 'Pi received the request', timeout: 30000 });
  assert.equal(input.source, 'extension');
  await until(() => test.harness.timeline.requests.get(request.id)?.state === 'observed', { label: 'the timeline matched the request', timeout: 10000 });
  assert.equal(test.harness.timeline.requests.get(request.id)!.contentMatches, true);
  return { request, input };
}
const settled = (test: Test, count: number) => until(() => hooks(test, 'agent_settled').length >= count, { label: `run ${count} settled`, timeout: 180000 });

let test: Test | undefined;
try {
  test = await startPiTestHarness('pi-start');
  assert.equal(test.harness.observer.state, 'idle');
  const sessionId = test.harness.sessionId!;
  assert.ok(sessionId, 'the session is known before anything is typed');

  // 1. A request while Pi is idle starts its first turn. The content is a real
  // transcribed request, with the transcription's stray tokens.
  const first = await deliver(test, voiceRequest([
    { role: 'intermediary', text: "Hey! I'm your Pi voice companion. What's on your mind?" },
    { role: 'operator', text: '<|stream' },
    { role: 'operator', text: "Um, okay, I think we're ready to go ahead with the implementation. Create a file named hello.txt containing just the word hello, then reply DONE." },
  ]));
  assert.equal(first.input.streamingBehavior, undefined, 'started a turn, not a steer');
  await settled(test, 1);
  assert.match(fs.readFileSync(path.join(test.cwd, 'hello.txt'), 'utf8'), /hello/i);
  assert.match(replies(test).at(-1)!, /DONE/);
  assert.equal(test.harness.observer.state, 'idle');

  // 2. A request while a command runs is steered into that turn: one run, one reply.
  await deliver(test, voiceRequest([{ role: 'operator', text: 'Use bash to run exactly: sleep 8 && echo first. Then reply with what it printed.' }]));
  await until(() => hooks(test!, 'tool_execution_start').find(e => String(e.args?.command).includes('sleep 8')), { label: 'the long command started', timeout: 60000 });
  const steer = await deliver(test, voiceRequest([{ role: 'operator', text: 'Also end your reply with the word STEERED.' }]));
  assert.equal(steer.input.streamingBehavior, 'steer', 'delivered into the running turn');
  await settled(test, 2);
  assert.equal(hooks(test, 'agent_start').length, 2, 'the steer joined the running turn instead of starting a third');
  assert.match(replies(test).at(-1)!, /first[\s\S]*STEERED/);

  // What reaches GPT Live from all of it.
  const projector = new ObservationProjector(pi);
  const sent = test.harness.observer.observations.map(o => projector.project(o)).filter(Boolean);
  const context = sent.map(p => p!.text).join('\n');
  for (const field of ['thinkingSignature', 'textSignature', 'responseId', '"usage"', 'session_id']) assert.ok(!context.includes(field), `${field} never reaches GPT Live`);
  Object.assign(evidence, { sessionId, observed: test.harness.observer.observations.length, sent: sent.length, contextChars: context.length,
    largest: Math.max(...sent.map(p => p!.tokens)), replies: replies(test) });
  const { cwd, sessionDir } = test;
  await test.close(); test = undefined;

  // 3. The same session continued: ready at once, with its conversation as history.
  test = await startPiTestHarness('pi-continue', { args: ['--continue'], cwd, sessionDir });
  assert.equal(test.harness.sessionId, sessionId, 'the continued session, not a new one');
  const history = test.harness.observer.conversation.map(turn => turn.text).join('\n');
  assert.match(history, /hello\.txt/, 'the earlier conversation is history before anything is typed');
  await deliver(test, voiceRequest([{ role: 'operator', text: 'Reply with just the word RESUMED.' }]));
  await settled(test, 1);
  assert.match(replies(test).at(-1)!, /RESUMED/);
  Object.assign(evidence, { passed: true, continued: { sessionId: test.harness.sessionId, history: test.harness.observer.conversation.length, reply: replies(test).at(-1) } });
  console.log('\nPI START, STEER AND CONTINUE PASSED');
} catch (error) { evidence.error = (error as Error).message; throw error; }
finally {
  const runDir = test?.runDir;
  if (test) await test.close();
  if (runDir) fs.writeFileSync(path.join(runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
