import type { AgentProfile } from '../../core/adapter.ts';

export const agyProfile: AgentProfile = {
  id: 'agy', name: 'Antigravity', product: 'Antigravity',
  turnEnd: 'Stop', promptEvent: 'USER_INPUT',
  // Its replies arrive from its transcript as the turn runs, and a request reaches a running turn at its next model call.
  streamsMessages: true, canSteer: true,
  eventWord: 'event', eventsWord: 'events',
  transport: 'language server', wire: 'injected step',
  requests: 'Messages that start with "[Voice request …]"',
};
