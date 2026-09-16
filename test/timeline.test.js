import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../src/timeline.js';

test('microphone and playback activity can overlap; silence and mute do not become speech bars', () => {
  const timeline = new Timeline(0);
  timeline.add({ type: 'audio_level', at: 100, durationMs: 100, inputRms: .1, outputRms: 0 });
  timeline.add({ type: 'audio_level', at: 200, durationMs: 100, inputRms: .2, outputRms: .15 });
  timeline.add({ type: 'audio_level', at: 500, durationMs: 100, inputRms: 0, outputRms: .15 });
  timeline.add({ type: 'audio_stopped', at: 600 });
  const items = timeline.snapshot().items;
  const operator = items.filter(i => i.track === 'operator'); const speech = items.filter(i => i.track === 'speech');
  assert.equal(operator.length, 1); assert.equal(speech.length, 1);
  assert.deepEqual([operator[0].start, operator[0].end], [0, 200]);
  assert.deepEqual([speech[0].start, speech[0].end], [100, 500]);
  assert.equal(operator[0].active, false); assert.equal(speech[0].active, false);
});

test('gated microphone bars include quiet word tails and exclude silenced background noise', () => {
  const timeline = new Timeline(0);
  timeline.add({ type: 'audio_level', at: 100, durationMs: 100, inputRms: .001, rawInputRms: .001, gateThreshold: .008, outputRms: 0 });
  timeline.add({ type: 'audio_level', at: 400, durationMs: 100, inputRms: 0, rawInputRms: .001, gateThreshold: .008, outputRms: 0 });
  const items = timeline.snapshot().items;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].start, items[0].end, items[0].active], [0, 100, false]);
});

test('transcripts use audio timestamps rather than network receipt time and stay separate across restarts', () => {
  const timeline = new Timeline(1000);
  const event = { type: 'caption', voiceSessionId: 'one', voiceStartedAt: 1000, startMs: 100, endMs: 300, at: 2000, role: 'operator', text: 'Hello' };
  timeline.add(event);
  timeline.add({ ...event, startMs: 300, endMs: 500, text: ' there' });
  timeline.add({ ...event, role: 'intermediary', text: 'Hi' });
  timeline.add({ ...event, voiceSessionId: 'two', voiceStartedAt: 10000, text: 'Again' });
  const items = timeline.snapshot().items;
  assert.equal(items.length, 3);
  assert.deepEqual([items[0].start, items[0].end, items[0].text], [1100, 1500, 'Hello there']);
  assert.equal(items[1].role, 'intermediary'); assert.equal(items[2].start, 10100);
});

test('a voice delivery and matching prompt hook update one request without inventing execution duration', () => {
  const timeline = new Timeline(0);
  timeline.add({ type: 'task', id: 'voice-one', queuedAt: 100, at: 100, state: 'queued', text: 'Build a clock' });
  timeline.add({ type: 'task', id: 'voice-one', queuedAt: 100, at: 200, state: 'sent', text: 'Build a clock' });
  timeline.add({ type: 'agent_input', at: 300, text: '<channel source="voice" message_id="voice-one">Build a clock</channel>' });
  timeline.add({ type: 'task', id: 'voice-one', at: 350, state: 'sent' });
  const item = timeline.snapshot().items[0];
  assert.equal(timeline.items.size, 1); assert.equal(item.state, 'observed'); assert.equal(item.end, 300);
  timeline.add({ type: 'agent_input', at: 400, text: 'A typed request' });
  assert.equal(timeline.items.size, 2);
});

test('every Claude observation is visible once; derived assistant text does not duplicate hooks', () => {
  const timeline = new Timeline(0);
  for (let i = 0; i < 650; i++) timeline.add({ type: 'agent_observation', at: i, name: i % 2 ? 'MessageDisplay' : 'PostToolUse', text: `Hook ${i}` });
  timeline.add({ type: 'agent_text', at: 651, text: 'Already represented by its observation' });
  const items = timeline.snapshot().items;
  assert.equal(items.length, 650);
  assert.equal(items[0].text, 'Hook 0');
  assert.ok(items.every(item => item.start === item.end && item.track === 'claude'));
  assert.equal(items[0].label, 'PostToolUse'); assert.equal(items[1].label, 'MessageDisplay');
});

test('context delivery shows the exact append and independently acknowledges out-of-order writes', () => {
  const timeline = new Timeline(0);
  const notification = { type: 'session.thinking.append', event_id: 'one', content: 'Full raw observation' };
  timeline.add({ type: 'context_sent', at: 100, id: 'one', kind: 'thinking', text: notification.content, notification });
  timeline.add({ type: 'context_sent', at: 105, id: 'two', kind: 'commentary', text: 'Welcome' });
  timeline.add({ type: 'context_ack', at: 140, id: 'two', startMs: 0, endMs: 100 });
  timeline.add({ type: 'context_ack', at: 180, id: 'one', startMs: 100, endMs: 300 });
  const [one,two] = timeline.snapshot().items;
  assert.deepEqual(one.notification, notification); assert.equal(one.end,180); assert.equal(two.end,140);
  assert.equal(one.state,'acknowledged'); assert.equal(one.injectionEndMs,300); assert.equal(two.kind,'commentary');
});


test('request inspection preserves the full wire content and exposes observed mismatches', () => {
  const timeline = new Timeline(0);
  const text = 'User request:\n世界 “blue”\n\nEarlier conversation:\nYes.\n';
  timeline.add({ type: 'task', id: 'one', text, notification: { params: { content: text } }, state: 'sent', at: 100 });
  const prompt = `<channel message_id="one" source="voice">\n${text}\n</channel>`;
  timeline.add({ type: 'agent_input', text: prompt, at: 200 });
  const item = timeline.snapshot().items[0];
  assert.equal(item.text, text); assert.equal(item.observedPrompt, prompt);
  assert.equal(item.observedContent, text); assert.equal(item.contentMatches, true);
  timeline.add({ type: 'agent_input', text: prompt.replace('blue', 'red'), at: 300 });
  assert.equal(item.contentMatches, false);
  assert.equal(item.text, text, 'the inspector must not rewrite sent content to conceal a mismatch');
});
