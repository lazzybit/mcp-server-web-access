/**
 * Browser rendering used only when the decision model says the static HTML is
 * an app shell.
 *
 * At most one render per tool call. Navigation requests (including redirect
 * chains) are validated against the URL policy when request interception is
 * available. Requests issued by page scripts, frames and XHR are outside this
 * boundary and are documented as such, not claimed to be covered.
 */
import { BROWSER_NAV_TIMEOUT_MS, MAX_BODY_BYTES, MAX_REDIRECTS, RENDERED_WAIT_MS } from "./constants";
import type { Deadline } from "./deadline";
import { sleep } from "./deadline";
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
  /** The `BROWSER` binding. */
  binding: unknown;
  /** The statically resolved final URL to navigate to. */
  url: string;
  deadline: Deadline;
  launch?: BrowserLauncher;
  maxRedirects?: number;
}

export interface RenderOutcome {
  html: string;
  finalUrl: string;
}

/** Renders `url` once; throws {@link PageFailure} on any failure. */
export async function renderPage(options: RenderOptions): Promise<RenderOutcome> {
  const launch = await resolveLauncher(options.launch);
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  const launchPromise = launch(options.binding);
  const browser = await launchWithin(launchPromise, options.deadline.remaining());
  if (browser === null) {
    // The launch may still resolve; close it so no session leaks.
    void launchPromise.then((late) => late.close()).catch(() => undefined);
    throw pageFailure("RENDER_FAILED", "browser launch exceeded the deadline");
  }

  try {
    const page = await browser.newPage();
    try {
      if (typeof page.setRequestInterception === "function") {
        await page.setRequestInterception(true);
        page.on("request", (request) => interceptRequest(request, maxRedirects));
      }
    } catch {
      // Interception is best-effort; the final URL is still validated below.
    }

    const navTimeout = Math.min(BROWSER_NAV_TIMEOUT_MS, options.deadline.remaining());
    if (navTimeout <= 0) {
      throw pageFailure("RENDER_FAILED", "deadline exceeded before navigation");
    }
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: navTimeout });

    const waitMs = Math.min(RENDERED_WAIT_MS, options.deadline.remaining());
    if (waitMs > 0) await sleep(waitMs, options.deadline.signal);

    if (options.deadline.expired()) {
      throw pageFailure("TIMEOUT", "rendering exceeded the deadline");
    }

    const html = await page.content();
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
    await browser.close().catch(() => undefined);
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

function launchWithin(promise: Promise<BrowserLike>, ms: number): Promise<BrowserLike | null> {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    promise.then(
      (browser) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(browser);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      },
    );
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
