// What a learned instruction says. Jev finds that the operator gave the voice companion a standing
// instruction; the words themselves are speech: unfinished, hedged, mixed with other talk. A
// detached one-off run of the same harness (its own non-interactive mode, no tools, no saved
// session) is told so, given what Jev saw, and writes the instruction inside <instruction> tags
// (tags rather than tool calls, which not every harness's one-off mode has), or names one in force
// that already says it. The operator's words stay in the log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition } from './adapter.ts';

export type Distilled = { text: string } | { same: string };

export function distillPrompt({ said, transcript = '', inForce, scores }: { said: string; transcript?: string; inForce: { id: string; text: string }[]; scores?: { behave?: number; lasting?: string } }) {
  return [
    'You are writing one instruction for a voice companion. The operator talks by voice to the companion, which relays a coding agent\'s work.',
    `A judge (Jev) has determined that the operator just gave the companion a standing instruction: how it should behave toward them ${scores?.lasting === 'always' ? 'in every session' : 'for the rest of this session'}${typeof scores?.behave === 'number' ? ` (confidence ${scores.behave.toFixed(2)})` : ''}. There is an instruction here; your only job is to state it clearly.`,
    '',
    'What the judge saw:',
    `- The conversation, oldest first (speech-to-text, may be imperfect or unfinished; the line marked ► is what the operator just said): ${JSON.stringify(transcript.slice(-1500) || said)}`,
    `- Instructions already in force: ${inForce.length ? inForce.map(i => `${i.id}: ${i.text}`).join(' | ') : '(none)'}`,
    '',
    'Reply with exactly one of these and nothing else, no other text before or after:',
    '<instruction>the instruction, addressed to the companion, one or two short sentences, self-contained, saying what the operator wants and nothing they did not say</instruction>',
    '<same>ID</same>  (only if an instruction already in force says the same thing, e.g. <same>I1</same>)',
  ].join('\n');
}

export function parseDistilled(reply: string): Distilled {
  const same = reply.match(/<same>\s*(I\d+)\s*<\/same>/i);
  if (same) return { same: same[1].toUpperCase() };
  const text = reply.match(/<instruction>([\s\S]*?)<\/instruction>/i)?.[1].replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('The harness replied without an <instruction>.');
  return { text: text.slice(0, 400) };
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
