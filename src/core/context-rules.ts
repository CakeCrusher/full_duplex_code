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
// The same inside text, such as a script's output that prints an image's JSON.
const EMBEDDED = /[A-Za-z0-9+/]{1000,}={0,2}/g;

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
    if (request) return voiceEcho(agent, request.id);
    if (value.length < 1000) return value;
    return BINARY.test(value) ? omitted(value.length) : value.replace(EMBEDDED, bytes => omitted(bytes.length));
  }
  if (Array.isArray(value)) return value.map(item => shared(agent, item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shared(agent, item)]));
  return value;
}

// The value at a dotted path, without stepping into lists.
const valueAt = (data: unknown, path: string) => path.split('.').reduce((node: any, part) => node && typeof node === 'object' && !Array.isArray(node) ? node[part] : undefined, data);

// Calls change(object, key) where a dotted path ends. A path steps through every
// item of a list on its way, so `message.content.text` reaches each block's text.
function eachEnd(node: unknown, path: readonly string[], change: (object: Record<string, unknown>, key: string) => void) {
  if (Array.isArray(node)) { for (const item of node) eachEnd(item, path, change); return; }
  if (!node || typeof node !== 'object') return;
  const [part, ...rest] = path, object = node as Record<string, unknown>;
  if (!Object.hasOwn(object, part)) return;
  if (rest.length) eachEnd(object[part], rest, change); else change(object, part);
}

/** An event's data as Live may see it, or undefined when the adapter's table removes the event. */
export function contextData(agent: ObservedAgent, { name, text }: Pick<Observation, 'name' | 'text'>): unknown {
  let data: any = shared(agent, JSON.parse(text));
  // Rows match the event as it arrived, before any row changes it.
  const arrived = structuredClone(data);
  for (const rule of agent.context) {
    if ((rule.event && rule.event !== name) || Object.entries(rule.where ?? {}).some(([path, value]) => valueAt(arrived, path) !== value)) continue;
    if (!rule.key) {
      if ('remove' in rule) return undefined;
      data = truncate(data, rule.truncate); continue;
    }
    for (const key of [rule.key].flat()) {
      eachEnd(data, key.split('.'), (object, last) => {
        if ('remove' in rule) delete object[last]; else object[last] = truncate(object[last], rule.truncate);
      });
    }
  }
  return data;
}
