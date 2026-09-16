import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.mjs';

// Real terminal Claude and real Live audio. All work stays in a throwaway repo.
const question = synthesize('selective-current', 'What is the current result? Are all seven steps finished?');
const test = await startTestHarness('selective-updates', { maxSeconds: 120 });
let voice;
const evidence = { passed: false };
try {
  voice = await connectTestVoice(test.harness);
  await until(() => voice.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'greeting' });
  await delay(4000);
  const from = Date.now();
  test.terminal.write('Do seven tiny steps using seven separate Bash tool calls. For step N, run echo step-N > step-N.txt. Before each tool call, write one short sentence saying which step you are doing. At the end, report "All seven steps finished; seven files created." Do not use a loop or combine the calls.');
  await delay(250); test.terminal.write('\r');
  await until(() => fs.existsSync(path.join(test.cwd, 'step-7.txt')) && test.harness.observer.state === 'idle', { timeout: 65000, label: 'seven terminal steps' });
  const doneAt = Date.now();
  await delay(18000);
  const start = voice.events.length;
  await voice.speak(question);
  const answer = () => voice.events.slice(start).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
  await until(() => /seven|7/i.test(answer()) && /finish|complete|done|created/i.test(answer()), { timeout: 20000, label: 'current result recall' });
  await delay(3000);
  assert.equal(test.harness.outbox.size, 0, 'status question must not request more Claude work');
  const rows = fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.at >= from);
  const cues = rows.filter(e => e.type === 'bridge.speech_cue');
  const display = rows.filter(e => e.type === 'agent.hook' && e.name === 'MessageDisplay');
  assert.ok(display.length >= 7, 'Claude emitted a real burst of display observations');
  assert.equal(cues.length, 0, 'observations never schedule speech cues');
  assert.equal(rows.filter(e => e.type === 'session.commentary.append').length, 0, 'Claude progress never becomes commentary');
  assert.ok(!rows.some(e => e.type === 'session.commentary.append' && /Claude Code observation/.test(e.content)));
  assert.ok(!rows.some(e => e.type === 'bridge.fault' || e.type === 'error'));
  Object.assign(evidence, { passed: true, displayBatches: display.length, speechCues: cues, workSeconds: (doneAt - from) / 1000, answer: answer(), noExtraDelegations: true,
    spoken: voice.events.filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => ({ at: e.at, text: e.text })),
  });
  console.log('\nSELECTIVE UPDATES PASSED');
} catch (error) { evidence.error = error.message; throw error; }
finally {
  if (voice) await voice.close();
  evidence.usageSeconds = test.harness.live?.usageSeconds ?? 0;
  evidence.estimatedUsd = evidence.usageSeconds * .05 / 60;
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  await test.close();
}
