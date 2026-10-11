/**
 * Reusable Browser Run session.
 *
 * One cached CDP connection is retained in memory for the lifetime of the
 * Durable Object instance and shared by every operation; each operation gets
 * its own incognito context, so cookies and storage never leak. The session id
 * is never persisted: after eviction or `keep_alive` expiry the next operation
 * acquires a new one.
 *
 * Every potentially hanging RPC is bounded, and cleanup is bounded too. A
 * connection that is no longer `connected` is invalidated by identity and
 * replaced once; only a failed context creation on an established connection
 * loss is retried, and navigation is never replayed.
 *
 * The module deliberately stays free of `cloudflare:workers` so it can run in
 * the Node-only test project; `@cloudflare/puppeteer` is imported lazily and
 * can be replaced through {@link ReusableBrowserSession.setClient}.
 */
import {
  BROWSER_CALL_TIMEOUT_MS,
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_KEEP_ALIVE_MS,
  BROWSER_LAUNCH_TIMEOUT_MS,
} from "../page/constants";
import { withTimeout } from "../page/timeout";

/** The subset of Puppeteer `Browser` the reusable session needs. */
export interface ReusableBrowser {
  readonly connected: boolean;
  createBrowserContext(): Promise<ReusableContext>;
  disconnect(): Promise<void>;
}

/** The subset of Puppeteer `BrowserContext` the reusable session needs. */
export interface ReusableContext {
  newPage(): Promise<ReusablePage>;
  close(): Promise<void>;
}

/** The subset of Puppeteer `Page` the browser capability wraps. */
export interface ReusablePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  setRequestInterception(value: boolean): Promise<void>;
  on(event: "request", handler: (request: ReusableRequest) => void): unknown;
  evaluate(expression: string): Promise<unknown>;
  setUserAgent?(value: string): Promise<void>;
  setViewport?(viewport: { readonly width: number; readonly height: number }): Promise<void>;
  setExtraHTTPHeaders?(headers: Record<string, string>): Promise<void>;
}

/** The subset of Puppeteer `HTTPRequest` interception uses. */
export interface ReusableRequest {
  isNavigationRequest(): boolean;
  url(): string;
  redirectChain(): ReusableRequest[];
  continue(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Injectable Browser Run client. The default implementation lazily imports
 * `@cloudflare/puppeteer`; tests and the Durable Object inject their own.
 */
export interface BrowserSessionClient {
  acquire(binding: unknown, options: { keep_alive: number }): Promise<{ sessionId: string }>;
  connect(binding: unknown, sessionId: string): Promise<ReusableBrowser>;
}

/** Construction seams for {@link ReusableBrowserSession}. */
export interface ReusableBrowserSessionOptions {
  /** The `BROWSER` binding captured for the whole session lifetime. */
  binding: unknown;
  /** Test/override hook; defaults to `@cloudflare/puppeteer`. */
  client?: BrowserSessionClient;
  /** Idle window handed to Browser Run. Defaults to `BROWSER_KEEP_ALIVE_MS`. */
  keepAliveMs?: number;
  /** Bounds acquisition. Defaults to `BROWSER_LAUNCH_TIMEOUT_MS`. */
  launchTimeoutMs?: number;
  /** Bounds connect and context creation. Defaults to `BROWSER_CALL_TIMEOUT_MS`. */
  callTimeoutMs?: number;
  /** Bounds cleanup; giving up is acceptable. Defaults to `BROWSER_CLOSE_TIMEOUT_MS`. */
  closeTimeoutMs?: number;
}

interface SessionTimeouts {
  launchTimeoutMs: number;
  callTimeoutMs: number;
  closeTimeoutMs: number;
}

/**
 * Retains one Browser Run connection and opens one incognito context per
 * operation. Safe to share: concurrent operations reuse the same connection
 * but never the same context.
 */
export class ReusableBrowserSession {
  #client: BrowserSessionClient | null;
  #browser: ReusableBrowser | null = null;
  /** One in-flight acquisition/connect shared by all concurrent callers. */
  #connecting: Promise<ReusableBrowser> | null = null;
  readonly #binding: unknown;
  readonly #keepAliveMs: number;
  readonly #timeouts: SessionTimeouts;

  constructor(options: ReusableBrowserSessionOptions) {
    this.#binding = options.binding;
    this.#client = options.client ?? null;
    this.#keepAliveMs = options.keepAliveMs ?? BROWSER_KEEP_ALIVE_MS;
    this.#timeouts = {
      launchTimeoutMs: options.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS,
      callTimeoutMs: options.callTimeoutMs ?? BROWSER_CALL_TIMEOUT_MS,
      closeTimeoutMs: options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS,
    };
  }

  /** Test-only seam: replace the `@cloudflare/puppeteer` client. */
  setClient(client: BrowserSessionClient): void {
    this.#client = client;
  }

  /**
   * Opens one incognito context on the shared connection. On a failed context
   * creation it recovers at most once, and only when the connection is known
   * to be lost.
   */
  async openContext(): Promise<ReusableContext> {
    const browser = await this.#current();
    try {
      return await this.#createContext(browser);
    } catch (error) {
      if (browser.connected) throw error;
      // The cached connection dropped mid-operation; reconnect once. The
      // domain layer owns navigation, so nothing is replayed here.
      const refreshed = await this.#current();
      return this.#createContext(refreshed);
    }
  }

  /**
   * Returns the cached connection when it is still connected; otherwise
   * invalidates it and acquires a replacement. A single in-flight
   * acquisition/connect is shared by all concurrent callers.
   */
  async #current(): Promise<ReusableBrowser> {
    const cached = this.#browser;
    if (cached !== null) {
      if (cached.connected) return cached;
      this.#invalidate(cached);
    }
    return this.#connect();
  }

  #connect(): Promise<ReusableBrowser> {
    if (this.#connecting !== null) return this.#connecting;
    const promise = this.#acquireAndConnect().finally(() => {
      if (this.#connecting === promise) this.#connecting = null;
    });
    this.#connecting = promise;
    return promise;
  }

  async #acquireAndConnect(): Promise<ReusableBrowser> {
    const client = await this.#getClient();
    const session = await withTimeout(
      client.acquire(this.#binding, { keep_alive: this.#keepAliveMs }),
      this.#timeouts.launchTimeoutMs,
      "browser session acquisition timed out",
    );

    const connectPromise = client.connect(this.#binding, session.sessionId);
    let browser: ReusableBrowser;
    try {
      browser = await withTimeout(
        connectPromise,
        this.#timeouts.callTimeoutMs,
        "browser connect timed out",
      );
    } catch (error) {
      // A connection that resolves after its timeout must still be released.
      void connectPromise
        .then((late) => this.#disconnect(late))
        .catch(() => undefined);
      throw error;
    }
    this.#browser = browser;
    return browser;
  }

  async #createContext(browser: ReusableBrowser): Promise<ReusableContext> {
    const contextPromise = browser.createBrowserContext();
    try {
      return await withTimeout(
        contextPromise,
        this.#timeouts.callTimeoutMs,
        "browser context timed out",
      );
    } catch (error) {
      // A context that resolves after its timeout must still be closed.
      void contextPromise
        .then((late) => this.#closeContext(late))
        .catch(() => undefined);
      throw error;
    }
  }

  /** Drops a stale cached connection without touching a newer replacement. */
  #invalidate(browser: ReusableBrowser): void {
    if (this.#browser === browser) this.#browser = null;
    void this.#disconnect(browser);
  }

  async #disconnect(browser: ReusableBrowser): Promise<void> {
    try {
      await withTimeout(
        browser.disconnect(),
        this.#timeouts.closeTimeoutMs,
        "browser disconnect timed out",
      );
    } catch {
      // Giving up on disconnect must not block the result.
    }
  }

  async #closeContext(context: ReusableContext): Promise<void> {
    try {
      await withTimeout(
        context.close(),
        this.#timeouts.closeTimeoutMs,
        "browser context close timed out",
      );
    } catch {
      // Giving up on close must not block the result.
    }
  }

  async #getClient(): Promise<BrowserSessionClient> {
    if (this.#client !== null) return this.#client;
    return defaultBrowserSessionClient();
  }
}

/** Lazily loads the real Browser Run client. */
async function defaultBrowserSessionClient(): Promise<BrowserSessionClient> {
  const module = await import("@cloudflare/puppeteer");
  const puppeteer = module.default;
  return {
    acquire: (binding, options) =>
      puppeteer.acquire(binding as never, options) as Promise<{ sessionId: string }>,
    connect: async (binding, sessionId) =>
      (await puppeteer.connect(
        binding as never,
        sessionId,
      )) as unknown as ReusableBrowser,
  };
}
