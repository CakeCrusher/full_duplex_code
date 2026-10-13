// What a learned instruction says. Jev only finds that the operator likely gave the voice
// companion a standing instruction; the words themselves are speech: unfinished, hedged, mixed
// with other talk. A detached one-off run of the same agent (its own non-interactive mode, no
// tools, no saved session) writes the instruction those words amount to, or says there is none,
// or that one in force already says it. The operator's words stay in the log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition } from './adapter.ts';

export type Distilled = { text: string } | { none: true } | { same: string };

export function distillPrompt({ said, previous = '', companion = '', inForce }: { said: string; previous?: string; companion?: string; inForce: { id: string; text: string }[] }) {
  return [
    'An operator talks by voice to a voice companion that relays a coding agent\'s work. A judge found that the operator may have just given the companion a standing instruction: how it should behave toward them from now on.',
    'Write that instruction for the companion, or say there is none.',
    '',
    `What the companion said just before: ${JSON.stringify(companion.slice(-400))}`,
    `What the operator said before that: ${JSON.stringify(previous.slice(-400))}`,
    `What the operator just said (speech-to-text, may be imperfect): ${JSON.stringify(said)}`,
    `Instructions already in force: ${inForce.length ? inForce.map(i => `${i.id}: ${i.text}`).join(' | ') : '(none)'}`,
    '',
    'Reply with exactly one line, nothing else:',
    '- the instruction, addressed to the companion, one or two short sentences, self-contained, saying what the operator wants and nothing they did not say; or',
    '- NONE if it is not a standing instruction to the companion: a task or question for the coding agent, talk about how the tool should be designed, a one-off request, or an unfinished thought whose instruction is unclear; or',
    '- SAME <id> if an instruction already in force says the same thing.',
  ].join('\n');
}

export function parseDistilled(reply: string): Distilled {
  const line = reply.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  if (/^NONE\b/i.test(line)) return { none: true };
  const same = line.match(/^SAME\s+(I\d+)\b/i);
  if (same) return { same: same[1].toUpperCase() };
  if (!line) throw new Error('The agent gave no instruction.');
  return { text: line.replace(/^["'`]|["'`]$/g, '').slice(0, 400) };
}

/** Runs the agent once, non-interactively, with no tools and none of the companion's keys; returns its reply. */
export function askAgent(agent: AgentDefinition, prompt: string, { cwd, timeoutMs = 90_000 }: { cwd: string; timeoutMs?: number }): Promise<string> {
  if (!agent.ask) return Promise.reject(new Error(`${agent.profile.name} has no one-off mode.`));
  const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-ask-')), 'reply.txt');
  const { command, args, stdin, output } = agent.ask(prompt, outputFile);
  const env = { ...process.env }; delete env.OPENAI_API_KEY; delete env.TYPESAFE_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${agent.profile.name} took longer than ${timeoutMs / 1000} s.`)); }, timeoutMs);
    child.stdout!.on('data', chunk => { out += chunk; });
    child.stderr!.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const reply = output === 'file' ? (() => { try { return fs.readFileSync(outputFile, 'utf8'); } catch { return ''; } })() : out;
      fs.rmSync(path.dirname(outputFile), { recursive: true, force: true });
      if (code !== 0) return reject(new Error(`${agent.profile.name} exited with ${code}: ${err.trim().slice(-200)}`));
      resolve(reply.trim());
    });
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}
