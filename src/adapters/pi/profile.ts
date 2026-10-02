import type { AgentProfile } from '../../core/adapter.ts';

export const piProfile: AgentProfile = {
  id: 'pi', name: 'Pi', product: 'Pi',
  turnEnd: 'agent_settled', promptEvent: 'input',
  // Each assistant message arrives as it ends, while the turn runs, and a
  // request sent as a steer reaches the running turn.
  streamsMessages: true, canSteer: true,
  eventWord: 'event', eventsWord: 'events',
  transport: 'extension', wire: 'extension message',
};
