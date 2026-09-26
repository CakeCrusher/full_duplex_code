import type { AgentDefinition } from '../core/adapter.ts';
import { claude } from './claude/index.ts';

// Every agent the launcher can start, by command name.
export const agents: Readonly<Record<string, AgentDefinition>> = { claude };
/** The agent `npm start` launches. */
export const defaultAgent = 'claude';
