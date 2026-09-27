import type { Observation } from './adapter.ts';

// Builds an Observation whose `raw` is parsed from its text on demand: the
// store keeps one copy of each event, and published copies stay text-only.
export function observation(fields: Omit<Observation, 'raw'>): Observation {
  return Object.defineProperty({ ...fields }, 'raw', { get(this: Observation) { return JSON.parse(this.text); }, enumerable: false }) as Observation;
}
