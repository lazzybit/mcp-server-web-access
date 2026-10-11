/**
 * Session broker for Browser Run.
 *
 * A single named instance owns one reusable Browser Run session id. It acquires
 * a session only when there is none, when the stored one is confirmed absent by
 * `sessions()`, or when a caller reports a connect failure for the stored id.
 * It never runs render or search and never holds a browser object across
 * requests: the id lives in Durable Object storage, so eviction is harmless and
 * the next call reconnects.
 *
 * The session closes by itself through `keep_alive` inactivity, so there is no
 * alarm, heartbeat or explicit shutdown.
 */
import { DurableObject } from "cloudflare:workers";
import { BROWSER_KEEP_ALIVE_MS, BROWSER_LAUNCH_TIMEOUT_MS } from "../page/constants";
import { withTimeout } from "../page/timeout";
import type { BrowserSessionBroker, SessionResult } from "./session";

/** Fixed object name. */
export const BROWSER_OBJECT_NAME = "global";
/** Storage key holding the reusable session id. */
export const BROWSER_SESSION_KEY = "browser/session/v1";

/** The subset of `@cloudflare/puppeteer` the broker uses. */
export interface BrowserSessionClient {
  acquire(binding: unknown, options: { keep_alive: number }): Promise<{ sessionId: string }>;
  sessions(binding: unknown): Promise<Array<{ sessionId: string }>>;
}

export class BrowserService extends DurableObject<Env> implements BrowserSessionBroker {
  #sessionId: string | null = null;
  #client: BrowserSessionClient | null = null;
  /** One in-flight validation/acquisition shared by all concurrent callers. */
  #inflight: Promise<SessionResult> | null = null;
  readonly #binding: unknown;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#binding = env.BROWSER;
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<string>(BROWSER_SESSION_KEY);
      if (typeof stored === "string" && stored !== "") this.#sessionId = stored;
    });
  }

  /**
   * Returns the reusable session id, acquiring one when necessary.
   *
   * @param previousSessionId The id a caller just failed to connect to. When it
   * already differs from the stored id, someone replaced the session and the
   * stored id is returned without acquiring.
   */
  async getSession(previousSessionId?: string): Promise<SessionResult> {
    const current = this.#sessionId;
    if (current !== null && previousSessionId !== undefined && previousSessionId !== current) {
      return { ok: true, sessionId: current };
    }
    if (this.#inflight !== null) return this.#inflight;
    const promise = this.#resolve().finally(() => {
      if (this.#inflight === promise) this.#inflight = null;
    });
    this.#inflight = promise;
    return promise;
  }

  /** Test-only seam: replace the `@cloudflare/puppeteer` client. */
  setTestDeps(overrides: { client?: BrowserSessionClient }): void {
    if (overrides.client !== undefined) this.#client = overrides.client;
  }

  async #resolve(): Promise<SessionResult> {
    const client = await this.#getClient();
    const existing = this.#sessionId;
    if (existing !== null) {
      // Validate before replacing: an unconfirmed session must not be duplicated.
      if (await this.#isAlive(client, existing)) {
        return { ok: true, sessionId: existing };
      }
      this.#sessionId = null;
    }
    return this.#acquire(client);
  }

  /**
   * True when the session is listed, or when the listing itself failed (treated
   * as possibly alive rather than risking a duplicate session).
   */
  async #isAlive(client: BrowserSessionClient, sessionId: string): Promise<boolean> {
    try {
      const sessions = await withTimeout(
        client.sessions(this.#binding),
        BROWSER_LAUNCH_TIMEOUT_MS,
        "browser session list timed out",
      );
      return sessions.some((session) => session.sessionId === sessionId);
    } catch {
      return true;
    }
  }

  async #acquire(client: BrowserSessionClient): Promise<SessionResult> {
    try {
      const session = await withTimeout(
        client.acquire(this.#binding, { keep_alive: BROWSER_KEEP_ALIVE_MS }),
        BROWSER_LAUNCH_TIMEOUT_MS,
        "browser session acquisition timed out",
      );
      this.#sessionId = session.sessionId;
      await this.ctx.storage.put(BROWSER_SESSION_KEY, session.sessionId);
      return { ok: true, sessionId: session.sessionId };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "browser session acquisition failed",
      };
    }
  }

  async #getClient(): Promise<BrowserSessionClient> {
    if (this.#client !== null) return this.#client;
    return defaultBrowserSessionClient();
  }
}

async function defaultBrowserSessionClient(): Promise<BrowserSessionClient> {
  const module = await import("@cloudflare/puppeteer");
  const puppeteer = module.default;
  return {
    acquire: (binding, options) =>
      puppeteer.acquire(binding as never, options) as Promise<{ sessionId: string }>,
    sessions: (binding) =>
      puppeteer.sessions(binding as never) as Promise<Array<{ sessionId: string }>>,
  };
}
