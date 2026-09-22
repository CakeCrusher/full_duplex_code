export const DEFAULT_SPEAKING_LEVEL = 1;

const policies = [
  'Quiet: speak only in response to the operator addressing you. Answer, then listen. Claude events alone never prompt speech, including task completion and blockers. An answered question is not permission for follow-up reports.',
  'Milestones: the hook feed labels claude_turn_state. While it is working, listen and answer the operator; otherwise stay silent unless Claude is blocked on an operator decision. When it becomes turn_finished, offer one brief, useful outcome: what is ready, how to use it, and any important limitation. Select what matters rather than list implementation steps. Finish that thought, then listen. Further log entries are background knowledge, not cues to start speaking again. Never repeat a reported result without being asked.',
];

export function normalizeSpeakingLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > 2) throw new Error('Invalid speaking level');
  // Older open dashboards can still submit the retired Walkthrough value.
  return level === 2 ? DEFAULT_SPEAKING_LEVEL : level;
}

export function speakingPolicy(level = DEFAULT_SPEAKING_LEVEL) {
  level = normalizeSpeakingLevel(level);
  return `Speaking configuration (replaces the earlier configuration; the user's spoken requests take priority): ${policies[level]} Apply this preference without announcing the change.`;
}
