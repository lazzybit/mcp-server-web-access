/**
 * Browser capability Durable Object.
 *
 * A single named instance owns one reusable Browser Run connection in memory
 * and one incognito context per operation. It never persists a session id and
 * never runs render or search itself: `openContext()` returns an
 * operation-scoped RPC target and the callers keep their own navigation,
 * extraction and policy logic. The connection closes by itself through
 * `keep_alive` inactivity, so there is no alarm, heartbeat or explicit
 * shutdown.
 */
import { DurableObject } from "cloudflare:workers";
import { BROWSER_KEEP_ALIVE_MS } from "../page/constants";
import { ReusableBrowserSession } from "./session";
import type { BrowserSessionClient } from "./session";
import { ContextTarget } from "./targets";

/** Fixed object name. */
export const BROWSER_OBJECT_NAME = "global";

export class BrowserService extends DurableObject<Env> {
  readonly #session: ReusableBrowserSession;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#session = new ReusableBrowserSession({
      binding: env.BROWSER,
      keepAliveMs: BROWSER_KEEP_ALIVE_MS,
    });
  }

  /**
   * Acquires (or reuses) the shared connection and opens one isolated incognito
   * context. The returned target owns that context only.
   */
  async openContext(): Promise<ContextTarget> {
    const context = await this.#session.openContext();
    return new ContextTarget(context);
  }

  /** Test-only seam: replace the `@cloudflare/puppeteer` client. */
  setTestDeps(overrides: { client?: BrowserSessionClient }): void {
    if (overrides.client !== undefined) this.#session.setClient(overrides.client);
  }
}
