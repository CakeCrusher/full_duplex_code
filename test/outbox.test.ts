import test from 'node:test';
import assert from 'node:assert/strict';
import { Outbox } from '../src/core/outbox.ts';
import { voiceRequest } from '../src/core/prompts.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const request = (words: string) => voiceRequest([{ role: 'operator', text: words }]);

test("a request that can wait is held until the agent's turn ends; one that can't wait brings those held with it, before it", async () => {
  let working = true;
  const delivered: { id: string; content: string }[] = [], held: string[] = [], sent: string[] = [], states: string[] = [];
  const outbox = new Outbox({ agent: { wire: entry => entry.content }, ready: () => true, working: () => working, clean: String, log: () => {},
    adapter: () => ({ deliver: async (entry: any) => { delivered.push({ id: entry.id, content: entry.content }); return { state: 'sent' }; } }) as any,
    publish: event => states.push(`${event.id}:${event.state}`), fault: error => { throw error; }, onSent: entry => sent.push(entry.id), onHeld: entry => held.push(entry.id) });
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
  // Held again, and then words that can't wait: both go at once, in the order the operator said them.
  working = true;
  outbox.add({ id: 'title', content: request('And a title.'), followUp: true });
  outbox.add({ id: 'stop', content: request('Stop, that is the wrong file.') });
  await settle();
  assert.deepEqual(delivered.slice(1).map(d => d.id), ['title', 'stop']);
  assert.match(delivered[1].content, /The user said this a moment ago; the voice tool was holding it until your turn ended, and delivers it now because what they said next can't wait: that is the request that follows this one\.\n\nuser: And a title\.$/);
  assert.doesNotMatch(delivered[2].content, /holding|held/);
  // Between turns, or for an agent whose turn fdc can't tell, nothing is held.
  working = false;
  outbox.add({ id: 'next', content: request('Next, the footer.'), followUp: true });
  await settle();
  assert.equal(outbox.get('next')!.state, 'sent');
  assert.doesNotMatch(delivered[3].content, /holding|held/);
});
