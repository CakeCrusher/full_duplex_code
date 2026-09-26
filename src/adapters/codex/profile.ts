import type { AgentProfile } from '../../core/adapter.ts';

export const codexProfile: AgentProfile = {
  id: 'codex', name: 'Codex', product: 'Codex',
  turnEnd: 'Stop', promptEvent: 'UserPromptSubmit',
  // Assistant messages arrive from the transcript as the turn runs, and
  // turn/steer reaches a running turn.
  streamsMessages: true, canSteer: true,
  eventWord: 'event', eventsWord: 'events',
  transport: 'app server', wire: 'turn input',
  // Codex creates its thread with the first message, typed or given on the command line.
  readyHint: 'Send Codex a first message in its terminal to start its session, then start voice.',
};
