// Jev's optional features, each of which can be turned off for a session. Delegation (what reaches the coding agent) and
// the page (the voice moving it with its own words) are core: always on with Jev.
//
// FDC_FEATURES (or --features) lists changes from the defaults, comma-separated: a feature's name turns it on, the name
// after "no-" turns it off, and features not named keep their defaults ("no-instructions,orchestration").

export const FEATURES = {
  /** Off unless turned on: asked to stop the session the operator was speaking to, it didn't (Oct 31). */
  orchestration: 'Jev turns the voice of the operator\'s running sessions on or off when they ask',
  instructions: 'Jev adds the operator\'s standing instructions to the voice companion and saves them',
  /** Off unless turned on (FDC_JEV_TUNING=1 turns it on too, as before). */
  configuration: 'Jev changes the voice companion\'s settings to fit the operator\'s instructions',
} as const;
export type Feature = keyof typeof FEATURES;
export type Features = ReadonlySet<Feature>;
export const DEFAULT_FEATURES: readonly Feature[] = ['instructions'];

/** The features on: the defaults, changed by each list in turn (the environment's, then the command line's). */
export function featuresFrom(defaults: readonly Feature[], ...changes: (string | undefined)[]): Set<Feature> {
  const on = new Set(defaults);
  for (const item of changes.flatMap(list => list?.split(',') ?? []).map(item => item.trim()).filter(Boolean)) {
    const off = item.startsWith('no-'), name = off ? item.slice(3) : item;
    if (!Object.hasOwn(FEATURES, name)) throw new Error(`Unknown feature "${name}". Features: ${Object.keys(FEATURES).join(', ')}; "no-" before one turns it off.`);
    if (off) on.delete(name as Feature); else on.add(name as Feature);
  }
  return on;
}
