import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A new terminal window running a command: a fork of the agent's session opens in one (forks.ts), beside the operator's
// own terminal, which keeps the main session. The command goes in a script of its own, owner-only in the run's folder:
// the agent by its full path, the PATH fdc has (the agent's tools are the main session's), and fdc's own variables.
// The operator is not at that window. An agent that waits there for Enter on a prompt as it starts (launch.confirm) gets
// it from fdc: the agent runs under expect, which passes the terminal through both ways, keeps it the window's size,
// and sends Enter once the prompt's words appear in the first minute and a half. Without expect on this computer the
// agent runs as before, and the operator answers.

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** The command's full path, as fdc's PATH finds it: the new window's shell may not have the same PATH. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env) {
  if (command.includes('/')) return command;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, command);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return command;
}

/** The system's expect (not one on the PATH: a Node package of that name is something else). */
export const EXPECT = '/usr/bin/expect';
// The agent under expect: its prompt answered (the words may have terminal codes between them; three times at most, should
// the first Enter come before the prompt takes keys), everything else passed through, and the agent's exit status kept.
const ANSWERS = `set words [lindex $argv 0]; set command [lrange $argv 1 end]
set pattern [join [split $words " "] {.{0,40}?}]
set started [clock seconds]; set answered 0
eval spawn -noecho $command
trap { catch { stty rows [stty rows] columns [stty columns] < $spawn_out(slave,name) } } WINCH
interact {
  -o -nobuffer -re $pattern { if {$answered < 3 && [clock seconds] - $started < 90} { incr answered; after 400; send "\\r" } }
}
catch wait result; exit [lindex $result 3]
`;

export function writeScript(file: string, launch: { command: string; args: readonly string[]; env: Record<string, string>; confirm?: string }, cwd: string, env: NodeJS.ProcessEnv = process.env, expect = EXPECT) {
  const command = [resolveCommand(launch.command, env), ...launch.args];
  // The prompt's words go first, then the command, as the program's arguments.
  const answered = launch.confirm && fs.existsSync(expect) ? `${file}.exp` : undefined;
  if (answered) fs.writeFileSync(answered, ANSWERS, { mode: 0o600 });
  const lines = ['#!/bin/sh', `cd ${quote(cwd)} || exit 1`, ...env.PATH ? [`export PATH=${quote(env.PATH)}`] : [],
    ...Object.entries(launch.env).map(([name, value]) => `export ${name}=${quote(value)}`), `exec ${(answered ? [expect, '-f', answered, '--', launch.confirm!, ...command] : command).map(quote).join(' ')}`];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o700 });
  return file;
}

export type Run = (command: string, args: string[]) => { status: number | null; stderr?: string | Buffer | null; error?: Error };

/**
 * Opens the script in a new window of the operator's terminal app, and says which; throws why it couldn't. iTerm and
 * Ghostty open their own window; anything else on a Mac (Terminal, or an editor's terminal, which no script can open a
 * window in) gets a Terminal window.
 */
export function openWindow(script: string, env: NodeJS.ProcessEnv = process.env, run: Run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 10000 })) {
  const attempt = (how: string, command: string, args: string[]) => {
    const result = run(command, args);
    if (result.error || result.status !== 0) throw new Error(`${how} did not open a window: ${result.error?.message ?? String(result.stderr ?? '').trim() ?? `exit ${result.status}`}`);
    return how;
  };
  if (process.platform === 'darwin') {
    if (env.TERM_PROGRAM === 'iTerm.app') return attempt('iTerm', 'osascript', ['-e', `tell application "iTerm" to create window with default profile command ${JSON.stringify(script)}`]);
    if (env.TERM_PROGRAM === 'ghostty') return attempt('Ghostty', 'open', ['-na', 'Ghostty', '--args', '-e', script]);
    return attempt('Terminal', 'open', ['-a', 'Terminal', script]);
  }
  if (process.platform === 'linux') return attempt('a terminal window', 'x-terminal-emulator', ['-e', script]);
  throw new Error(`fdc can't open a terminal window on ${process.platform}: run ${script} in a terminal`);
}
