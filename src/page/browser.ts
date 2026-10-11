/**
 * Browser rendering used only when the decision model says the static HTML is
 * an app shell.
 *
 * At most one render per tool call. Navigation requests (including redirect
 * chains) are validated against the URL policy when request interception is
 * available. Requests issued by page scripts, frames and XHR are outside this
 * boundary and are documented as such, not claimed to be covered.
 *
 * Every browser RPC that can hang is bounded by its own timeout; closing is
 * bounded and allowed to give up rather than block the tool result.
 */
import {
  BROWSER_CALL_TIMEOUT_MS,
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_LAUNCH_TIMEOUT_MS,
  BROWSER_NAV_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  RENDERED_WAIT_MS,
} from "./constants";
import { sleep, withTimeout } from "./timeout";
import { isAllowedUrlString } from "./ssrf";
import { PageFailure, pageFailure } from "./types";

export interface RequestLike {
  isNavigationRequest(): boolean;
  url(): string;
  redirectChain(): RequestLike[];
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export interface PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  setRequestInterception?(value: boolean): Promise<void>;
  on(event: "request", handler: (request: RequestLike) => void): unknown;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export type BrowserLauncher = (binding: unknown) => Promise<BrowserLike>;

export interface RenderOptions {
  /** The `BROWSER` binding, forwarded to the launcher. */
  binding?: unknown;
  /** The statically resolved final URL to navigate to. */
  url: string;
  launch?: BrowserLauncher;
  maxRedirects?: number;
  /** Bounds the launch. Defaults to `BROWSER_LAUNCH_TIMEOUT_MS`. */
  launchTimeoutMs?: number;
  /** Bounds `newPage`, setup and `content`. Defaults to `BROWSER_CALL_TIMEOUT_MS`. */
  callTimeoutMs?: number;
  /** Bounds `close`; giving up is acceptable. Defaults to `BROWSER_CLOSE_TIMEOUT_MS`. */
  closeTimeoutMs?: number;
}

export interface RenderOutcome {
  html: string;
  finalUrl: string;
}

/** Renders `url` once; throws {@link PageFailure} on any failure. */
export async function renderPage(options: RenderOptions): Promise<RenderOutcome> {
  const launch = await resolveLauncher(options.launch);
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const launchTimeoutMs = options.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? BROWSER_CALL_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;

  const launchPromise = launch(options.binding);
  let browser: BrowserLike;
  try {
    browser = await withTimeout(launchPromise, launchTimeoutMs, "browser launch timed out");
  } catch {
    // The launch may still resolve; close it so no session leaks.
    void launchPromise
      .then((late) => closeBounded(late, closeTimeoutMs))
      .catch(() => undefined);
    throw pageFailure("RENDER_FAILED", "browser launch timed out");
  }

  try {
    const page = await withTimeout(
      browser.newPage(),
      callTimeoutMs,
      "browser page creation timed out",
    );
    if (typeof page.setRequestInterception === "function") {
      try {
        await withTimeout(
          page.setRequestInterception(true),
          callTimeoutMs,
          "browser setup timed out",
        );
        page.on("request", (request) => interceptRequest(request, maxRedirects));
      } catch {
        // Interception is best-effort; the final URL is still validated below.
      }
    }

    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_NAV_TIMEOUT_MS,
    });

    // The settling wait is intentional, not a timeout; it always runs in full.
    await sleep(RENDERED_WAIT_MS);

    const html = await withTimeout(
      page.content(),
      callTimeoutMs,
      "browser content timed out",
    );
    if (byteLength(html) > MAX_BODY_BYTES) {
      throw pageFailure("TOO_LARGE", `rendered HTML exceeds ${MAX_BODY_BYTES} bytes`);
    }

    const finalUrl = page.url();
    if (!isAllowedUrlString(finalUrl)) {
      throw pageFailure("BLOCKED_URL", "browser navigated to a disallowed URL");
    }
    return { html, finalUrl };
  } catch (error) {
    if (error instanceof PageFailure) throw error;
    throw pageFailure("RENDER_FAILED", "browser rendering failed");
  } finally {
    await closeBounded(browser, closeTimeoutMs);
  }
}

async function resolveLauncher(provided?: BrowserLauncher): Promise<BrowserLauncher> {
  if (provided !== undefined) return provided;
  const module = await import("@cloudflare/puppeteer");
  const launch = module.default.launch;
  return (binding: unknown) =>
    launch(binding as never) as unknown as Promise<BrowserLike>;
}

function interceptRequest(request: RequestLike, maxRedirects: number): void {
  if (!request.isNavigationRequest()) {
    void request.continue().catch(() => undefined);
    return;
  }
  const chain = [...request.redirectChain().map((entry) => entry.url()), request.url()];
  const allowed =
    chain.length <= maxRedirects + 1 && chain.every((url) => isAllowedUrlString(url));
  if (allowed) {
    void request.continue().catch(() => undefined);
  } else {
    void request.abort().catch(() => undefined);
  }
}

/** Closes a session under a bound; a slow or hanging close never blocks. */
async function closeBounded(browser: BrowserLike, ms: number): Promise<void> {
  try {
    await withTimeout(browser.close(), ms, "browser close timed out");
  } catch {
    // Giving up on close must not block the result.
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
