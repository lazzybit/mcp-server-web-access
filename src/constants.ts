/** Fixed tuning values. Program constants, not environment variables. */

/** Lower clamp for the adaptive interval between upstream dispatches. */
export const MIN_INTERVAL_MS = 5_000;
/** Upper clamp for the adaptive interval between upstream dispatches. */
export const MAX_INTERVAL_MS = 20_000;
/** Multiplier applied to the pacing interval after an upstream failure (`a`). */
export const INTERVAL_INCREASE_FACTOR = 2;
/** Multiplier applied to the pacing interval after an upstream success (`b = 0.7071`). */
export const INTERVAL_DECREASE_FACTOR = 0.7071;
/** Consecutive upstream failures required before entering cooldown. */
export const FAILURE_THRESHOLD = 3;
/** Upper bound for a single upstream request. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** `nextRetryAt` delay after the third consecutive provider challenge / rate limit. */
export const COOLDOWN_MS = 1_800_000;
/** `nextRetryAt` delay after the third consecutive non-challenge upstream failure. */
export const TRANSIENT_DELAY_MS = 1_500;
/** When the cooldown remainder is at most this, an admitted search waits it out in place. */
export const COOLDOWN_WAIT_MAX_MS = 10_000;
/** Upper bound for `deadlineAt` relative to "now"; set by the Worker. */
export const RUN_DEADLINE_MS = 25_000;
/** Maximum pages fetched for one complete search. */
export const MAX_PAGES = 5;
/** Hard cap for a single upstream response body. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Hard cap for the serialized tool output. */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Hard upper bound for the query length. */
export const MAX_QUERY_LENGTH = 512;
/** Hard upper bound for `maxResults`. */
export const MAX_RESULTS_LIMIT = 50;
/** Default DuckDuckGo region. */
export const DEFAULT_REGION = "wt-wt";
