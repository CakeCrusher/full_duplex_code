import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmStart } from '../src/launch-prompt.js';

const streams = () => ({ input: new PassThrough(), output: new PassThrough() });

test('Enter starts Claude', async () => {
  const io = streams(), answer = confirmStart(io);
  io.input.write('\n');
  assert.equal(await answer, true);
});

test('closing the input quits instead of starting Claude', async () => {
  const io = streams(), answer = confirmStart(io);
  io.input.end();
  assert.equal(await answer, false);
});

test('the prompt says the links will be hidden once Claude starts', async () => {
  const io = streams(); let text = '';
  io.output.on('data', chunk => { text += chunk; });
  const answer = confirmStart(io); io.input.write('\n'); await answer;
  assert.match(text, /Press Enter to start Claude Code, or Ctrl-C to quit/);
  assert.match(text, /hidden until you exit/);
});
