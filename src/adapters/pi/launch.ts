import path from 'node:path';

// Pi's own command with the companion's extension, for this run only: -e loads
// it even beside --no-extensions. The operator's arguments follow unchanged.
export const extensionFile = (root: string) => path.join(root, 'src/adapters/pi/extension.ts');

export function piArgs(root: string, agentArgs: readonly string[]): string[] {
  return ['-e', extensionFile(root), ...agentArgs];
}
