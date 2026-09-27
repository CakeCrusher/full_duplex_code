import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchArgs } from '../src/launcher/options.ts';
import { claudeArgs } from '../src/adapters/claude/launch.ts';
import { readClaudeArgs } from '../src/adapters/claude/arguments.ts';

const sessionId = '843498c7-51fb-4a69-a47c-9a8d8c5a1b3c';
const config = { mcpFile: '/run/mcp.json', settingsFile: '/run/settings.json' };

test('permission bypass is opt-in and reaches Claude after the companion configuration', () => {
  assert.deepEqual(parseLaunchArgs(['claude']).agentArgs, []);
  const { values, agent, agentArgs } = parseLaunchArgs(['--voice', 'cedar', 'claude', '--dangerously-skip-permissions']);
  assert.equal(values.voice, 'cedar'); assert.equal(agent, 'claude');
  const args = claudeArgs({ config, sessionId, extraArgs: agentArgs });
  assert.equal(args.at(-1), '--dangerously-skip-permissions');
  assert.ok(args.includes(config.mcpFile)); assert.ok(args.includes(config.settingsFile));
  assert.ok(args.includes('server:voice')); assert.ok(args.includes(sessionId));
});

test('agent options, repeated overrides, short flags and quoted values keep their exact order', () => {
  const agentArgs = ['--model=sonnet', '--model', 'opus', '--permission-mode', 'plan', '-d', 'api,hooks',
    '--allowedTools', 'Read', 'Bash(git *)', '--append-system-prompt', 'Keep $(this) and `that` literal', '--port', '1234'];
  const parsed = parseLaunchArgs(['--voice=marin', '--port', '4321', 'claude', ...agentArgs]);
  assert.equal(parsed.values.port, '4321'); assert.deepEqual(parsed.agentArgs, agentArgs);
  assert.deepEqual(claudeArgs({ config, sessionId, extraArgs: parsed.agentArgs }).slice(-agentArgs.length), agentArgs);
});

test('an initial prompt cannot be swallowed by the generated variadic channel flag', () => {
  const prompt = 'Explain this project';
  const { agentArgs } = parseLaunchArgs(['claude', prompt]);
  assert.deepEqual(agentArgs, [prompt]);
  for (const id of [sessionId, undefined]) {
    const args = claudeArgs({ config, sessionId: id, extraArgs: agentArgs });
    assert.deepEqual(args.slice(-3), ['--settings', config.settingsFile, prompt], 'a single-value option always precedes the operator\'s arguments');
  }
});

test('resuming with Claude flags keeps the companion on the selected session', () => {
  const { agentArgs } = parseLaunchArgs(['claude', '--resume', sessionId, '--dangerously-skip-permissions']);
  const session = readClaudeArgs(agentArgs);
  assert.deepEqual(session, { direct: false, resume: true, sessionId, assignSession: false });
  const args = claudeArgs({ config, sessionId: session.assignSession ? 'assigned' : undefined, extraArgs: agentArgs });
  assert.deepEqual(args.slice(-3), ['--resume', sessionId, '--dangerously-skip-permissions']);
  assert.ok(!args.includes('--session-id'), 'Claude\'s own --resume chooses the session');
  assert.equal(readClaudeArgs([`--session-id=${sessionId}`]).sessionId, sessionId);
});

test('after the agent\'s name, names that match companion options belong to the agent', () => {
  const parsed = parseLaunchArgs(['--port=9000', 'claude', '--help', '--voice', 'some-value']);
  assert.equal(parsed.values.port, '9000'); assert.equal(parsed.values.help, undefined);
  assert.equal(parsed.values.voice, 'marin');
  assert.deepEqual(parsed.agentArgs, ['--help', '--voice', 'some-value']);
  assert.deepEqual(parseLaunchArgs(['--', 'claude', '--', '--no-open']).agentArgs, ['--', '--no-open']);
  assert.deepEqual(parseLaunchArgs(['claude', '--append-system-prompt=--voice']).agentArgs, ['--append-system-prompt=--voice']);
});

test('launcher commands are not inferred from agent arguments', () => {
  assert.equal(parseLaunchArgs(['usage']).command, 'usage');
  assert.equal(parseLaunchArgs(['doctor']).command, 'doctor');
  assert.equal(parseLaunchArgs(['doctor', 'claude']).agent, 'claude');
  assert.equal(parseLaunchArgs(['claude', '--model', 'usage']).command, undefined);
  assert.equal(parseLaunchArgs(['claude', 'doctor']).command, undefined);
  assert.deepEqual(parseLaunchArgs(['claude', 'doctor']).agentArgs, ['doctor']);
});

test('companion options validate values, keep last-value-wins behavior, and refuse unknown names', () => {
  assert.equal(parseLaunchArgs(['--port', '8123', '--port=9000', 'claude']).values.port, '9000');
  assert.equal(parseLaunchArgs(['-h']).values.help, true);
  assert.throws(() => parseLaunchArgs(['--port']), /argument/i);
  assert.throws(() => parseLaunchArgs(['--voice', '--model', 'opus']), /ambiguous|argument/i);
  assert.throws(() => parseLaunchArgs(['--help=false']), /argument/i);
  assert.throws(() => parseLaunchArgs(['--cwd', '/project', 'claude']), /Unknown option --cwd/);
  assert.throws(() => parseLaunchArgs(['--dangerously-skip-permissions', 'claude']), /Unknown option .*go before the agent's name/);
  assert.equal(parseLaunchArgs([]).agent, undefined);
});
