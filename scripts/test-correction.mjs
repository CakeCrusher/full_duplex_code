import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.mjs';

const build = synthesize('build-calculator', 'Ask Claude to run node slow build dot m j s, with a command timeout of forty five seconds so it stays in the foreground. Then create a JavaScript calculator module exporting an add function for two numbers. Write and run its tests. After testing, explain the design in twelve short numbered lines.');
const correction = synthesize('correct-calculator', 'Change the calculator requirement. The add function must accept numeric strings as well as numbers, and reject invalid input with a Type Error. Make sure those cases are tested.');
const overlap = synthesize('overlap-calculator', 'I am still here and thinking about the next step. Keep the calculator small and focused. You can finish explaining what Claude has done while I take a moment to think.');
const test = await startTestHarness('correction', { maxSeconds: 240 });
fs.writeFileSync(path.join(test.cwd, 'slow-build.mjs'), 'import fs from "node:fs"; fs.writeFileSync("slow-build-started.json", JSON.stringify({at:Date.now()})); console.log("slow build started"); await new Promise(resolve => setTimeout(resolve, 25000)); fs.writeFileSync("slow-build-ended.json", JSON.stringify({at:Date.now()})); console.log("slow build finished");\n');
let voice;
const readEvents = () => fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
try {
  voice = await connectTestVoice(test.harness);
  await delay(12000);
  await voice.speak(build);
  await until(() => fs.existsSync(path.join(test.cwd, 'slow-build-started.json')), { label: 'foreground slow build', timeout: 45000 });
  await voice.speak(correction);
  await until(() => test.harness.outbox.size >= 2, { label: 'Live delegated the correction', timeout: 20000 });
  const tasks = [...test.harness.outbox.values()];
  const bashStart = JSON.parse(fs.readFileSync(path.join(test.cwd, 'slow-build-started.json'), 'utf8')).at;
  const correctionTask = tasks[1];
  const bashEnd = fs.existsSync(path.join(test.cwd, 'slow-build-ended.json')) ? JSON.parse(fs.readFileSync(path.join(test.cwd, 'slow-build-ended.json'), 'utf8')).at : null;
  assert.ok(!bashEnd || correctionTask.queuedAt < bashEnd, 'correction queued while Claude was still executing a tool');
  assert.ok(correctionTask.queuedAt > bashStart);
  const reportAt = await until(() => {
    const files = fs.readdirSync(test.cwd);
    if (!files.some(f => /calculator|add|sum/.test(f) && !f.includes('test'))) return false;
    return readEvents().filter(e => e.type === 'agent.text' && e.at > correctionTask.queuedAt).at(-1)?.at;
  }, { timeout: 80000, label: 'Claude coding report' });
  await voice.speak(overlap);
  // Completion is observed in the terminal; verify the actual artifact below.
  await until(() => test.harness.observer.state === 'idle', { label: 'Claude idle after corrected build' });
  const module = fs.readdirSync(test.cwd).find(f => /\.(m?js)$/.test(f) && !/test|slow-build/.test(f));
  assert.ok(module, 'calculator module exists');
  const check = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import { add } from ${JSON.stringify('./' + module)}; assert.equal(add(2,3),5); assert.equal(add('2','3'),5); assert.equal(add('2',3),5); assert.throws(()=>add('bad',3),TypeError);`], { cwd: test.cwd, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const testFiles = fs.readdirSync(test.cwd).filter(f => /test/.test(f)); assert.ok(testFiles.length);
  const events = readEvents();
  const intervals = [];
  for (const e of events) {
    if (e.type === 'test.audio_started') intervals.push({ start: e.at });
    if (e.type === 'test.audio_ended') intervals.at(-1).end = e.at;
  }
  const concurrentText = events.filter(e => e.type === 'agent.text' && intervals.some(i => e.at >= i.start && e.at <= i.end));
  assert.ok(concurrentText.length > 0, 'agent display deltas arrived while operator audio was playing');
  await delay(5000);
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify({ passed: true, headedClaude: true, actualCodeAndTests: true, numericStrings: true, invalidInputRejected: true, correctionQueuedDuringTool: true, correctionTask, bashStart, reportAt, speechAndAgentTextOverlap: concurrentText.length, intervals, module, testFiles }, null, 2));
  console.log('\nCORRECTION PASSED; simultaneous speech/text events:', concurrentText.length);
} finally { if (voice) await voice.close(); await test.close(); }
