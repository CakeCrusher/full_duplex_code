// Who does what when Jev reads the operator's words: one account, in the voice companion's instructions (prompts.ts,
// liveInstructions) and in Jev's setting (jev.ts), so that the two never describe the work differently. Written apart,
// Jev's had drifted: after the voice was told to answer whatever it can from what it knows (Oct 30), Jev still read that
// it answers only from what the agent had said.
import type { AgentProfile } from './adapter.ts';
import type { Features } from './features.ts';

/** What the voice tool does itself with the operator's words besides passing them on, by the features on (features.ts). */
const toolActions = (features: Features) => [
  features.has('orchestration') && 'turns voice sessions on or off',
  features.has('instructions') && 'keeps the operator\'s standing instructions to the companion',
  features.has('configuration') && 'adjusts the companion\'s settings',
  'pauses the companion when the conversation is over for now',
].filter((action): action is string => Boolean(action));
const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];

export const roles = ({ profile: { name } }: { profile: Pick<AgentProfile, 'name'> }, features: Features) =>
  `Who does what: the voice companion answers, explains and presents. It answers whatever it can with moderate confidence, from what it knows and what it was told (this conversation, ${name}'s work, the page); when in doubt about what the operator means, it asks; it moves the page beside the operator with its own words. It passes nothing on itself: when the operator finishes speaking, the voice tool reads their words and sends whatever needs ${name} to ${name}; it also ${listed(toolActions(features))}. Only a request that is fully stated and that the voice companion can't do itself is ${name}'s.`;
