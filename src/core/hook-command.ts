import path from 'node:path';

// The command an agent runs for each event: Node, then the relay (hook-relay.ts)
// with the bridge's /hook address. Agents wait for some hooks, so the relay must
// start quickly: Node strips a .ts file's types on every start unless its compile
// cache is on, which this import does first. Percent-encoded: no shell quoting applies.
export const COMPILE_CACHE = 'data:text/javascript,' + encodeURIComponent("import{enableCompileCache}from'node:module';enableCompileCache()").replace(/[()']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function hookCommand(root: string, baseUrl: string): string[] {
  return [process.execPath, '--import', COMPILE_CACHE, path.join(root, 'src/core/hook-relay.ts'), `${baseUrl}/hook`];
}
