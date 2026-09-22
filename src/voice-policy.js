export const DEFAULT_SPEAKING_LEVEL = 1;

const policies = [
  'Quiet: speak only in response to the operator addressing you. Answer, then listen. Claude events alone never prompt speech, including task completion and blockers. An answered question is not permission for follow-up reports.',
  'Milestones: when the operator is not directing the conversation, volunteer only a completed task, a substantial change of plan, or a decision the operator needs to make. Explain the outcome briefly, finish the thought, then listen. Routine progress and recoverable errors stay silent.',
];

export function normalizeSpeakingLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > 2) throw new Error('Invalid speaking level');
  // Older open dashboards can still submit the retired Walkthrough value.
  return level === 2 ? DEFAULT_SPEAKING_LEVEL : level;
}

export function speakingPolicy(level = DEFAULT_SPEAKING_LEVEL) {
  level = normalizeSpeakingLevel(level);
  return `Default update preference (replaces the earlier preference; the user's spoken requests take priority): ${policies[level]} Apply this preference without announcing the change.`;
}
