import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeArgs } from '../src/adapters/claude/arguments.ts';
import { claude } from '../src/adapters/claude/index.ts';

const id = '843498c7-51fb-4a69-a47c-9a8d8c5a1b3c';
const fresh = { direct: false, resume: false, sessionId: undefined, assignSession: true };

test('a new conversation gets a session ID from the launcher', () => {
  assert.deepEqual(readClaudeArgs([]), fresh);
  assert.deepEqual(readClaudeArgs(['--model', 'opus', 'Explain this project']), fresh);
  assert.equal(claude.readArgs, readClaudeArgs);
});

test('Claude\'s own session options choose the session, and name it when they can', () => {
  for (const args of [['--session-id', id], [`--session-id=${id}`]]) assert.deepEqual(readClaudeArgs(args), { direct: false, resume: false, sessionId: id, assignSession: false });
  for (const args of [['--resume', id], ['-r', id], [`--resume=${id}`], ['--model', 'opus', '--resume', id, 'continue the fix']]) {
    assert.deepEqual(readClaudeArgs(args), { direct: false, resume: true, sessionId: id, assignSession: false }, args.join(' '));
  }
  // Claude picks these sessions itself; the first hook names them.
  for (const args of [['--resume'], ['--resume', 'login bug'], ['-c'], ['--continue'], ['--from-pr', '12'], ['--resume', id, '--fork-session'], ['--continue', '--fork-session']]) {
    assert.deepEqual(readClaudeArgs(args), { direct: false, resume: true, sessionId: undefined, assignSession: false }, args.join(' '));
  }
  assert.throws(() => readClaudeArgs(['--session-id', 'not-a-uuid']), /full session UUID/);
});

test('help, version and subcommands run Claude without the companion', () => {
  for (const args of [['--help'], ['-h'], ['--version'], ['-v'], ['mcp', 'list'], ['doctor'], ['update'], ['--model', 'opus', '--help']]) assert.equal(readClaudeArgs(args).direct, true, args.join(' '));
  assert.equal(readClaudeArgs(['explain the doctor command']).direct, false);
});

test('options that would hide Claude from the companion are refused with the reason', () => {
  const reasons: [string[], RegExp][] = [
    [['--bare'], /--bare skips hooks/], [['--safe-mode'], /--safe-mode turns off hooks/],
    [['--bg'], /background/], [['--background'], /background/], [['--cloud'], /cloud/], [['--environment', 'ccpool_x'], /cloud/],
    [['--tmux'], /tmux/], [['-p', 'Explain'], /answers once and exits/], [['--print'], /answers once and exits/],
    [['--settings', '{"model":"opus"}'], /keeps only the last --settings/], [['--settings={"model":"opus"}'], /keeps only the last --settings/],
  ];
  for (const [args, reason] of reasons) assert.throws(() => readClaudeArgs(args), reason, args.join(' '));
});

test('an MCP configuration or a channel of the operator\'s own may add servers but not replace the voice channel', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-claude-args-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mcp.json'); fs.writeFileSync(file, JSON.stringify({ mcpServers: { voice: { command: 'x' } } }));
  assert.doesNotThrow(() => readClaudeArgs(['--mcp-config', '{"mcpServers":{"docs":{"command":"x"}}}', '--strict-mcp-config']));
  assert.doesNotThrow(() => readClaudeArgs(['--dangerously-load-development-channels', 'server:docs']), 'a second channel loads beside the voice channel');
  assert.throws(() => readClaudeArgs(['--mcp-config', '{"mcpServers":{"voice":{"command":"x"}}}']), /named "voice"/);
  assert.throws(() => readClaudeArgs(['--mcp-config', path.join(dir, 'missing.json'), file]), /named "voice"/);
});

test('option values and prompts are never mistaken for options', () => {
  assert.deepEqual(readClaudeArgs(['--append-system-prompt', '--bare']), fresh);
  assert.deepEqual(readClaudeArgs(['--model', '--settings']), fresh);
  assert.deepEqual(readClaudeArgs(['--', '--bare --settings x']), fresh);
  assert.equal(readClaudeArgs(['--allowedTools', 'Read', 'Bash', '--resume', id]).sessionId, id);
  assert.equal(readClaudeArgs(['-d', 'api,hooks', '--session-id', id]).sessionId, id);
});
