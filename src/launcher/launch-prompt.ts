import readline from 'node:readline';
import type { AgentProfile } from '../core/adapter.ts';

// The agent fills the whole terminal once it starts, hiding everything printed
// before it. Wait so the operator can open or scan the links first.
// Resolves true on Enter, false on Ctrl-C or closed input.
export function confirmStart({ input = process.stdin, output = process.stdout, profile: { name, product } }: { input?: NodeJS.ReadableStream & { isTTY?: boolean }; output?: NodeJS.WritableStream; profile: Pick<AgentProfile, 'name' | 'product'> }): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    let answered = false;
    const finish = (value: boolean) => { if (answered) return; answered = true; rl.close(); resolve(value); };
    rl.on('SIGINT', () => { output.write('\n'); finish(false); });
    rl.on('close', () => finish(false));
    rl.question(`Press Enter to start ${product}, or Ctrl-C to quit.\n${name} then fills this terminal, and these links stay hidden until you exit. `, () => finish(true));
  });
}
