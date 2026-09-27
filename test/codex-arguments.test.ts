import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexArgs } from '../src/adapters/codex/arguments.ts';
import { codexArgs, TOKEN_VARIABLE } from '../src/adapters/codex/launch.ts';
import { hookFlags, CODEX_HOOKS } from '../src/adapters/codex/app-server.ts';
import { codex } from '../src/adapters/codex/index.ts';

const fresh = { direct: false, resume: false, sessionId: undefined, assignSession: false };

test('Codex chooses its own session IDs; resume and fork continue a conversation', () => {
  assert.deepEqual(readCodexArgs([]), fresh);
  assert.deepEqual(readCodexArgs(['--model', 'gpt-5.5', '--search', 'Explain this project']), fresh);
  assert.deepEqual(readCodexArgs(['resume', '01a0db98-2fd6-7043-b850-762a6812499e']), { ...fresh, resume: true });
  assert.deepEqual(readCodexArgs(['resume', '--last']), { ...fresh, resume: true });
  assert.deepEqual(readCodexArgs(['fork', '--last']), { ...fresh, resume: true });
  assert.equal(codex.readArgs, readCodexArgs);
});

test('help, version and non-session subcommands run Codex without the companion', () => {
  for (const args of [['--help'], ['-h'], ['--version'], ['-V'], ['login'], ['mcp', 'list'], ['update'], ['doctor'], ['queue', '--thread', 'x', '--message', 'y'], ['--model', 'o3', '--help']]) {
    assert.equal(readCodexArgs(args).direct, true, args.join(' '));
  }
  assert.equal(readCodexArgs(['explain the doctor command']).direct, false);
});

test('options that would hide Codex from the companion are refused with the reason', () => {
  const reasons: [string[], RegExp][] = [
    [['exec', 'fix it'], /without the interactive terminal/], [['e', 'fix it'], /without the interactive terminal/], [['review'], /without the interactive terminal/],
    [['--remote', 'ws://127.0.0.1:9'], /another app server/], [['--remote-auth-token-env', 'X'], /another app server/],
    [['--disable', 'hooks'], /hooks off/], [['--disable', 'codex_hooks'], /hooks off/], [['-c', 'features.hooks=false'], /hooks off/], [['--config=features.hooks=false'], /hooks off/],
    [['resume', '--last', '--remote', 'ws://x'], /another app server/],
  ];
  for (const [args, reason] of reasons) assert.throws(() => readCodexArgs(args), reason, args.join(' '));
});

test('option values and prompts are never mistaken for options', () => {
  assert.deepEqual(readCodexArgs(['-m', '--remote']), fresh);
  assert.deepEqual(readCodexArgs(['-c', 'hooks.Stop=[]', '--disable', 'web_search']), fresh);
  assert.deepEqual(readCodexArgs(['--', '--remote x']), fresh);
  assert.deepEqual(readCodexArgs(['-i', 'a.png', 'b.png', '--search']), fresh);
});

test('the terminal attaches to the companion\'s app server; the operator\'s arguments follow unchanged', () => {
  const url = 'ws://127.0.0.1:4567', ours = ['--remote', url, '--remote-auth-token-env', TOKEN_VARIABLE];
  assert.deepEqual(codexArgs(url, ['--model', 'gpt-5.5', 'Build it']), [...ours, '--model', 'gpt-5.5', 'Build it']);
  assert.deepEqual(codexArgs(url, ['resume', '--last', 'continue']), ['resume', ...ours, '--last', 'continue']);
  assert.deepEqual(codexArgs(url, ['fork', 'abc']), ['fork', ...ours, 'abc']);
});

test('every Codex hook is configured as a session flag running the relay', () => {
  const command = "'/usr/bin/node' '--import' 'data:x' '/repo/src/core/hook-relay.ts' 'http://127.0.0.1:1/hook'";
  const flags = hookFlags(command);
  assert.equal(flags.length, CODEX_HOOKS.length * 2);
  assert.equal(CODEX_HOOKS.length, 12);
  for (let i = 0; i < flags.length; i += 2) assert.equal(flags[i], '-c');
  const tool = flags.find(f => f.startsWith('hooks.PreToolUse='))!;
  assert.equal(tool, `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
  assert.ok(flags.find(f => f.startsWith('hooks.Stop='))!.startsWith('hooks.Stop=[{hooks=['), 'events without a tool name have no matcher');
});
