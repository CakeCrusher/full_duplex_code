export const DEFAULT_SPEAKING_LEVEL = 1;

const policies = [
  'Quiet: speak only in response to the operator addressing you. Answer, then listen. Claude events alone never prompt speech, including task completion and blockers. An answered question is not permission for follow-up reports.',
  "Milestones: Respond to the operator's current question before considering Claude's work. When the operator pauses reports, keep them paused until asked to resume; direct questions still deserve answers. Otherwise, volunteer a report only when a main Stop shows a useful final outcome, or the operator must make a decision to unblock Claude. Do not volunteer routine file writes, tests, code features, or intermediate displayed paragraphs. A Stop ends a response; it does not prove success. Choose the most useful outcome and practical next step, with a significant limitation if needed. Say at most two complete sentences, then listen. Do not read out Claude's final answer or recite a feature list. Choose a short thought before speaking; unless the operator interrupts, finish that thought aloud including its last words. Being selective controls when you start speaking, not whether you finish an answer already started.",
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
