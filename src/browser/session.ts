/**
 * Shared-session launcher used by both browser call sites.
 *
 * The `BrowserService` Durable Object is a session broker: it only resolves one
 * reusable Browser Run `sessionId`. This module turns that id into the small
 * launcher surface `fetch_page`'s renderer and the `ddg-browser` search already
 * expect, while isolating every operation in its own incognito browser context.
 *
 * It deliberately stays free of `cloudflare:workers` so it can run in the
 * Node-only test project; `@cloudflare/puppeteer` is imported lazily and can be
 * replaced through {@link SessionLauncherOptions.connect}.
 *
 * Cleanup never closes the shared browser: it closes this operation's context
 * and disconnects its own CDP connection. Closing the browser would evict the
 * session for everyone else.
 */
import {
  BROWSER_CALL_TIMEOUT_MS,
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_LAUNCH_TIMEOUT_MS,
} from "../page/constants";
import { withTimeout } from "../page/timeout";
import type { PageLike } from "../page/browser";
import type { SearchPageLike } from "../ddg/browser-search";

/** Outcome of one broker lookup. */
export type SessionResult = { ok: true; sessionId: string } | { ok: false; message: string };

/**
 * The broker surface the launcher depends on. Implemented by the
 * `BrowserService` Durable Object; a stub cannot import `cloudflare:workers`.
 */
export interface BrowserSessionBroker {
  /**
   * Returns a reusable session id.
   *
   * @param previousSessionId The id the caller just failed to use, when any.
   * A broker may return the same id (still alive) or a replacement.
   */
  getSession(previousSessionId?: string): Promise<SessionResult>;
}

/** The page surface shared by both launchers. */
export type SessionPage = PageLike & SearchPageLike;

/** One incognito context. */
export interface SessionContextLike {
  newPage(): Promise<SessionPage>;
  close(): Promise<void>;
}

/** A CDP connection to the shared session. */
export interface ConnectedSessionBrowser {
  createBrowserContext(): Promise<SessionContextLike>;
  disconnect(): Promise<void>;
}

/** Injectable connect seam; defaults to `puppeteer.connect`. */
export type SessionConnect = (
  binding: unknown,
  sessionId: string,
) => Promise<ConnectedSessionBrowser>;

/** The launcher both `BrowserLauncher` and `SearchBrowserLauncher` accept. */
export interface SessionBrowserLike {
  newPage(): Promise<SessionPage>;
  close(): Promise<void>;
}

export type SessionLauncher = (binding: unknown) => Promise<SessionBrowserLike>;

export interface SessionLauncherOptions {
  broker: BrowserSessionBroker;
  /** The `BROWSER` binding captured for the whole launcher lifetime. */
  binding: unknown;
  /** Test/override hook; defaults to `@cloudflare/puppeteer`. */
  connect?: SessionConnect;
  /** Bounds session acquisition. Defaults to `BROWSER_LAUNCH_TIMEOUT_MS`. */
  launchTimeoutMs?: number;
  /** Bounds connect and context creation. Defaults to `BROWSER_CALL_TIMEOUT_MS`. */
  callTimeoutMs?: number;
  /** Bounds cleanup; giving up is acceptable. Defaults to `BROWSER_CLOSE_TIMEOUT_MS`. */
  closeTimeoutMs?: number;
}

/** Tuning passed down to the connect/refresh helpers. */
interface SessionTimeouts {
  launchTimeoutMs: number;
  callTimeoutMs: number;
  closeTimeoutMs: number;
}

/**
 * Builds a launcher that resolves the shared session and opens one incognito
 * context per call. The returned object satisfies both call sites' launcher
 * types; the `binding` argument is ignored in favour of the captured binding.
 */
export function createSessionLauncher(options: SessionLauncherOptions): SessionLauncher {
  const timeouts: SessionTimeouts = {
    launchTimeoutMs: options.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS,
    callTimeoutMs: options.callTimeoutMs ?? BROWSER_CALL_TIMEOUT_MS,
    closeTimeoutMs: options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS,
  };
  const broker = options.broker;
  const binding = options.binding;

  return async () => {
    const session = await acquireSession(broker, timeouts.launchTimeoutMs);
    const connect = await resolveConnect(options.connect);
    const browser = await connectWithRefresh(
      connect,
      broker,
      binding,
      session.sessionId,
      timeouts,
    );

    const contextPromise = browser.createBrowserContext();
    let context: SessionContextLike;
    try {
      context = await withTimeout(contextPromise, timeouts.callTimeoutMs, "browser context timed out");
    } catch (error) {
      // A context that resolves after its timeout still gets closed; the
      // handler is attached before the disconnect so it can reach Chrome.
      void contextPromise
        .then((late) => closeBounded(late, timeouts.closeTimeoutMs))
        .catch(() => undefined);
      await disconnectBounded(browser, timeouts.closeTimeoutMs);
      throw error;
    }

    return {
      newPage: () => context.newPage(),
      close: async () => {
        await closeBounded(context, timeouts.closeTimeoutMs);
        await disconnectBounded(browser, timeouts.closeTimeoutMs);
      },
    };
  };
}

/** Asks the broker for a session; a broker failure aborts the operation. */
async function acquireSession(
  broker: BrowserSessionBroker,
  ms: number,
  previousSessionId?: string,
): Promise<{ ok: true; sessionId: string }> {
  let result: SessionResult;
  try {
    result = await withTimeout(
      broker.getSession(previousSessionId),
      ms,
      "browser session timed out",
    );
  } catch {
    throw new Error("browser session timed out");
  }
  if (!result.ok) throw new Error(result.message);
  return result;
}

/**
 * Connects once and, on failure, asks the broker to refresh exactly once.
 * A replacement is only tried when the broker actually returns a different id,
 * so a genuinely dead session is never connected to twice.
 */
async function connectWithRefresh(
  connect: SessionConnect,
  broker: BrowserSessionBroker,
  binding: unknown,
  sessionId: string,
  timeouts: SessionTimeouts,
): Promise<ConnectedSessionBrowser> {
  const first = connect(binding, sessionId);
  try {
    return await withTimeout(first, timeouts.callTimeoutMs, "browser connect timed out");
  } catch (error) {
    // A connection that resolves after its timeout must still be released.
    void first
      .then((late) => disconnectBounded(late, timeouts.closeTimeoutMs))
      .catch(() => undefined);
    const refreshed = await acquireSession(broker, timeouts.launchTimeoutMs, sessionId);
    if (refreshed.sessionId === sessionId) throw error;

    const second = connect(binding, refreshed.sessionId);
    try {
      return await withTimeout(second, timeouts.callTimeoutMs, "browser connect timed out");
    } catch (retryError) {
      void second
        .then((late) => disconnectBounded(late, timeouts.closeTimeoutMs))
        .catch(() => undefined);
      throw retryError;
    }
  }
}

async function resolveConnect(provided?: SessionConnect): Promise<SessionConnect> {
  if (provided !== undefined) return provided;
  const module = await import("@cloudflare/puppeteer");
  const connect = module.default.connect;
  return (binding: unknown, sessionId: string) =>
    connect(binding as never, sessionId) as unknown as Promise<ConnectedSessionBrowser>;
}

/** Closes a context under a bound; a slow or hanging close never blocks. */
async function closeBounded(context: SessionContextLike, ms: number): Promise<void> {
  try {
    await withTimeout(context.close(), ms, "browser context close timed out");
  } catch {
    // Giving up on close must not block the result.
  }
}

/** Disconnects this operation's CDP connection under a bound. */
async function disconnectBounded(
  browser: ConnectedSessionBrowser,
  ms: number,
): Promise<void> {
  try {
    await withTimeout(browser.disconnect(), ms, "browser disconnect timed out");
  } catch {
    // Giving up on disconnect must not block the result.
  }
}
