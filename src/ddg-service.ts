import { DurableObject } from "cloudflare:workers";
import { DdgEngine, defaultDdgDeps } from "./ddg/engine";
import type { Clock, DdgDeps, StoragePort } from "./ddg/engine";
import { searchViaBrowser } from "./ddg/browser-search";
import type { BrowserSearchDeps } from "./ddg/browser-search";
import { makeError } from "./types";
import type { SearchError, SearchParams, SearchResult } from "./types";
import type { AppEnv } from "./env";

export type { CancelTimer, Clock, DdgDeps, StoragePort } from "./ddg/engine";
export { RealClock, defaultDdgDeps } from "./ddg/engine";

/** Fixed object name. */
export const DDG_OBJECT_NAME = "global";

interface BrowserFallbackState {
  enabled: boolean;
  deps: BrowserSearchDeps;
}

/**
 * Global singleton Durable Object. It supplies the storage port and lifecycle;
 * the queue, adaptive pacing, retries and cooldown live in {@link DdgEngine}.
 * When the engine rejects with `RATE_LIMITED`, a serialized browser fallback
 * runs instead of returning the rate limit.
 */
export class DdgService extends DurableObject<Env> {
  readonly #engine: DdgEngine;
  #clock: Clock;
  #browser: BrowserFallbackState;
  /** FIFO tail: one browser fallback at a time, surviving a failed task. */
  #browserTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config: AppEnv = env;
    const storage: StoragePort = {
      get: <T>(key: string) => ctx.storage.get<T>(key),
      put: <T>(key: string, value: T) => ctx.storage.put(key, value),
    };
    const deps = defaultDdgDeps(config);
    this.#clock = deps.clock;
    this.#engine = new DdgEngine(storage, deps);
    const binding = config.BROWSER;
    this.#browser = {
      enabled: (config.BROWSER_ENABLED ?? "true") !== "false" && binding !== undefined,
      deps: binding !== undefined ? { binding } : {},
    };
    // The constructor's storage read stays platform-managed
    // (`blockConcurrencyWhile`); everything else is per-operation timeouts.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.#engine.load();
    });
  }

  /** Runs one complete search (called over RPC). */
  async search(params: SearchParams): Promise<SearchResult> {
    const result = await this.#engine.search(params);
    if (!this.#browser.enabled) return result;
    if (result.status !== "failed" || result.error.code !== "RATE_LIMITED") return result;
    return this.#runBrowserFallback(params, result.error);
  }

  /** Test seam for `runInDurableObject` tests. */
  setTestDeps(overrides: Partial<DdgDeps>): void {
    this.#engine.setDeps(overrides);
    if (overrides.clock !== undefined) this.#clock = overrides.clock;
  }

  /** Test seam: force-enables the browser fallback with injected dependencies. */
  setTestBrowserDeps(overrides: Partial<BrowserSearchDeps>): void {
    this.#browser = {
      enabled: true,
      deps: { ...this.#browser.deps, ...overrides },
    };
  }

  /** Reads the persisted cooldown (test/diagnostic use). */
  getNextRetryAt(): number {
    return this.#engine.getNextRetryAt();
  }

  /** Reads the current adaptive pacing interval (test/diagnostic use). */
  getIntervalMs(): number {
    return this.#engine.getIntervalMs();
  }

  /** Reads the consecutive upstream failure streak (test/diagnostic use). */
  getConsecutiveFailures(): number {
    return this.#engine.getConsecutiveFailures();
  }

  /** Serializes fallbacks: the next one starts only after the previous settles. */
  #runBrowserFallback(params: SearchParams, original: SearchError): Promise<SearchResult> {
    const task = this.#browserTail.then(
      () => this.#fallbackOnce(params, original),
      () => this.#fallbackOnce(params, original),
    );
    this.#browserTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #fallbackOnce(params: SearchParams, original: SearchError): Promise<SearchResult> {
    const startedAt = this.#clock.now();
    let result: SearchResult;
    try {
      result = (await searchViaBrowser(params, this.#browser.deps)).result;
    } catch {
      // `searchViaBrowser` maps its own failures; guard against adapter bugs.
      result = { status: "failed", results: [], error: original };
    }
    // A zero-result browser failure keeps the original rate limit, with the
    // retry hint recomputed from the current cooldown so a delayed reply does
    // not carry a stale remaining time.
    const mapped = result.status === "failed" && result.results.length === 0
      ? this.#rateLimitedFromEngine(original)
      : result;
    this.#logBrowserFallback(mapped, startedAt);
    return mapped;
  }

  #rateLimitedFromEngine(original: SearchError): SearchResult {
    const remaining = Math.max(0, this.#engine.getNextRetryAt() - this.#clock.now());
    const error = makeError(
      "RATE_LIMITED",
      original.message,
      remaining > 0 ? remaining : undefined,
    );
    return { status: "failed", results: [], error };
  }

  /** One JSON line per fallback; never logs the query or result URLs. */
  #logBrowserFallback(result: SearchResult, startedAt: number): void {
    const payload: Record<string, unknown> = {
      event: "ddg_browser_fallback",
      status: result.status,
      count: result.results.length,
      elapsedMs: Math.max(0, this.#clock.now() - startedAt),
    };
    if (result.status === "failed" || result.status === "interrupted") {
      payload["code"] = result.error.code;
    }
    const line = JSON.stringify(payload);
    if (result.status === "failed") console.error(line);
    else console.log(line);
  }
}
