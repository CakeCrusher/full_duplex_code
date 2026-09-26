import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startCodexTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.ts';

// Real Codex and real GPT Live voice: a spoken request steers Codex's running
// turn, and Codex acts on it within that turn. Spends Codex and GPT Live usage.
// The request is spoken while Codex waits on a long command: context appends
// arriving while Live answers can keep it from delegating (see USAGE.md).
const spokenRequest = synthesize('codex-steer-2', 'Please ask Codex to create one more file, named voice dot text, containing the word voice.');
const work = 'Create four files one at a time, in this order: a.txt, b.txt, c.txt, d.txt. Each contains just its letter. Before each file, run the shell command `sleep 20`. Write one short sentence before each file saying which file is next. When all are done, say DONE.';
const test = await startCodexTestHarness('codex-voice', work);
const evidence: Record<string, any> = { passed: false };
let voice: Awaited<ReturnType<typeof connectTestVoice>> | undefined;
const events = () => fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const hooks = (name: string) => events().filter(e => e.type === 'agent.hook' && e.name === name);
try {
  const firstTurn = (await until(() => hooks('UserPromptSubmit')[0], { label: 'Codex started its turn' })).turn_id;
  voice = await connectTestVoice(test.harness);
  await until(() => voice!.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting', timeout: 30000 });
  // Speak once Codex starts its next sleep, when its events pause.
  const sleeps = hooks('PreToolUse').length;
  await until(() => hooks('PreToolUse').length > sleeps, { label: 'Codex started a long command', timeout: 90000 });
  await delay(2500);
  assert.equal(hooks('Stop').length, 0, 'Codex is still working on its first turn');
  await voice.speak(spokenRequest);
  await until(() => test.harness.outbox.size >= 1, { label: 'Live delegated the request', timeout: 45000 });
  const [task] = [...test.harness.outbox.values()];
  await until(() => task.state === 'sent', { label: 'request delivered', timeout: 20000 });
  const delivery = events().find(e => e.type === 'codex.delivery' && e.id === task.id);
  assert.equal(delivery.via, 'turn/steer', 'the request steered the running turn');
  assert.equal(delivery.turnId, firstTurn);
  await until(() => hooks('Stop').length >= 1, { label: 'the turn ended', timeout: 240000 });
  const stop = hooks('Stop')[0];
  assert.equal(stop.turn_id, firstTurn, 'the first Stop ends the steered turn');
  assert.ok(fs.existsSync(path.join(test.cwd, 'voice.txt')), 'Codex created voice.txt');
  assert.match(fs.readFileSync(path.join(test.cwd, 'voice.txt'), 'utf8'), /voice/i);
  const steered = hooks('UserPromptSubmit').find(e => String(e.prompt).startsWith(`[Voice request ${task.id}]`));
  assert.equal(steered?.turn_id, firstTurn, 'Codex received the request inside the running turn');
  const item = test.harness.timeline.snapshot().items.find(i => i.requestId === task.id)!;
  assert.equal(item.state, 'observed'); assert.equal(item.contentMatches, true);
  await delay(4000);
  Object.assign(evidence, { passed: true, firstTurn, delivery, files: fs.readdirSync(test.cwd).filter(f => f.endsWith('.txt')).sort(), requestText: task.content,
    spoken: voice.events.filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('') });
  console.log('\nCODEX VOICE PASSED');
} catch (error) { evidence.error = (error as Error).message; throw error; }
finally {
  if (voice) await voice.close();
  evidence.usageSeconds = test.harness.live?.usageSeconds ?? 0;
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  await test.close();
}
