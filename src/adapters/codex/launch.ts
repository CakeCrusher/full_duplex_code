// Codex's own command, attached to the companion's app server. The companion's
// options go first, or right after `resume` / `fork`, whose options they are;
// the operator's arguments follow unchanged.
export const TOKEN_VARIABLE = 'FD_CODEX_TOKEN';

export function codexArgs(url: string, agentArgs: readonly string[]): string[] {
  const ours = ['--remote', url, '--remote-auth-token-env', TOKEN_VARIABLE];
  return ['resume', 'fork'].includes(agentArgs[0]) ? [agentArgs[0], ...ours, ...agentArgs.slice(1)] : [...ours, ...agentArgs];
}
