import type { AgentProfile } from '../src/core/adapter.ts';

// The agent's wording, which the bridge writes into the page.
export const profile: AgentProfile = JSON.parse(document.body.dataset.agent!);
export const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);
