// The largest agent event the bridge accepts. Kept apart from the token
// estimator so the per-event hook relay starts without loading tiktoken.
export const MAX_HOOK_BYTES = 32 * 1024 * 1024;
