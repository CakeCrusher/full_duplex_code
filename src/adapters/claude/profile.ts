import type { AgentProfile } from '../../core/adapter.ts';

export const claudeProfile: AgentProfile = {
  id: 'claude', name: 'Claude', product: 'Claude Code',
  turnEnd: 'Stop', promptEvent: 'UserPromptSubmit',
  // MessageDisplay hooks carry assistant text while the turn runs, and channel
  // messages reach Claude mid-turn.
  streamsMessages: true, canSteer: true,
  eventWord: 'hook', eventsWord: 'hooks',
  transport: 'channel', wire: 'channel notification',
};
