// Codex's own command, attached to the companion's app server. The companion's
// options go first, or right after `resume` / `fork`, whose options they are;
// the operator's arguments follow unchanged.
export const TOKEN_VARIABLE = 'FD_CODEX_TOKEN';

export function codexArgs(url: string, agentArgs: readonly string[]): string[] {
  // The companion's hooks are session flags that Codex has not reviewed, so the
  // terminal skips hook trust for this run (see refuseUnreviewedHooks).
  const ours = ['--remote', url, '--remote-auth-token-env', TOKEN_VARIABLE, '--dangerously-bypass-hook-trust'];
  return ['resume', 'fork'].includes(agentArgs[0]) ? [agentArgs[0], ...ours, ...agentArgs.slice(1)] : [...ours, ...agentArgs];
}
