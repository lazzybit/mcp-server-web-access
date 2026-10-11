/**
 * Contract between the {@link SearchCoordinator} and one search transport.
 *
 * Pagination, spacing, failure state and cooldown are provider-owned; the
 * coordinator only sees availability and one complete search outcome. Provider
 * results are already normalized and ranked within the provider; the
 * coordinator merges, deduplicates, caps and reranks across providers.
 */
import type { SearchError, SearchParams, SearchResult, SearchResultItem } from "../types";

export interface ProviderAvailability {
  kind: "ready" | "cooling" | "disabled";
  /** Present when `kind === "cooling"` and recovery is known. */
  retryAfterMs?: number;
}

export type ProviderOutcome =
  /** A complete search: `ok`, `exhausted` (including zero matches) or `PAGE_LIMIT`. */
  | { kind: "done"; result: SearchResult }
  /** The provider could not complete; partial results may still be usable. */
  | { kind: "fallback"; results: SearchResultItem[]; error: SearchError };

export interface SearchProvider {
  readonly id: string;
  availability(now: number): ProviderAvailability;
  /** One complete search from the original query. Never throws. */
  search(params: SearchParams): Promise<ProviderOutcome>;
}
