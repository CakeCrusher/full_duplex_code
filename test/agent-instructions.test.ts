import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/core/bridge.ts';
import { agentInstructions } from '../src/core/prompts.ts';
import type { AgentDefinition } from '../src/core/adapter.ts';
import { agents } from '../src/adapters/index.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { codex } from '../src/adapters/codex/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const STAGE = path.join(root, 'STAGE.md');

test("fdc's instructions say how each agent sees a voice request and where the guide to steerable pages is", () => {
  for (const agent of Object.values(agents)) {
    const text = agentInstructions(agent);
    assert.ok(text.startsWith(`${agent.profile.requests} are transcribed requests from the user`), agent.profile.id);
    assert.ok(text.includes(STAGE) && text.includes('window.fdcController') && text.includes('data-fdc'), agent.profile.id);
  }
});

// The requirement every adapter meets (src/adapters/README.md): the instructions reach the agent's system prompt in a session
// fdc starts, one it resumes and one it never started. They go through the agent's launch, which is the same for all three,
// or through its hook at every start of a session (startup, resume, and after compaction).
test('every agent gets the instructions, through its launch or its hook at every session start', async t => {
  const instructions = `fdc instructions ${randomUUID()}`;
  for (const agent of Object.values(agents)) {
    if (agent.instruct) {
      for (const source of ['startup', 'resume', 'compact', 'clear']) {
        const answer = JSON.stringify(agent.instruct({ hook_event_name: 'SessionStart', source, session_id: 's' }, instructions) ?? null);
        assert.ok(answer.includes(instructions), `${agent.profile.id}: SessionStart (${source})`);
      }
      assert.equal(agent.instruct({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, instructions), undefined, `${agent.profile.id}: only a session's start`);
      continue;
    }
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `fd-instructions-${agent.profile.id}-`));
    t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
    const adapter = agent.create({ root, runDir, cwd: runDir, observation: agent.observationModes[0] ?? '', agentArgs: ['--resume'], instructions, clean: String, log: () => {} });
    const launch = await adapter.launch({ baseUrl: 'http://127.0.0.1:1', token: 'token' });
    const handed = [...launch.args, ...Object.values(launch.env), ...Object.values(launch.files).map(file => fs.readFileSync(file, 'utf8'))].join('\n');
    assert.ok(handed.includes(JSON.stringify(instructions).slice(1, -1)) || handed.includes(instructions), `${agent.profile.id}: its launch carries them`);
    await adapter.close();
  }
});

test("Codex's SessionStart hook brings the instructions to the main thread, not to a subagent", () => {
  const answer = codex.instruct!({ hook_event_name: 'SessionStart', source: 'resume', session_id: 's' }, 'text');
  assert.deepEqual(answer, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'text' } });
  assert.equal(codex.instruct!({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's', agent_id: 'worker' }, 'text'), undefined);
});

async function relayed(t: TestContext, agent: AgentDefinition = { ...claude, instruct: codex.instruct }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-instruct-'));
  const h = await new Harness({ agent, root: dir, runDir: path.join(dir, 'run'), cwd: dir, sessionId: randomUUID(), apiKey: 'unused-test-key' }).start();
  t.after(async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const relay = async (event: Record<string, unknown>) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/core/hook-relay.ts', import.meta.url)), h.baseUrl + '/hook'], { env: { ...process.env, FD_BRIDGE_TOKEN: h.agentToken }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    const done = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ session_id: h.sessionId, ...event }));
    assert.equal(await done, 0);
    return JSON.parse(stdout);
  };
  return { h, relay };
}

test('the command hook answers a session start with the instructions for an agent they reach that way', async t => {
  const { h, relay } = await relayed(t);
  for (const source of ['startup', 'resume', 'compact']) {
    assert.deepEqual(await relay({ hook_event_name: 'SessionStart', source }), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: h.agentInstructions } }, source);
  }
  assert.deepEqual(await relay({ hook_event_name: 'PostToolUse', tool_name: 'Read' }), {});
});

test("Claude's hook answers nothing at a session start: its instructions are the voice channel's", async t => {
  const { relay } = await relayed(t, claude);
  assert.deepEqual(await relay({ hook_event_name: 'SessionStart', source: 'resume' }), {});
});
