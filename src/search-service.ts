import { DurableObject } from "cloudflare:workers";
import { BROWSER_OBJECT_NAME } from "./browser/service";
import type { BrowserSearchDeps } from "./ddg/browser-search";
import type { AppEnv } from "./env";
import { SearchCoordinator, defaultCoordinatorDeps } from "./search/coordinator";
import { RealClock, SharedClock } from "./search/deps";
import type { Clock, StoragePort } from "./search/deps";
import {
  DdgHtmlSearchProvider,
  defaultHtmlDeps,
} from "./search/ddg-html-provider";
import type { DdgHtmlDeps } from "./search/ddg-html-provider";
import {
  DdgBrowserSearchProvider,
  defaultBrowserDeps,
} from "./search/ddg-browser-provider";
import type { SearchParams, SearchResult } from "./types";

export type { CancelTimer, Clock, LogLevel, ParseFn, StoragePort } from "./search/deps";
export { RealClock, SharedClock } from "./search/deps";

/** Fixed object name. */
export const SEARCH_OBJECT_NAME = "global";

/**
 * Global singleton Durable Object. It supplies the storage port and lifecycle;
 * provider selection, the FIFO queue and bounded fallback live in
 * {@link SearchCoordinator}.
 *
 * The HTML provider always exists. The browser provider always exists too but
 * reports `disabled` when `BROWSER_ENABLED === "false"` or the binding is
 * absent, so the coordinator simply skips it.
 */
export class SearchService extends DurableObject<Env> {
  #clock: Clock;
  readonly #html: DdgHtmlSearchProvider;
  readonly #browser: DdgBrowserSearchProvider;
  readonly #coordinator: SearchCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config: AppEnv = env;
    const storage: StoragePort = {
      get: <T>(key: string) => ctx.storage.get<T>(key),
      put: <T>(key: string, value: T) => ctx.storage.put(key, value),
    };
    // One clock instance shared by both providers and the coordinator so a test
    // seam can swap it once.
    this.#clock = new RealClock();
    const shared = new SharedClock(() => this.#clock);
    const htmlDeps = defaultHtmlDeps(config, shared);
    this.#html = new DdgHtmlSearchProvider(storage, htmlDeps);
    this.#browser = new DdgBrowserSearchProvider(
      storage,
      defaultBrowserDeps(
        config,
        this.env.BROWSER_SERVICE.getByName(BROWSER_OBJECT_NAME),
        shared,
      ),
    );
    this.#coordinator = new SearchCoordinator(
      [this.#html, this.#browser],
      defaultCoordinatorDeps(shared, htmlDeps.logLevel),
    );
    // The constructor's storage reads stay platform-managed
    // (`blockConcurrencyWhile`); everything else is per-operation timeouts.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.#html.load();
      await this.#browser.load();
    });
  }

  /** Runs one complete search (called over RPC). */
  async search(params: SearchParams): Promise<SearchResult> {
    return this.#coordinator.search(params);
  }

  /** Test seam for `runInDurableObject` tests. */
  setTestDeps(overrides: Partial<DdgHtmlDeps>): void {
    const { clock, ...rest } = overrides;
    if (clock !== undefined) this.#clock = clock;
    this.#html.setDeps(rest);
  }

  /** Test seam: force-enables the browser provider with injected dependencies. */
  setTestBrowserDeps(overrides: Partial<BrowserSearchDeps>): void {
    this.#browser.setDeps({ enabled: true });
    this.#browser.setBrowserDeps(overrides);
  }

  /** Reads the HTML provider's persisted cooldown (test/diagnostic use). */
  getNextRetryAt(): number {
    return this.#html.getNextRetryAt();
  }

  /** Reads the browser provider's persisted cooldown (test/diagnostic use). */
  getBrowserNextRetryAt(): number {
    return this.#browser.getNextRetryAt();
  }
}
