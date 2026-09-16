export const DEFAULT_SPEAKING_LEVEL = 2;

const policies = [
  'Quiet: speak when the user addresses you and continue that conversation. Otherwise observe silently, including at completion or a blocker.',
  'Milestones: outside the conversation, speak only for a decision the user must make, a major change of plan, or completion of the whole task. Give one useful outcome briefly, then listen. Routine work stays silent.',
  'Walkthrough: when the user is not directing the conversation, explain major stages and useful choices in short, complete thoughts. Leave space between updates; skip routine steps.',
];

export function speakingPolicy(level = DEFAULT_SPEAKING_LEVEL) {
  if (!Number.isInteger(level) || !policies[level]) throw new Error('Invalid speaking level');
  return `Default update preference (replaces the earlier preference; the user's spoken requests take priority): ${policies[level]} Apply this preference without announcing the change.`;
}
