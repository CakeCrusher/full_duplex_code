export const DEFAULT_SPEAKING_LEVEL = 2;

const policies = [
  'Quiet: answer a new spoken question or request, then wait silently for the next spoken utterance. An earlier question does not authorize ongoing updates. Claude observations never start a new turn, even at completion or a blocker. Do not acknowledge background events, including with listening sounds.',
  'Milestones: outside a direct reply to the user, remain silent until the whole task is complete, its plan changes substantially, or the user must make a decision. Then give one brief outcome and listen. Starting work, editing a file, running checks and recoverable errors do not merit an update.',
  'Walkthrough: when the user is not directing the conversation, explain major stages and useful choices in short, complete thoughts. Leave space between updates; skip routine steps.',
];

export function speakingPolicy(level = DEFAULT_SPEAKING_LEVEL) {
  if (!Number.isInteger(level) || !policies[level]) throw new Error('Invalid speaking level');
  return `Default update preference (replaces the earlier preference; the user's spoken requests take priority): ${policies[level]} Apply this preference without announcing the change.`;
}
