/** Shared result contract between the Worker and the `SearchService` Durable Object. */

export type Freshness = "day" | "week" | "month" | "year";

/**
 * Intended search intensity, not a result-count target. Each provider reads it
 * as its own amount of search work; the DDG transports currently map it to
 * 1/2/3 result pages or batches including the initial load.
 */
export type SearchEffort = "low" | "medium" | "high";

/** Validated tool parameters forwarded to the Durable Object. */
export interface SearchParams {
  query: string;
  effort: SearchEffort;
  region: string;
  freshness?: Freshness;
}

/** A single organic result. */
export interface SearchResultItem {
  rank: number;
  title: string;
  url: string;
  domain: string;
  snippet: string | null;
}

/**
 * Error codes kept for wire compatibility. `TIMEOUT` and `ABORTED` are no
 * longer emitted by `search_topic`: per-operation timeouts surface as
 * `UPSTREAM_ERROR`, and there is no whole-call deadline or caller cancellation.
 * `PAGE_LIMIT` is legacy: effort completion is a normal `ok`, so no path emits
 * it any more.
 */
export type ErrorCode =
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "ABORTED"
  | "OUTPUT_TRUNCATED"
  | "PAGE_LIMIT"
  | "RATE_LIMITED"
  | "PROVIDER_CHALLENGE"
  | "UPSTREAM_ERROR"
  | "PARSE_FAILED"
  | "NO_SEARCH_PROVIDER_AVAILABLE";

export interface SearchError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/**
 * Outcome of one complete search. `failed` means zero results and an error;
 * a successful empty search is `exhausted`.
 */
export type SearchResult =
  | { status: "ok"; results: SearchResultItem[] }
  | { status: "exhausted"; results: SearchResultItem[] }
  | { status: "interrupted"; results: SearchResultItem[]; error: SearchError }
  | { status: "failed"; results: []; error: SearchError };

const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_INPUT: false,
  TIMEOUT: true,
  ABORTED: false,
  OUTPUT_TRUNCATED: false,
  PAGE_LIMIT: false,
  RATE_LIMITED: true,
  PROVIDER_CHALLENGE: true,
  UPSTREAM_ERROR: true,
  PARSE_FAILED: true,
  NO_SEARCH_PROVIDER_AVAILABLE: true,
};

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE[code];
}

/** Builds a `SearchError`, optionally with a retry hint. */
export function makeError(
  code: ErrorCode,
  message: string,
  retryAfterMs?: number,
): SearchError {
  const error: SearchError = { code, message, retryable: isRetryable(code) };
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

/** `interrupted` with results, otherwise `failed` with none. */
export function interruptedOrFailed(
  results: SearchResultItem[],
  error: SearchError,
): SearchResult {
  if (results.length > 0) return { status: "interrupted", results, error };
  return { status: "failed", results: [], error };
}
