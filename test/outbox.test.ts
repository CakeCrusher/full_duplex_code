import test from 'node:test';
import assert from 'node:assert/strict';
import { Outbox, requestIds } from '../src/core/outbox.ts';
import { recordRequest, voiceRequest } from '../src/core/prompts.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const request = (words: string) => voiceRequest([{ role: 'operator', text: words }]);

test("a request that can wait is held until the agent's turn ends; words that can't wait take it along, as one request", async () => {
  let working = true;
  const delivered: { id: string; content: string }[] = [], held: string[] = [], sent: string[] = [], states: string[] = [];
  const outbox = new Outbox({ agent: { wire: entry => entry.content }, ready: () => true, working: () => working, clean: String, log: () => {},
    adapter: () => ({ deliver: async (entry: any) => { delivered.push({ id: entry.id, content: entry.content }); return { state: 'sent' }; } }) as any,
    publish: event => states.push(`${event.id}:${event.state}`), fault: error => { throw error; }, onSent: entry => sent.push(...requestIds(entry)), onHeld: entry => held.push(entry.said ?? entry.id) });
  outbox.add({ id: 'legend', content: request('Add a legend when you are done.'), followUp: true });
  await settle();
  assert.equal(outbox.get('legend')!.state, 'held');
  assert.deepEqual([delivered, held, sent], [[], ['legend'], []], 'the agent goes on undisturbed, and the voice hears it is held');
  // The agent's turn ends: it goes then, saying why it comes when it does.
  working = false; outbox.releaseHeld();
  await settle();
  assert.equal(outbox.get('legend')!.state, 'sent');
  assert.match(delivered[0].content, /Earlier speech went with earlier voice requests\. The user said this a moment ago, while you were working; the voice tool judged that it could wait and held it until your turn ended\.\n\nuser: Add a legend when you are done\.$/);
  assert.deepEqual(states, ['legend:held', 'legend:queued', 'legend:dispatching', 'legend:sent']);
  // Held again, and then words that can't wait: one request, at once, in the order the operator said them.
  working = true;
  outbox.add({ id: 'title', content: request('And a title.'), followUp: true });
  outbox.add({ id: 'stop', content: request('Stop, that is the wrong file.') });
  await settle();
  assert.deepEqual(delivered.slice(1).map(d => d.id), ['title'], 'one message, under the waiting request');
  assert.match(delivered[1].content, /The user said the first of this a moment ago; the voice tool was holding it until your turn ended, and delivers all of it now because what they said last can't wait\.\n\nuser: And a title\.\nuser: Stop, that is the wrong file\.$/);
  assert.deepEqual([outbox.get('stop'), outbox.has('stop'), sent.slice(-2)], [outbox.get('title'), true, ['title', 'stop']], 'the request that joined answers to the one it joined, and both are confirmed');
  // Between turns, or for an agent whose turn fdc can't tell, nothing is held.
  working = false;
  outbox.add({ id: 'next', content: request('Next, the footer.'), followUp: true });
  await settle();
  assert.equal(outbox.get('next')!.state, 'sent');
  assert.doesNotMatch(delivered[2].content, /holding|held/);
});

test('one request at most waits for a session: a later one joins it, and each moment fdc decided to send is kept', async () => {
  let working = true, ready = true;
  const delivered: { id: string; content: string }[] = [], held: (string | undefined)[] = [], events: any[] = [], logged: any[] = [], uncertain: string[][] = [];
  const outbox = new Outbox({ agent: { wire: entry => entry.content }, ready: () => ready, working: entry => entry.target !== 'fork' && working, clean: String, log: event => logged.push(event),
    adapter: () => ({ deliver: async (entry: any) => { delivered.push({ id: entry.id, content: entry.content }); return { state: 'sent' }; } }) as any,
    publish: event => events.push(event), fault: () => {}, onSent: () => {}, onHeld: entry => held.push(entry.said), onUncertain: entry => uncertain.push(requestIds(entry)) });
  const record = (lines: string, notes: string[] = []) => recordRequest(lines, notes);
  outbox.add({ id: 'a', content: record('user: Add a legend when you are done.'), said: 'Add a legend when you are done.', followUp: true, target: 'main' });
  outbox.add({ id: 'b', content: record('voice assistant: Will do.\nuser: And a title too.', ['The user was looking at the chart.']), said: 'And a title too.', followUp: true, target: 'main', voiceSessionId: 'live-2' });
  await settle();
  const entry = outbox.get('a')!;
  assert.deepEqual([outbox.size, entry.state, outbox.get('b'), entry.joined!.map(j => j.id), entry.said, entry.voiceSessionId], [1, 'held', entry, ['b'], 'Add a legend when you are done. And a title too.', 'live-2']);
  assert.deepEqual(held, ['Add a legend when you are done.', 'And a title too.'], 'the voice hears each part is held');
  assert.equal(logged.filter(e => e.type === 'task.joined').length, 1);
  assert.deepEqual(events.at(-1).joined.map((j: any) => j.id), ['b'], 'the page is told when more joined it');
  // A question for the fork meanwhile is the fork's own: the main session's request goes on waiting for its turn's end.
  outbox.add({ id: 'aside', content: record('user: What does that flag do?'), target: 'fork' });
  await settle();
  assert.deepEqual([delivered.map(d => d.id), outbox.get('a')!.state], [['aside'], 'held']);
  working = false; outbox.releaseHeld();
  await settle();
  assert.equal(delivered.length, 2);
  assert.match(delivered[1].content, /what lies between went to the fork\. The user was looking at the chart\. The user said this while you were working, the first of it a moment ago; the voice tool judged that it could wait and held it until your turn ended\.\n\nuser: Add a legend when you are done\.\nvoice assistant: Will do\.\nuser: And a title too\.$/);
  // A session that isn't connected yet: what is said meanwhile is one request when it is.
  ready = false;
  outbox.add({ id: 'c', content: record('user: First this.'), target: 'main' });
  outbox.add({ id: 'd', content: record('user: Then that.'), target: 'main' });
  assert.deepEqual([outbox.get('c')!.state, outbox.get('d')], ['queued', outbox.get('c')]);
  // Its delivery uncertain, every request in it is taken back.
  outbox.settle(outbox.get('c')!, { state: 'uncertain', error: new Error('lost') });
  assert.deepEqual(uncertain, [['c', 'd']]);
});
