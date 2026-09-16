export const DEFAULT_SPEAKING_LEVEL = 2;

const policies = [
  'Quiet: speak only in response to the user talking to you, including a necessary follow-up in that conversation. Observe Claude silently. Do not initiate progress updates, blocker alerts, completion announcements, greetings, or listening sounds. A Claude observation or speech cue never starts a conversation. Once you have answered the user, return to silence until they address you again.',
  'Milestones: long stretches of silence are expected. Initiate an update only when the user must make a decision, an unexpected discovery substantially changes the plan, or the whole requested task is complete. File edits, commands, tests, retries, partial results and intermediate stages are not milestones. Choose the single most useful outcome, explain why it matters in one or two complete sentences, then stop. Do not catch up aloud on skipped events or narrate a long final report. Answer direct questions naturally.',
  'Walkthrough: as the default mode, explain the current major stage and useful design choices in a few connected sentences, then leave space to listen. Skip routine commands and retries. Finish one idea before choosing the next; a walkthrough is not a running list of every event. If work advances quickly, skip outdated updates and orient the user to the current stage after finishing your thought.',
];

export function speakingPolicy(level = DEFAULT_SPEAKING_LEVEL) {
  if (!Number.isInteger(level) || !policies[level]) throw new Error('Invalid speaking level');
  return `Speaking preference (replaces any earlier speaking preference): ${policies[level]} New observations update your knowledge, not your obligation to speak. Let them accumulate silently while you finish your current sentence and idea; do not restart or abandon it to cover newer information. There is no spoken backlog to clear. Respect the user's requested timing, within this mode: if they ask for an explanation when finished, wait rather than narrating work in progress. Prefer a slightly older complete explanation to newer sentence fragments. Real user interruptions still take priority. Do not announce this preference change, repeat offers to help, or repeatedly invite the user to say what they want.`;
}
