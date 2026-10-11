/**
 * Generic browser capability used by both browser call sites.
 *
 * The `BrowserService` Durable Object owns the shared Browser Run connection and
 * exposes operation-scoped RPC targets. This module defines the capability
 * surface those targets satisfy, together with the launcher that turns one
 * `openContext()` call into the small operation-session shape both call sites
 * already expect. It deliberately stays free of `cloudflare:workers` so the
 * domain modules and the Node-only test project can depend on it.
 *
 * Cleanup closes only this operation's incognito context; the shared browser
 * connection is never closed.
 */
import {
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_LAUNCH_TIMEOUT_MS,
} from "../page/constants";
import { withTimeout } from "../page/timeout";

/** Serializable metadata passed to the navigation policy callback. */
export interface NavigationRequestInfo {
  /** The URL of the navigation request (after redirects so far). */
  url: string;
  /** URLs of the requests that redirected into {@link url}, oldest first. */
  redirectChain: string[];
}

/** Whether one navigation request may proceed. */
export type RequestDecision = "allow" | "abort";

/**
 * Caller-owned navigation policy. It runs in the caller's isolate and is
 * invoked by the Durable Object for every navigation request while a page is
 * open.
 */
export interface RequestPolicy {
  decide(info: NavigationRequestInfo): RequestDecision | Promise<RequestDecision>;
}

/** Options accepted by {@link PageCapability.goto}. */
export interface PageGotoOptions {
  waitUntil?: string;
  timeout?: number;
  /** Installs request interception for the page's remaining lifetime. */
  policy?: RequestPolicy;
}

/** One page inside an operation's incognito context. */
export interface PageCapability {
  goto(url: string, options?: PageGotoOptions): Promise<void>;
  content(): Promise<string>;
  url(): Promise<string>;
  /** Evaluates an in-page expression; only serializable values are returned. */
  evaluate(expression: string): Promise<unknown>;
  setUserAgent?(value: string): Promise<void>;
  setViewport?(viewport: { readonly width: number; readonly height: number }): Promise<void>;
  setExtraHTTPHeaders?(headers: Record<string, string>): Promise<void>;
  [Symbol.dispose]?(): void;
}

/** One operation's incognito context. */
export interface ContextCapability {
  newPage(): Promise<PageCapability>;
  close(): Promise<void>;
  [Symbol.dispose]?(): void;
}

/** The operation-session shape both call sites accept. */
export interface BrowserCapability {
  newPage(): Promise<PageCapability>;
  close(): Promise<void>;
}

/** A launcher opening one incognito context per operation. */
export type CapabilityLauncher = (binding?: unknown) => Promise<BrowserCapability>;

/** Timeout/binding seams for {@link createCapabilityLauncher}. */
export interface CapabilityLauncherOptions {
  /** Opens one incognito context in the shared browser; ignores its argument. */
  openContext(): Promise<ContextCapability>;
  /** Bounds `openContext`. Defaults to `BROWSER_LAUNCH_TIMEOUT_MS`. */
  launchTimeoutMs?: number;
  /** Bounds context cleanup; giving up is acceptable. Defaults to `BROWSER_CLOSE_TIMEOUT_MS`. */
  closeTimeoutMs?: number;
}

/**
 * Wraps a Durable Object `openContext` capability into the operation-session
 * launcher shape. Every call opens one context; `close()` closes only that
 * context and disposes its stub.
 */
export function createCapabilityLauncher(
  options: CapabilityLauncherOptions,
): CapabilityLauncher {
  const launchTimeoutMs = options.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;

  return async () => {
    const contextPromise = options.openContext();
    let context: ContextCapability;
    try {
      context = await withTimeout(contextPromise, launchTimeoutMs, "browser context timed out");
    } catch (error) {
      // A context that resolves after its timeout must still be closed.
      void contextPromise
        .then((late) => closeBounded(late, closeTimeoutMs))
        .catch(() => undefined);
      throw error;
    }

    return {
      newPage: () => context.newPage(),
      close: async () => {
        await closeBounded(context, closeTimeoutMs);
        context[Symbol.dispose]?.();
      },
    };
  };
}

/**
 * Serialises a self-contained in-page function into an invocation expression
 * for {@link PageCapability.evaluate}. The Worker never evaluates it itself,
 * so no `eval`/`new Function` is used here.
 */
export function serializeExpression(fn: (...args: never[]) => unknown): string {
  return `(${fn.toString()})()`;
}

/** Closes a context under a bound; a slow or hanging close never blocks. */
async function closeBounded(context: ContextCapability, ms: number): Promise<void> {
  try {
    await withTimeout(context.close(), ms, "browser context close timed out");
  } catch {
    // Giving up on close must not block the result.
  }
}
