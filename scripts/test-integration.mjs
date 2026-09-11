import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.mjs';

const request = synthesize('create-file', 'Please ask Claude to create a file named hello dot text containing the words voice bridge works. Then read it back and tell me when it is done.');
const status = synthesize('cached-status', 'What did Claude just finish?');
const test = await startTestHarness('integration', { maxSeconds: 150 });
let voice;
try {
  // Verify the actual headed channel before spending on voice.
  test.harness.deliver({ id: 'startup-check', content: 'Verify the voice bridge by calling acknowledge with message_id startup-check, then reply with status completed and text READY. Do not inspect or change files. Wait for the next voice request.' });
  await until(() => test.harness.outbox.get('startup-check')?.state === 'completed', { label: 'Claude channel acknowledgment and reply' });
  await until(() => test.harness.observer.state === 'idle', { label: 'Claude idle' });
  voice = await connectTestVoice(test.harness);
  await until(() => voice.events.filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('').length > 60, { label: 'audible greeting transcript' });
  await delay(5000);
  await voice.speak(request);
  await until(() => [...test.harness.outbox.values()].some(t => t.id !== 'startup-check' && t.state === 'completed'), { timeout: 65000, label: 'voice request completed by Claude' });
  const files = fs.readdirSync(test.cwd).filter(f => f.startsWith('hello'));
  assert.ok(files.length, 'Claude created the spoken filename');
  assert.match(fs.readFileSync(path.join(test.cwd, files[0]), 'utf8'), /voice bridge works/i);
  await until(() => test.harness.observer.state === 'idle', { label: 'Claude finished' });
  await delay(10000);
  const before = test.harness.outbox.size;
  const start = voice.events.length;
  await voice.speak(status);
  await delay(15000);
  assert.equal(test.harness.outbox.size, before, 'cached status did not cause another Claude request');
  const answer = voice.events.slice(start).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
  assert.match(answer, /file|hello|voice bridge/i, 'mediator answered from the agent result');
  fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify({ passed: true, headedClaude: true, greeting: true, voiceDelegation: true, fileCreated: files[0], cachedStatusNoDelegation: true, cachedAnswer: answer }, null, 2));
  console.log('\nINTEGRATION PASSED');
} finally { if (voice) await voice.close(); await test.close(); }
