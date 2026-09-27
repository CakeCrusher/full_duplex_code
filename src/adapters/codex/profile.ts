import type { AgentProfile } from '../../core/adapter.ts';

export const codexProfile: AgentProfile = {
  id: 'codex', name: 'Codex', product: 'Codex',
  turnEnd: 'Stop', promptEvent: 'UserPromptSubmit',
  // Assistant messages arrive from the transcript as the turn runs, and
  // turn/steer reaches a running turn.
  streamsMessages: true, canSteer: true,
  eventWord: 'event', eventsWord: 'events',
  transport: 'app server', wire: 'turn input',
};
