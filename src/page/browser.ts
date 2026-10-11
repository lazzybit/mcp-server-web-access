/**
 * Browser rendering used only when the decision model says the static HTML is
 * an app shell.
 *
 * At most one render per tool call. Navigation requests (including redirect
 * chains) are validated through the page capability's request policy: the pure
 * `decideNavigation` rule stays here, while interception runs inside
 * `BrowserService`. Requests issued by page scripts, frames and XHR are outside
 * this boundary and are documented as such, not claimed to be covered.
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
import type {
  BrowserCapability,
  CapabilityLauncher,
  NavigationRequestInfo,
  RequestDecision,
  RequestPolicy,
} from "../browser/launcher";

export interface RenderOptions {
  /** The `BROWSER` binding, forwarded to the launcher. */
  binding?: unknown;
  /** The statically resolved final URL to navigate to. */
  url: string;
  /** The shared browser capability launcher injected by the Worker. */
  launch: CapabilityLauncher;
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

/**
 * Pure navigation rule: the chain may not exceed `maxRedirects` hops and every
 * hop, including the final URL, must satisfy the URL policy.
 */
export function decideNavigation(
  info: NavigationRequestInfo,
  maxRedirects: number,
): RequestDecision {
  const chain = [...info.redirectChain, info.url];
  const allowed =
    chain.length <= maxRedirects + 1 && chain.every((url) => isAllowedUrlString(url));
  return allowed ? "allow" : "abort";
}

/** Renders `url` once; throws {@link PageFailure} on any failure. */
export async function renderPage(options: RenderOptions): Promise<RenderOutcome> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const launchTimeoutMs = options.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? BROWSER_CALL_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;

  const launchPromise = options.launch(options.binding);
  let browser: BrowserCapability;
  try {
    browser = await withTimeout(launchPromise, launchTimeoutMs, "browser launch timed out");
  } catch {
    // The launch may still resolve; close it so no context leaks.
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

    const policy: RequestPolicy = {
      decide: (info: NavigationRequestInfo) => decideNavigation(info, maxRedirects),
    };
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_NAV_TIMEOUT_MS,
      policy,
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

    const finalUrl = await page.url();
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

/** Closes a session under a bound; a slow or hanging close never blocks. */
async function closeBounded(browser: BrowserCapability, ms: number): Promise<void> {
  try {
    await withTimeout(browser.close(), ms, "browser close timed out");
  } catch {
    // Giving up on close must not block the result.
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
