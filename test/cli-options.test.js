import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchArgs } from '../src/cli-options.js';
import { claudeArgs } from '../src/agent.js';

const sessionId = '843498c7-51fb-4a69-a47c-9a8d8c5a1b3c';
const config = { mcpFile: '/run/mcp.json', settingsFile: '/run/settings.json' };

test('permission bypass is opt-in and reaches Claude after the companion configuration', () => {
  assert.deepEqual(parseLaunchArgs([]).extraArgs, []);
  const { values, extraArgs } = parseLaunchArgs(['--cwd', '/my project', '--dangerously-skip-permissions', '--no-open']);
  assert.equal(values.cwd, '/my project'); assert.equal(values['no-open'], true);
  const args = claudeArgs({ config, sessionId, extraArgs });
  assert.equal(args.at(-1), '--dangerously-skip-permissions');
  assert.ok(args.includes(config.mcpFile)); assert.ok(args.includes(config.settingsFile));
  assert.ok(args.includes('server:voice')); assert.ok(args.includes(sessionId));
});

test('Claude options, repeated overrides, short flags and quoted values keep their exact order', () => {
  const extraArgs = ['--model=sonnet', '--model', 'opus', '--permission-mode', 'plan',
    '--settings', '{"permissions":{"defaultMode":"plan"}}', '-d', 'api,hooks',
    '--allowedTools', 'Read', 'Bash(git *)', '--append-system-prompt', 'Keep $(this) and `that` literal'];
  const parsed = parseLaunchArgs(['--voice=marin', ...extraArgs, '--max-minutes', '10']);
  assert.equal(parsed.values['max-minutes'], '10'); assert.deepEqual(parsed.extraArgs, extraArgs);
  assert.deepEqual(claudeArgs({ config, sessionId, extraArgs: parsed.extraArgs }).slice(-extraArgs.length), extraArgs);
});

test('an initial prompt cannot be swallowed by the generated variadic allowed-tools flag', () => {
  const prompt = 'Explain this project';
  const { extraArgs } = parseLaunchArgs([prompt]);
  assert.deepEqual(extraArgs, [prompt]);
  for (const resume of [false, true]) {
    const args = claudeArgs({ config, sessionId, resume, extraArgs });
    assert.deepEqual(args.slice(-3), [resume ? '--resume' : '--session-id', sessionId, prompt]);
  }
});

test('resuming with Claude flags keeps the companion on the selected session', () => {
  const { values, extraArgs } = parseLaunchArgs(['--resume', sessionId, '--dangerously-skip-permissions']);
  const args = claudeArgs({ config, sessionId: values.resume, resume: Boolean(values.resume), extraArgs });
  assert.deepEqual(args.slice(-3), ['--resume', sessionId, '--dangerously-skip-permissions']);
  assert.ok(!args.includes('--session-id'));
  assert.equal(parseLaunchArgs([`--session-id=${sessionId}`]).values['session-id'], sessionId);
  assert.throws(() => parseLaunchArgs(['--session-id', sessionId, '--resume', sessionId]), /either/);
});

test('an extra separator passes names that collide with companion options to Claude', () => {
  const parsed = parseLaunchArgs(['--cwd=/project', '--', '--help', '--voice', 'some-value']);
  assert.equal(parsed.values.cwd, '/project'); assert.equal(parsed.values.help, undefined);
  assert.equal(parsed.values.voice, 'marin');
  assert.deepEqual(parsed.extraArgs, ['--help', '--voice', 'some-value']);
  assert.deepEqual(parseLaunchArgs(['--', '--', '--no-open']).extraArgs, ['--', '--no-open']);
  assert.deepEqual(parseLaunchArgs(['--append-system-prompt=--voice']).extraArgs, ['--append-system-prompt=--voice']);
});

test('launcher subcommands are not inferred from Claude flag values or escaped prompts', () => {
  assert.equal(parseLaunchArgs(['usage']).command, 'usage');
  assert.equal(parseLaunchArgs(['doctor']).command, 'doctor');
  assert.equal(parseLaunchArgs(['--model', 'usage']).command, undefined);
  assert.equal(parseLaunchArgs(['--', 'doctor']).command, undefined);
  assert.deepEqual(parseLaunchArgs(['--', 'doctor']).extraArgs, ['doctor']);
});

test('companion options still validate values and keep last-value-wins behavior', () => {
  assert.equal(parseLaunchArgs([], '/default/project').values.cwd, '/default/project');
  assert.equal(parseLaunchArgs(['--port', '8123', '--port=9000']).values.port, '9000');
  assert.equal(parseLaunchArgs(['-h']).values.help, true);
  assert.throws(() => parseLaunchArgs(['--cwd']), /argument/i);
  assert.throws(() => parseLaunchArgs(['--voice', '--model', 'opus']), /ambiguous|argument/i);
  assert.throws(() => parseLaunchArgs(['--no-open=false']), /argument/i);
});
