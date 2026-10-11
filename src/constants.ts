import type { SearchEffort } from "./types";

/** Fixed tuning values. Program constants, not environment variables. */

/** Fixed minimum between dispatch starts for the HTML search provider. */
export const PROVIDER_INTERVAL_MS = 5_000;
/** Upper bound for a single upstream request. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** `nextRetryAt` delay after a provider challenge / rate limit. */
export const COOLDOWN_MS = 1_800_000;
/** `nextRetryAt` delay after a non-challenge provider failure. */
export const TRANSIENT_DELAY_MS = 1_500;
/** When the cooldown remainder is at most this, an admitted search waits it out in place. */
export const COOLDOWN_WAIT_MAX_MS = 10_000;
/** Effort level used when the caller does not ask for one. */
export const DEFAULT_SEARCH_EFFORT: SearchEffort = "low";
/**
 * Result pages or batches a DDG transport loads for one search, including the
 * initial load. A provider may finish earlier when it confirms exhaustion.
 */
export const DDG_EFFORT_PAGES: Record<SearchEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
};
/** Hard cap for a single upstream response body. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Hard cap for the serialized tool output. */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Hard upper bound for the query length. */
export const MAX_QUERY_LENGTH = 512;
/** Default DuckDuckGo region. */
export const DEFAULT_REGION = "wt-wt";

/** Browser fallback search endpoint (the JavaScript DuckDuckGo site). */
export const BROWSER_SEARCH_ENDPOINT = "https://duckduckgo.com/";
/** Desktop Chrome User-Agent shared with the HTTP search headers. */
export const BROWSER_SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
/** Viewport advertised by the browser fallback. */
export const BROWSER_SEARCH_VIEWPORT = { width: 1280, height: 720 } as const;
/** `accept-language` header advertised by the browser fallback. */
export const BROWSER_SEARCH_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
/** Upper bound for waiting on result containers after a search or pagination load. */
export const BROWSER_SEARCH_RESULTS_TIMEOUT_MS = 15_000;
/** Polling interval while waiting for result containers. */
export const BROWSER_SEARCH_POLL_INTERVAL_MS = 250;
