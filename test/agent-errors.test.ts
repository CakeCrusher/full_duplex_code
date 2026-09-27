import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorTail, failureNotice, loud } from '../src/launcher/agent-errors.ts';

test('the agent\'s latest error output is kept byte for byte, within a limit', () => {
  const tail = new ErrorTail(10);
  tail.push(Buffer.from('first line\n')); tail.push(Buffer.from('Error: \x1b[31mno\x1b[0m\n'));
  assert.equal(tail.output.toString(), 'Error: \x1b[31mno\x1b[0m\n', 'older chunks give way; the latest stays whole');
  const small = new ErrorTail(); small.push(Buffer.from('a')); small.push(Buffer.from('b'));
  assert.equal(small.output.toString(), 'ab');
});

test('only an agent that fails is reported, with its own words when it wrote any', () => {
  const error = Buffer.from('Error: Permission overrides are not supported when resuming a remote task.\n');
  assert.equal(failureNotice('Codex', 0, null, error), undefined);
  assert.equal(failureNotice('Codex', 1, null, error), 'fdc: Codex exited with code 1. Its error output, unchanged:');
  assert.equal(failureNotice('Claude', 1, null, Buffer.from(' \n')), 'fdc: Claude exited with code 1. It wrote nothing to stderr; any message it showed is above.');
  assert.equal(failureNotice('Codex', null, 'SIGSEGV', Buffer.alloc(0)), 'fdc: Codex ended by SIGSEGV. It wrote nothing to stderr; any message it showed is above.');
  assert.equal(loud('fdc: x', true), '\x1b[1;31mfdc: x\x1b[0m'); assert.equal(loud('fdc: x', false), 'fdc: x');
});
