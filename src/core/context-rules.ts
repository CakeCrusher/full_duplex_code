// What of an agent's events reaches Live. The adapter's table (AgentDefinition.context)
// removes or truncates events and keys; the core applies it after two rules every
// agent shares: binary data is never text, and Live already has its own voice
// requests. Anything else is sent as it is.
import type { Observation } from './adapter.ts';
import type { ObservedAgent } from './agent-observer.ts';
import { voiceEcho } from './prompts.ts';

const omitted = (chars: number) => `[omitted: ${chars.toLocaleString('en-US')} chars]`;
// Base64 of 1,000 characters or more, alone or in a data URI: images, PDFs, audio.
const BINARY = /^(?:data:[^,]*,)?[\w+/\r\n-]{1000,}={0,2}$/;

/** Keeps at most `max` characters of a value, cutting from the middle; 0 leaves only the marker. */
export function truncate(value: unknown, max: number): unknown {
  const chars = Array.from(typeof value === 'string' ? value : JSON.stringify(value)), half = Math.floor(max / 2);
  if (chars.length <= max) return value;
  return [chars.slice(0, half).join(''), omitted(chars.length - 2 * half), chars.slice(chars.length - half).join('')].filter(Boolean).join(' … ');
}

// The two rules every agent shares, on each string of an event.
function shared(agent: ObservedAgent, value: unknown): unknown {
  if (typeof value === 'string') {
    const request = agent.receivedRequest(value);
    return request ? voiceEcho(agent, request.id) : value.length >= 1000 && BINARY.test(value) ? omitted(value.length) : value;
  }
  if (Array.isArray(value)) return value.map(item => shared(agent, item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shared(agent, item)]));
  return value;
}

/** An event's data as Live may see it, or undefined when the adapter's table removes the event. */
export function contextData(agent: ObservedAgent, { name, text }: Pick<Observation, 'name' | 'text'>): unknown {
  let data: any = shared(agent, JSON.parse(text));
  // Rows match the event as it arrived, before any row changes it.
  const fields = { ...data };
  for (const rule of agent.context) {
    if ((rule.event && rule.event !== name) || Object.entries(rule.where ?? {}).some(([key, value]) => fields[key] !== value)) continue;
    if (!rule.key) {
      if ('remove' in rule) return undefined;
      data = truncate(data, rule.truncate); continue;
    }
    for (const key of [rule.key].flat()) {
      const path = key.split('.'), last = path.pop()!, node = path.reduce((node, part) => node?.[part], data);
      if (!node || typeof node !== 'object' || !(last in node)) continue;
      if ('remove' in rule) delete node[last]; else node[last] = truncate(node[last], rule.truncate);
    }
  }
  return data;
}
