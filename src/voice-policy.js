const policies = [
  'Quiet: answer the user’s questions and alert them to a blocker or decision that needs them. Otherwise observe silently. When the requested work is finished, one brief completion update is enough.',
  'Milestones: stay quiet during routine work. Speak for a decision that needs the user, a discovery that changes the plan, or completion of the requested task. Starting a command, writing a file, running a test and retrying are not milestones. Explain one important idea in one to three complete sentences, then listen.',
  'Walkthrough: explain major stages and design choices in a few connected sentences at a time. Skip routine commands and retries. Finish explaining one idea before choosing the next; a walkthrough is not a running list of every event.',
];

export function speakingPolicy(level = 1) {
  if (!Number.isInteger(level) || !policies[level]) throw new Error('Invalid speaking level');
  return `Speaking preference (replaces any earlier speaking preference): ${policies[level]} Respect the user's requested timing: if they ask for an explanation when finished, wait for completion rather than narrating work in progress. Finish your thought before incorporating newer observations. Prefer a slightly older complete explanation to abandoned sentences. Real user interruptions still take priority. Do not repeat offers to help or repeatedly invite the user to say what they want.`;
}
