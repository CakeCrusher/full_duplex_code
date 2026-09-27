import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCodexTestHarness, until, delay } from './test-support.ts';

// Real Codex, started without a first message: the companion takes the thread
// the terminal loads, so a request can be Codex's first turn. Then the same
// session resumed, ready at once with its conversation as history, and forked.
// Spends a little Codex usage and no GPT Live.
const evidence: Record<string, any> = { passed: false };
type Test = Awaited<ReturnType<typeof startCodexTestHarness>>;
const events = (test: Test) => fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const hooks = (test: Test, name: string) => events(test).filter(e => e.type === 'agent.hook' && e.name === name);

// Delivers a request before anything is typed, and follows it through Codex's turn.
async function firstRequest(test: Test, content: string) {
  assert.equal(events(test).some(e => e.type === 'agent.hook'), false, 'ready before Codex fired any hook');
  assert.ok(test.harness.sessionId, 'the session is known before the first message');
  const request = { id: randomUUID(), content };
  test.harness.deliver(request);
  const entry = test.harness.outbox.get(request.id)!;
  await until(() => entry.state === 'sent', { label: 'request delivered', timeout: 20000 });
  const prompt = await until(() => hooks(test, 'UserPromptSubmit')[0], { label: 'Codex received the request', timeout: 60000 });
  assert.equal(prompt.session_id, test.harness.sessionId);
  assert.ok(String(prompt.prompt).startsWith(`[Voice request ${request.id}]`), 'the first prompt is the labeled request');
  const stop = await until(() => hooks(test, 'Stop')[0], { label: 'the turn ended', timeout: 180000 });
  await until(() => events(test).some(e => e.type === 'codex.subscribed'), { label: 'subscribed to the thread', timeout: 20000 });
  return { delivery: events(test).find(e => e.type === 'codex.delivery' && e.id === request.id), reply: stop.last_assistant_message, transcript: prompt.transcript_path };
}
// The permissions each turn ran with, from the rollout.
const permissions = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .filter(line => line.type === 'turn_context').map(line => ({ approval: line.payload.approval_policy, sandbox: line.payload.sandbox_policy?.type ?? line.payload.sandbox_policy }));

let test: Test | undefined;
try {
  test = await startCodexTestHarness('codex-start');
  const cwd = test.cwd, first = await firstRequest(test, 'Create a file named hello.txt containing just the word hello, then reply DONE.');
  assert.equal(first.delivery.via, 'turn/start');
  assert.match(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), /hello/i);
  const sessionId = test.harness.sessionId!;
  Object.assign(evidence, { sessionId, first });
  await test.close(); test = undefined;

  test = await startCodexTestHarness('codex-resume', { args: ['resume', '--no-alt-screen', sessionId], cwd });
  assert.equal(test.harness.sessionId, sessionId, 'the resumed session, not a new one');
  const conversation = test.harness.observer.conversation.map(turn => turn.text).join('\n');
  assert.match(conversation, /hello\.txt/, 'the earlier conversation is history before anything is typed');
  const resumed = await firstRequest(test, 'Reply with just the word RESUMED.');
  assert.match(String(resumed.reply), /RESUMED/);
  Object.assign(evidence, { resumed, permissions: permissions(resumed.transcript) });
  await test.close(); test = undefined;

  test = await startCodexTestHarness('codex-fork', { args: ['fork', '--no-alt-screen', sessionId], cwd });
  assert.ok(test.harness.sessionId && test.harness.sessionId !== sessionId, 'a fork is a new session');
  const forked = await firstRequest(test, 'Reply with just the word FORKED.');
  assert.match(String(forked.reply), /FORKED/);
  Object.assign(evidence, { passed: true, forked: { sessionId: test.harness.sessionId, ...forked } });
  console.log('\nCODEX START, RESUME AND FORK PASSED');
} catch (error) { evidence.error = (error as Error).message; throw error; }
finally {
  const runDir = test?.runDir;
  if (test) await test.close();
  if (runDir) fs.writeFileSync(path.join(runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
