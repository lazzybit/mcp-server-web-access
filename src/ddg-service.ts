import { DurableObject } from "cloudflare:workers";
import { DdgEngine, defaultDdgDeps } from "./ddg/engine";
import type { DdgDeps, StoragePort } from "./ddg/engine";
import type { SearchParams, SearchResult } from "./types";

export type { CancelTimer, Clock, DdgDeps, StoragePort } from "./ddg/engine";
export { RealClock, defaultDdgDeps } from "./ddg/engine";

/** Fixed object name. */
export const DDG_OBJECT_NAME = "global";

/**
 * Global singleton Durable Object. It supplies the storage port and lifecycle;
 * the queue, adaptive pacing, retries and cooldown live in {@link DdgEngine}.
 */
export class DdgService extends DurableObject<Env> {
  readonly #engine: DdgEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage: StoragePort = {
      get: <T>(key: string) => ctx.storage.get<T>(key),
      put: <T>(key: string, value: T) => ctx.storage.put(key, value),
    };
    this.#engine = new DdgEngine(storage, defaultDdgDeps(env));
    // The constructor's storage read stays platform-managed
    // (`blockConcurrencyWhile`); everything else is per-operation timeouts.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.#engine.load();
    });
  }

  /** Runs one complete search (called over RPC). */
  async search(params: SearchParams): Promise<SearchResult> {
    return this.#engine.search(params);
  }

  /** Test seam for `runInDurableObject` tests. */
  setTestDeps(overrides: Partial<DdgDeps>): void {
    this.#engine.setDeps(overrides);
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
}
