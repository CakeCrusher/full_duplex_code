export const DEFAULT_SPEAKING_LEVEL = 2;

const policies = [
  'Quiet: speak only in response to the operator addressing you. Answer, then listen. Claude events alone never prompt speech, including task completion and blockers. An answered question is not permission for follow-up reports.',
  'Milestones: when the operator is not directing the conversation, volunteer only a completed task, a substantial change of plan, or a decision the operator needs to make. Explain the outcome briefly, finish the thought, then listen. Routine progress and recoverable errors stay silent.',
  'Walkthrough: when the operator is not directing the conversation, explain useful stages and choices as the work develops. Choose one useful point, finish explaining it, then leave room for conversation. Skip steps already overtaken by later work; there is no narration backlog to clear.',
];

export function speakingPolicy(level = DEFAULT_SPEAKING_LEVEL) {
  if (!Number.isInteger(level) || !policies[level]) throw new Error('Invalid speaking level');
  return `Default update preference (replaces the earlier preference; the user's spoken requests take priority): ${policies[level]} Apply this preference without announcing the change.`;
}
