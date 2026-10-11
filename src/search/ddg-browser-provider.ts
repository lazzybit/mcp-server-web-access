/**
 * Browser transport as a {@link SearchProvider}.
 *
 * Wraps {@link searchViaBrowser}, which already bounds every operation and
 * always closes the session. The provider adds its own independent cooldown
 * under `search/providers/v2/ddg-browser/state` and serializes searches so only
 * one browser session runs at a time.
 */
import { COOLDOWN_MS, TRANSIENT_DELAY_MS } from "../constants";
import { searchViaBrowser } from "../ddg/browser-search";
import type { BrowserSearchDeps } from "../ddg/browser-search";
import { makeError } from "../types";
import type { AppEnv } from "../env";
import type { SearchError, SearchParams, SearchResult, SearchResultItem } from "../types";
import { LEVEL_RANK, RealClock } from "./deps";
import type { Clock, LogLevel, StoragePort } from "./deps";
import type { ProviderAvailability, ProviderOutcome, SearchProvider } from "./provider";

export const DDG_BROWSER_PROVIDER_ID = "ddg-browser";
export const DDG_BROWSER_STATE_KEY = "search/providers/v2/ddg-browser/state";

/** Browser provider dependencies (injectable). */
export interface DdgBrowserDeps {
  clock: Clock;
  browser: BrowserSearchDeps;
  enabled: boolean;
  cooldownMs: number;
  transientDelayMs: number;
  logLevel: LogLevel;
}

/** One atomic snapshot of the provider policy, stored under a single key. */
interface BrowserPersistedState {
  v: 1;
  nextRetryAt: number;
}

export function defaultBrowserDeps(
  env: AppEnv,
  clock: Clock = new RealClock(),
): DdgBrowserDeps {
  return {
    clock,
    browser: env.BROWSER !== undefined ? { binding: env.BROWSER } : {},
    enabled: (env.BROWSER_ENABLED ?? "true") !== "false" && env.BROWSER !== undefined,
    cooldownMs: COOLDOWN_MS,
    transientDelayMs: TRANSIENT_DELAY_MS,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

export class DdgBrowserSearchProvider implements SearchProvider {
  readonly id = DDG_BROWSER_PROVIDER_ID;
  readonly #storage: StoragePort;
  #deps: DdgBrowserDeps;
  #nextRetryAt = 0;
  #persisted: BrowserPersistedState;
  /** FIFO tail: one browser search at a time, surviving a failed task. */
  #tail: Promise<void> = Promise.resolve();

  constructor(storage: StoragePort, deps: DdgBrowserDeps) {
    this.#storage = storage;
    this.#deps = deps;
    this.#persisted = this.#snapshot();
  }

  /** Loads the persisted cooldown. Idempotent. */
  async load(): Promise<void> {
    const stored = await this.#storage.get<BrowserPersistedState>(DDG_BROWSER_STATE_KEY);
    if (stored === undefined || stored.v !== 1) return;
    if (
      typeof stored.nextRetryAt === "number" &&
      Number.isFinite(stored.nextRetryAt) &&
      stored.nextRetryAt >= 0
    ) {
      this.#nextRetryAt = stored.nextRetryAt;
    }
    this.#persisted = this.#snapshot();
  }

  /** Test-only seam: override policy/browser dependencies. */
  setDeps(overrides: Partial<DdgBrowserDeps>): void {
    this.#deps = { ...this.#deps, ...overrides };
  }

  /** Test-only seam: override the browser adapter dependencies. */
  setBrowserDeps(overrides: Partial<BrowserSearchDeps>): void {
    this.#deps = { ...this.#deps, browser: { ...this.#deps.browser, ...overrides } };
  }

  getNextRetryAt(): number {
    return this.#nextRetryAt;
  }

  availability(now: number): ProviderAvailability {
    if (!this.#deps.enabled) return { kind: "disabled" };
    const remaining = this.#nextRetryAt - now;
    if (remaining > 0) return { kind: "cooling", retryAfterMs: remaining };
    return { kind: "ready" };
  }

  /** Queues one browser search; concurrent calls run one at a time, in order. */
  async search(params: SearchParams): Promise<ProviderOutcome> {
    const startedAt = this.#now();
    const task = this.#tail.then(
      () => this.#run(params),
      () => this.#run(params),
    );
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    const outcome = await task;
    this.#logOutcome(outcome, startedAt);
    return outcome;
  }

  async #run(params: SearchParams): Promise<ProviderOutcome> {
    let result: SearchResult;
    try {
      result = (await searchViaBrowser(params, this.#deps.browser)).result;
    } catch {
      // `searchViaBrowser` maps its own failures; guard against adapter bugs.
      result = {
        status: "failed",
        results: [],
        error: makeError("UPSTREAM_ERROR", "browser search failed"),
      };
    }

    // `ok` and `exhausted` are complete. A page limit is bounded and complete.
    if (result.status === "ok" || result.status === "exhausted") {
      return { kind: "done", result };
    }
    if (result.status === "interrupted" && result.error.code === "PAGE_LIMIT") {
      return { kind: "done", result };
    }
    // Challenge / other failure (including a mid-pagination one with usable
    // items) hands partial results to the coordinator and opens a cooldown.
    return this.#fallback(result.results, result.error);
  }

  #fallback(results: SearchResultItem[], cause: SearchError): ProviderOutcome {
    const cooldown = cause.code === "PROVIDER_CHALLENGE"
      ? this.#deps.cooldownMs
      : this.#deps.transientDelayMs;
    this.#nextRetryAt = this.#now() + cooldown;
    this.#persistState();
    const error: SearchError = makeError(cause.code, cause.message, cooldown);
    return { kind: "fallback", results, error };
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  #snapshot(): BrowserPersistedState {
    return { v: 1, nextRetryAt: this.#nextRetryAt };
  }

  #sameState(left: BrowserPersistedState, right: BrowserPersistedState): boolean {
    return left.v === right.v && left.nextRetryAt === right.nextRetryAt;
  }

  #persistState(): void {
    const next = this.#snapshot();
    if (this.#sameState(this.#persisted, next)) return;
    void this.#storage.put(DDG_BROWSER_STATE_KEY, next).then(
      () => {
        this.#persisted = next;
      },
      (error: unknown) => {
        this.#log("error", {
          event: "search_storage_error",
          provider: this.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  #logOutcome(outcome: ProviderOutcome, startedAt: number): void {
    const status = outcome.kind === "done"
      ? outcome.result.status
      : outcome.results.length > 0
        ? "interrupted"
        : "failed";
    const count = outcome.kind === "done"
      ? outcome.result.results.length
      : outcome.results.length;
    const code = outcome.kind === "done"
      ? outcome.result.status === "interrupted"
        ? outcome.result.error.code
        : undefined
      : outcome.error.code;
    const level: LogLevel = status === "failed"
      ? "error"
      : status === "interrupted"
        ? "warn"
        : "info";
    this.#log(level, {
      event: "search_provider",
      provider: this.id,
      status,
      count,
      elapsedMs: Math.max(0, this.#now() - startedAt),
      ...(code !== undefined ? { code } : {}),
    });
  }

  #log(level: LogLevel, payload: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#deps.logLevel]) return;
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else console.log(line);
  }
}
