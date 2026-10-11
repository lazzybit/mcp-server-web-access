/**
 * Selects a {@link SearchProvider} for each complete search and falls back
 * across providers when one is challenged or unavailable.
 *
 * One FIFO queue, one search at a time. A provider is attempted at most once
 * per search; a recovering provider is waited for at most once and only while
 * no other provider is usable. `NO_SEARCH_PROVIDER_AVAILABLE` is returned only
 * after that bounded fallback.
 */
import { COOLDOWN_WAIT_MAX_MS } from "../constants";
import { interruptedOrFailed, makeError } from "../types";
import type { SearchError, SearchParams, SearchResult, SearchResultItem } from "../types";
import { LEVEL_RANK } from "./deps";
import type { Clock, LogLevel } from "./deps";
import type { SearchProvider } from "./provider";

export interface CoordinatorDeps {
  clock: Clock;
  /** Wait at most this long for a recovering provider (inclusive). */
  cooldownWaitMaxMs: number;
  logLevel: LogLevel;
}

export function defaultCoordinatorDeps(
  clock: Clock,
  logLevel: LogLevel,
): CoordinatorDeps {
  return { clock, cooldownWaitMaxMs: COOLDOWN_WAIT_MAX_MS, logLevel };
}

interface Job {
  readonly params: SearchParams;
  readonly promise: Promise<SearchResult>;
  resolve: (result: SearchResult) => void;
  settled: boolean;
}

export class SearchCoordinator {
  readonly #providers: readonly SearchProvider[];
  readonly #deps: CoordinatorDeps;
  #queue: Job[] = [];
  #running = false;

  constructor(providers: readonly SearchProvider[], deps: CoordinatorDeps) {
    this.#providers = providers;
    this.#deps = deps;
  }

  /** Runs one complete search (called over RPC). */
  async search(params: SearchParams): Promise<SearchResult> {
    const job = this.#createJob(params);
    this.#queue.push(job);
    this.#ensureDrain();
    return job.promise;
  }

  #createJob(params: SearchParams): Job {
    let resolve: (result: SearchResult) => void = () => {};
    const promise = new Promise<SearchResult>((res) => {
      resolve = res;
    });
    return { params, promise, resolve, settled: false };
  }

  #settle(job: Job, result: SearchResult): void {
    if (job.settled) return;
    job.settled = true;
    job.resolve(result);
  }

  #ensureDrain(): void {
    if (this.#running) return;
    void this.#drainQueue().catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "search_coordinator_error",
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  async #drainQueue(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift();
        if (job === undefined) break;
        if (job.settled) continue;
        this.#settle(job, await this.#runJob(job.params));
      }
    } finally {
      this.#running = false;
      if (this.#queue.length > 0) this.#ensureDrain();
    }
  }

  async #runJob(params: SearchParams): Promise<SearchResult> {
    const startedAt = this.#now();
    const pending = this.#providers.filter(
      (provider) => provider.availability(startedAt).kind !== "disabled",
    );
    const merged: SearchResultItem[] = [];
    const seen = new Set<string>();
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const tried: string[] = [];
    let lastError: SearchError | undefined;

    try {
      for (;;) {
        const now = this.#now();

        const next = pending.find(
          (provider) =>
            !attempted.has(provider.id) &&
            provider.availability(now).kind === "ready",
        );
        if (next !== undefined) {
          attempted.add(next.id);
          tried.push(next.id);
          const outcome = await next.search(params);
          if (outcome.kind === "done") {
            collect(merged, seen, outcome.result.results, params.maxResults);
            return this.#finalize(outcome.result, merged, params, startedAt, tried);
          }
          collect(merged, seen, outcome.results, params.maxResults);
          lastError = outcome.error;
          continue;
        }

        // No usable provider: wait for the soonest recovering one, once, and
        // only when recovery is close enough to be worth it.
        const soonest = this.#soonestRecovery(pending, attempted, waited, now);
        if (
          soonest !== undefined &&
          soonest.retryAfterMs <= this.#deps.cooldownWaitMaxMs
        ) {
          if (soonest.retryAfterMs > 0) {
            await this.#deps.clock.sleep(soonest.retryAfterMs);
          }
          waited.add(soonest.provider.id);
          continue;
        }

        const error = makeError(
          "NO_SEARCH_PROVIDER_AVAILABLE",
          lastError?.message ?? "no search provider is available",
          this.#recoveryHint(this.#now()),
        );
        const result = interruptedOrFailed(merged, error);
        this.#logSearch(result, params, startedAt, tried);
        return result;
      }
    } catch (error) {
      // Provider.search never throws and clock.sleep never rejects; guard the
      // coordinator's own bookkeeping against an unexpected failure.
      const message = error instanceof Error ? error.message : String(error);
      const result = interruptedOrFailed(
        merged,
        makeError("UPSTREAM_ERROR", `unexpected coordinator failure: ${message}`),
      );
      this.#logSearch(result, params, startedAt, tried);
      return result;
    }
  }

  #finalize(
    done: SearchResult,
    merged: SearchResultItem[],
    params: SearchParams,
    startedAt: number,
    tried: string[],
  ): SearchResult {
    let result: SearchResult;
    if (done.status === "interrupted") {
      result = { status: "interrupted", results: merged, error: done.error };
    } else if (merged.length >= params.maxResults) {
      result = { status: "ok", results: merged };
    } else {
      result = { status: "exhausted", results: merged };
    }
    this.#logSearch(result, params, startedAt, tried);
    return result;
  }

  #soonestRecovery(
    pending: readonly SearchProvider[],
    attempted: ReadonlySet<string>,
    waited: ReadonlySet<string>,
    now: number,
  ): { provider: SearchProvider; retryAfterMs: number } | undefined {
    let soonest: { provider: SearchProvider; retryAfterMs: number } | undefined;
    for (const provider of pending) {
      if (attempted.has(provider.id) || waited.has(provider.id)) continue;
      const availability = provider.availability(now);
      if (availability.kind !== "cooling" || availability.retryAfterMs === undefined) {
        continue;
      }
      const retryAfterMs = Math.max(0, availability.retryAfterMs);
      if (soonest === undefined || retryAfterMs < soonest.retryAfterMs) {
        soonest = { provider, retryAfterMs };
      }
    }
    return soonest;
  }

  /** Minimum known recovery among all providers, recomputed at return time. */
  #recoveryHint(now: number): number | undefined {
    let min: number | undefined;
    for (const provider of this.#providers) {
      const availability = provider.availability(now);
      if (availability.kind !== "cooling" || availability.retryAfterMs === undefined) {
        continue;
      }
      const remaining = Math.max(0, availability.retryAfterMs);
      if (min === undefined || remaining < min) min = remaining;
    }
    return min !== undefined && min > 0 ? min : undefined;
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  #logSearch(
    result: SearchResult,
    params: SearchParams,
    startedAt: number,
    tried: string[],
  ): void {
    const level: LogLevel = result.status === "failed"
      ? "error"
      : result.status === "interrupted"
        ? "warn"
        : "info";
    this.#log(level, {
      event: "search_coordinator",
      status: result.status,
      count: result.results.length,
      requested: params.maxResults,
      providers: tried,
      elapsedMs: Math.max(0, this.#now() - startedAt),
      ...(result.status === "interrupted" || result.status === "failed"
        ? { code: result.error.code, retryAfterMs: result.error.retryAfterMs }
        : {}),
    });
  }

  #log(level: LogLevel, payload: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#deps.logLevel]) return;
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else console.log(line);
  }
}

function collect(
  out: SearchResultItem[],
  seen: Set<string>,
  incoming: SearchResultItem[],
  maxResults: number,
): void {
  for (const item of incoming) {
    if (out.length >= maxResults) return;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({
      rank: out.length + 1,
      title: item.title,
      url: item.url,
      domain: item.domain,
      snippet: item.snippet,
    });
  }
}
