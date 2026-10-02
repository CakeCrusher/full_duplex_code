import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Finds an agent's command as the operator's shell would run it: a program on
// the PATH, or else an alias the operator defined, such as `pi` pointing at a
// checkout. A spawned process cannot see aliases, so the alias is read once
// from the operator's interactive shell and its words run directly.

export interface Command { command: string; args: string[]; via: 'path' | 'alias' }

const executable = (file: string) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
const onPath = (name: string) => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)).find(executable);

// The words of a shell alias value: whitespace separates, quotes group, a leading ~ is the home folder.
export function words(value: string): string[] {
  const out: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === quote) quote = ''; else if (c === '\\' && quote === '"' && i + 1 < value.length) word += value[++i]; else word += c; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === '\\' && i + 1 < value.length) { word += value[++i]; started = true; }
    else if (/\s/.test(c)) { if (started || word) out.push(word); word = ''; started = false; }
    else { word += c; started = true; }
  }
  if (started || word) out.push(word);
  return out.map(w => w === '~' ? os.homedir() : w.startsWith('~/') ? path.join(os.homedir(), w.slice(2)) : w);
}

// An alias's value as zsh (`pi=value`) or bash (`alias pi='value'`) prints it:
// one shell word, so its quotes are removed before the value is split into words.
export function aliasValue(output: string, name: string): string | undefined {
  const line = output.split('\n').map(l => l.trim()).reverse().find(l => l.replace(/^alias\s+/, '').startsWith(`${name}=`));
  if (line === undefined) return undefined;
  let printed = line.replace(/^alias\s+/, '').slice(name.length + 1), value = '', quote = '';
  for (let i = 0; i < printed.length; i++) {
    const c = printed[i];
    if (quote) { if (c === quote) quote = ''; else if (c === '\\' && quote === '"' && i + 1 < printed.length) value += printed[++i]; else value += c; }
    else if (c === "'" || c === '"') quote = c;
    else if (c === '\\' && i + 1 < printed.length) value += printed[++i];
    else value += c;
  }
  return value;
}

/** How to start `name`, or undefined when neither the PATH nor the operator's shell knows it. */
export function resolveCommand(name: string, shell = process.env.SHELL): Command | undefined {
  if (onPath(name)) return { command: name, args: [], via: 'path' };
  if (!shell || !/^[\w.-]+$/.test(name)) return undefined;
  const asked = spawnSync(shell, ['-ic', `alias ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  const value = asked.status === 0 ? aliasValue(asked.stdout, name) : undefined;
  const [first, ...args] = value ? words(value) : [];
  if (!first) return undefined;
  const command = first.includes('/') ? (executable(first) ? first : undefined) : onPath(first) ? first : undefined;
  return command ? { command, args, via: 'alias' } : undefined;
}

/** Runs `name` to completion, found as resolveCommand finds it; for checks such as `fdc doctor`. */
export function runCommand(name: string, args: readonly string[]) {
  const found = resolveCommand(name);
  return found ? spawnSync(found.command, [...found.args, ...args], { encoding: 'utf8' }) : { status: null, stdout: '', stderr: '' };
}
