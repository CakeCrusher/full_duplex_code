// What a learned instruction says. Jev finds that the operator gave the voice companion a standing
// instruction; the words themselves are speech: unfinished, hedged, mixed with other talk. A
// detached one-off run of the same harness (its own non-interactive mode, no tools, no saved
// session) is told so, given what Jev saw, and writes the instruction inside <instruction> tags
// (tags rather than tool calls, which not every harness's one-off mode has), or names one in force
// that already says it. It also names the instructions in force that the new one takes the place of, or that the operator
// asks to drop without giving a new one: they are removed, so the list holds what the operator wants now. Before, the new one said "this replaces the earlier instruction" and both
// stayed (Nov 4: "stay quiet and wait" beside "keep walking the operator through things", and three Standby waits).
// The operator's words stay in the log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition } from './adapter.ts';

export type Distilled = { text: string; /** Instructions in force that this one takes the place of. */ replaces?: string[] } | { same: string } | { /** Instructions in force the operator asks to drop, giving no new one. */ remove: string[] } | { /** The judge was wrong: the words change nothing in the list. */ none: true };

export function distillPrompt({ said, transcript = '', inForce, scores, remove }: { said: string; transcript?: string; inForce: { id: string; text: string }[]; scores?: { behave?: number; lasting?: string }; /** The instruction in force Jev finds they ask to remove. */ remove?: string }) {
  return [
    'You are writing one instruction for a voice companion. The operator talks by voice to the companion, which relays a coding agent\'s work.',
    `A judge (Jev) has determined that the operator just gave the companion a standing instruction: how it should behave toward them ${scores?.lasting === 'always' ? 'in every session' : 'for the rest of this session'}${typeof scores?.behave === 'number' ? ` (confidence ${scores.behave.toFixed(2)})` : ''}${remove ? `, or asked it to drop one of the instructions in force (the judge thinks ${remove})` : ''}. Your only job is to state clearly what changes.`,
    '',
    'What the judge saw:',
    `- The conversation, oldest first (speech-to-text, may be imperfect or unfinished; the line marked ► is what the operator just said): ${JSON.stringify(transcript.slice(-1500) || said)}`,
    `- Instructions already in force: ${inForce.length ? inForce.map(i => `${i.id}: ${i.text}`).join(' | ') : '(none)'}`,
    '',
    'Reply with exactly one of these and nothing else, no other text before or after:',
    '<instruction>the instruction, addressed to the companion, one or two short sentences, self-contained, saying what the operator wants and nothing they did not say</instruction>',
    '<same>ID</same>  (only if an instruction already in force says the same thing, e.g. <same>I1</same>)',
    '<remove>IDs</remove>  (only if they ask to drop instructions already in force and give no new one, e.g. "forget the thing about short answers": <remove>I2</remove>)',
    '<none></none>  (only if the judge is wrong: the words give the companion no standing instruction and ask for none of those in force to be dropped, e.g. they are a request about the work, or take back something that is not one of these instructions)',
    'After an <instruction>, add <replaces>IDs</replaces> only if the new instruction takes the place of instructions already in force, because it reverses them or sets the same thing to something else (e.g. <replaces>I2, I5</replaces>). Those are removed, so write the new instruction to stand on its own, without mentioning them. An instruction that only adds to the others replaces nothing.',
  ].join('\n');
}

export function parseDistilled(reply: string): Distilled {
  const same = reply.match(/<same>\s*(I\d+)\s*<\/same>/i);
  if (same) return { same: same[1].toUpperCase() };
  const ids = (tag: string) => [...new Set((reply.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1].match(/I\d+/gi) ?? []).map(id => id.toUpperCase()))];
  const remove = ids('remove');
  if (remove.length && !/<instruction>/i.test(reply)) return { remove };
  if (/<none>\s*<\/none>|<none\s*\/>/i.test(reply) && !/<instruction>/i.test(reply)) return { none: true };
  const text = reply.match(/<instruction>([\s\S]*?)<\/instruction>/i)?.[1].replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('The harness replied without an <instruction>.');
  const replaces = ids('replaces');
  return { text: text.slice(0, 400), ...replaces.length && { replaces } };
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
