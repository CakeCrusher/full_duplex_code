import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startTestHarness, synthesize, connectTestVoice, until, delay } from './test-support.mjs';

const questions = {
  beforeVoice: synthesize('terminal-before-voice', 'What project codename did I type into Claude before starting voice?'),
  duringVoice: synthesize('terminal-during-voice', 'What launch month did I just type to Claude, and what number did Claude reply with?'),
  restart: synthesize('terminal-restart', 'What is the latest project codename I typed into Claude?'),
  resume: synthesize('terminal-resume', 'What launch month and latest project codename are in our existing Claude conversation?'),
};
let test; let voice;
const evidence = { passed: false, scenarios: [], runDirs: [] };

async function typed(prompt, expectedReply) {
  const h = test.harness; const start = h.uiEvents.length;
  h.log({ type: 'test.terminal_input', text: prompt });
  test.terminal.write(prompt); await delay(250); test.terminal.write('\r');
  await until(() => h.uiEvents.slice(start).some(e => e.type === 'agent_input' && e.text.includes(prompt)), { label: 'real terminal prompt hook' });
  await until(() => expectedReply.test(h.uiEvents.slice(start).filter(e => e.type === 'agent_text').map(e => e.text).join('')), { label: 'real terminal reply' });
  await until(() => h.observer.state === 'idle', { label: 'terminal turn finished' });
  await delay(800);
}
async function openVoice() {
  voice = await connectTestVoice(test.harness);
  await until(() => voice.events.some(e => e.type === 'caption' && e.role === 'intermediary'), { label: 'voice greeting' });
  await delay(5000);
}
async function ask(name, expected) {
  const before = test.harness.outbox.size; const start = voice.events.length;
  await voice.speak(questions[name]);
  const answer = () => voice.events.slice(start).filter(e => e.type === 'caption' && e.role === 'intermediary').map(e => e.text).join('');
  await until(() => expected.every(pattern => pattern.test(answer())), { timeout: 25000, label: name + ' cached spoken answer' });
  await delay(5000);
  evidence.scenarios.push({ name, question: questions[name].text, answer: answer(), extraDelegations: test.harness.outbox.size - before });
  assert.equal(test.harness.outbox.size, before, 'cached terminal context must not cause another Claude request');
}
async function endVoice(label) {
  await voice.close(); voice = null;
  for (const name of ['voice-events.json', 'output.pcm', 'output.wav']) fs.renameSync(path.join(test.runDir, name), path.join(test.runDir, `${label}-${name}`));
  await until(() => !test.harness.browser, { label: 'voice socket closed' });
}

try {
  test = await startTestHarness('terminal-context', { maxSeconds: 180 }); evidence.runDirs.push(test.runDir);
  // The answer to this question appears only in the terminal input, not Claude's reply.
  await typed('Remember that our project codename is ORCHID. Respond to this message with the single word ACKNOWLEDGED.', /^ACKNOWLEDGED\s*$/);
  await openVoice();
  await ask('beforeVoice', [/orchid/i]);
  await typed('The launch month is November. Respond to this message with only the result of 23 times 19.', /^437\s*$/);
  await delay(4000);
  await ask('duringVoice', [/november/i, /437|four hundred (?:and )?thirty[- ]seven/i]);
  await endVoice('first');

  await typed('Update our project codename to TULIP. Respond to this message with the single word NOTED.', /^NOTED\s*$/);
  await openVoice();
  await ask('restart', [/tulip/i]);
  await endVoice('restart');
  const sessionId = test.harness.sessionId; const cwd = test.cwd;
  await test.close(); test = null;

  test = await startTestHarness('terminal-context-resume', { sessionId, cwd, resume: true, maxSeconds: 90 }); evidence.runDirs.push(test.runDir);
  assert.match(test.harness.observer.conversationContext(), /November/);
  assert.match(test.harness.observer.conversationContext(), /TULIP/);
  await openVoice();
  await ask('resume', [/november/i, /tulip/i]);
  await endVoice('resume');
  assert.equal(test.harness.outbox.size, 0);
  evidence.passed = true;
  console.log('\nTERMINAL CONTEXT PASSED\n' + JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = error.message; throw error;
} finally {
  if (voice) await voice.close();
  if (test) {
    await test.close();
    fs.writeFileSync(path.join(test.runDir, 'assertions.json'), JSON.stringify(evidence, null, 2));
  }
}
