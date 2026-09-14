import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.mjs';

const portQuestion = synthesize('hook-port', 'What support port did Claude read from the settings file?');
const resultQuestion = synthesize('hook-result', 'What release name did Claude change the settings to, and how many records did the check command report?');
const newWork = synthesize('hook-new-work', 'Ask Claude to create a file named ready dot text containing the word ready.');
const test = await startTestHarness('hook-context', { maxSeconds: 180 });
fs.writeFileSync(path.join(test.cwd, 'settings.json'), JSON.stringify({ release: 'COPPER', supportPort: 4317 }, null, 2));
fs.writeFileSync(path.join(test.cwd, 'check.mjs'), 'console.log("Records checked: 731");\n');
let voice;
const evidence = { passed: false, answers: [] };
async function typed(prompt) {
  const start = test.harness.uiEvents.length;
  test.terminal.write(prompt); await delay(250); test.terminal.write('\r');
  await until(() => test.harness.uiEvents.slice(start).some(e => e.type === 'agent_input'), { label: 'terminal input' });
  await until(() => test.harness.uiEvents.slice(start).some(e => e.type === 'agent_text'), { label: 'ordinary terminal answer' });
  await until(() => test.harness.observer.state === 'idle', { label: 'terminal Stop hook' });
  await delay(700);
}
async function ask(fixture, patterns) {
  const start = voice.events.length; const before = test.harness.outbox.size;
  await voice.speak(fixture);
  const answer = () => voice.events.slice(start).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
  await until(() => patterns.every(pattern => pattern.test(answer())), { timeout: 25000, label: 'answer from tool hooks' });
  await delay(3000);
  assert.equal(test.harness.outbox.size, before, 'tool recall must not create another Claude request');
  evidence.answers.push({ question: fixture.text, answer: answer(), extraDelegations: 0 });
}
try {
  await typed('Use Read to read settings.json. Do not quote any of its contents in your text response. Respond with only DONE.');
  voice = await connectTestVoice(test.harness);
  await until(() => voice.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting' });
  await delay(4000);
  await ask(portQuestion, [/4317|four[ -]three[ -]one[ -]seven|four thousand three hundred (?:and )?seventeen|forty[ -]three[ ,]+seventeen/i]);
  await typed('Use Edit to replace COPPER with LANTERN in settings.json. Then use Bash to run node check.mjs. Do not quote the file contents or command result in your text response. Respond with only DONE.');
  await delay(3000);
  await ask(resultQuestion, [/lantern/i, /731|seven hundred (?:and )?thirty[ -]one/i]);
  const before = test.harness.outbox.size;
  await voice.speak(newWork);
  await until(() => fs.existsSync(path.join(test.cwd, 'ready.txt')), { timeout: 45000, label: 'one-way voice channel file creation' });
  await until(() => test.harness.observer.state === 'idle', { label: 'Claude completed voice request' });
  assert.match(fs.readFileSync(path.join(test.cwd, 'ready.txt'), 'utf8'), /ready/i);
  assert.equal(test.harness.outbox.size, before + 1);
  assert.ok([...test.harness.outbox.values()].every(e => e.state === 'sent'));
  const events = fs.readFileSync(path.join(test.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'agent.hook' && e.hook_event_name === 'PostToolUse' && e.tool_response));
  assert.ok(!events.some(e => /mcp__voice__/.test(e.tool_name ?? '')));
  assert.ok(!events.some(e => e.type === 'error' || e.type === 'bridge.fault'));
  const requestItem = test.harness.timeline.snapshot().items.find(i => i.requestId);
  assert.equal(requestItem.contentMatches, true, 'full UI message equals the prompt actually received by Claude');
  assert.equal(requestItem.notification.params.content, requestItem.text);
  evidence.requestVerified = true; evidence.request = requestItem;
  evidence.speechCues = events.filter(e => e.type === 'bridge.speech_cue');
  assert.ok(!events.some(e => e.type === 'session.commentary.append' && /Claude Code observation/.test(e.content)), 'raw hooks are never speech instructions');
  evidence.passed = true; evidence.voiceWork = true; evidence.noReplyTools = true;
  console.log('\nHOOK CONTEXT PASSED');
} catch (error) { evidence.error = error.message; throw error; }
finally {
  if (voice) await voice.close();
  evidence.usageSeconds = test.harness.live?.usageSeconds ?? 0;
  evidence.estimatedUsd = evidence.usageSeconds * 0.05 / 60;
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  await test.close();
}
