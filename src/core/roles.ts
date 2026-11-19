// Who does what when Jev reads the operator's words: one account, in the voice companion's instructions (prompts.ts,
// liveInstructions) and in Jev's setting (jev.ts), so that the two never describe the work differently. Written apart,
// Jev's had drifted: after the voice was told to answer whatever it can from what it knows (Oct 30), Jev still read that
// it answers only from what the agent had said. "Passes nothing on itself" alone had the voice ask the operator to send a
// request on ("Could you send that on to Codex for us?", Duplex Party, Oct 31). Since Nov 18 the companion's own words
// can send something too: the voice tool reads them with the operator's once both have stopped talking (mediator.ts),
// so the companion gets a drawing made or a figure checked by saying what the agent should do. And the agent never
// presents: asked to "keep on walking through it", Codex ran its own timed walkthrough in the tab the operator was
// looking at while the companion moved the same page (Nov 18).
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
  `Who does what: the voice companion answers, explains and presents. It answers whatever it can with moderate confidence, from what it knows and what it was told (this conversation, ${name}'s work, the page); when in doubt about what the operator means, it asks; the page beside the operator follows what it says. ${name} does the work (makes, changes, runs, checks, and adds to the page what it can't yet show or do) and never presents. The voice tool passes things on: what the page's controls can do, it does there as the operator asks; once the operator and the companion have both stopped talking, it sends ${name} whatever needs it, be it what the operator asked for or what the companion said ${name} should do; it also ${listed(toolActions(features))}. The companion never asks the operator to pass anything on. Only what is fully stated and that neither the companion nor the page can do is ${name}'s.`;
