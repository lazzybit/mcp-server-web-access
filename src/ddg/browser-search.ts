/**
 * Browser search transport used by the `ddg-browser` search provider.
 *
 * The provider layer stays free of `cloudflare:workers`; this adapter consumes
 * the shared browser capability. It opens at most one incognito context per
 * search, bounds every potentially hanging operation with its own timeout, and
 * never touches the coordinator's provider-selection state.
 *
 * Like `fetch_page`'s renderer, there is no whole-call deadline: termination
 * comes from bounded counts plus per-operation timeouts. The in-page
 * extraction lives in a self-contained function so `page.evaluate` can
 * serialise it without losing module bindings.
 */
import {
  BROWSER_SEARCH_ACCEPT_LANGUAGE,
  BROWSER_SEARCH_ENDPOINT,
  BROWSER_SEARCH_MAX_PAGES,
  BROWSER_SEARCH_POLL_INTERVAL_MS,
  BROWSER_SEARCH_RESULTS_TIMEOUT_MS,
  BROWSER_SEARCH_USER_AGENT,
  BROWSER_SEARCH_VIEWPORT,
} from "../constants";
import {
  BROWSER_CALL_TIMEOUT_MS,
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_LAUNCH_TIMEOUT_MS,
  BROWSER_NAV_TIMEOUT_MS,
} from "../page/constants";
import { TimeoutError, operationWindow, sleep, withTimeout } from "../page/timeout";
import type { OperationWindow } from "../page/timeout";
import { serializeExpression } from "../browser/launcher";
import type { BrowserCapability, CapabilityLauncher, PageCapability } from "../browser/launcher";
import { normalizeResultUrl } from "./parse";
import { interruptedOrFailed, makeError } from "../types";
import type { ErrorCode, Freshness, SearchParams, SearchResult, SearchResultItem } from "../types";

/** Minimal element shape used by the in-page extraction. */
export interface SearchDomElement {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): SearchDomElement | null;
  querySelectorAll(selector: string): ArrayLike<SearchDomElement>;
  click?(): void;
}

/** Minimal document shape used by the in-page extraction. */
export interface SearchDomDocument {
  querySelector(selector: string): SearchDomElement | null;
  querySelectorAll(selector: string): ArrayLike<SearchDomElement>;
}

// Type-only: the identifier is resolved by the browser page at run time.
declare const document: SearchDomDocument;

/** One raw organic result as read from the page. */
export interface SearchDomResult {
  title: string;
  href: string;
  snippet: string | null;
}

/** Result of one in-page extraction pass. */
export type SearchDomExtraction =
  | { kind: "results"; results: SearchDomResult[]; hasMore: boolean }
  | { kind: "challenge" }
  | { kind: "no_results" }
  | { kind: "unparseable" };

/**
 * Self-contained DOM extraction run inside the page.
 *
 * Selectors observed through the Browser Run probe: container
 * `article[data-testid="result"]`, title link `a[data-testid="result-title-a"]`,
 * snippet `[data-result="snippet"]` and the organic marker `data-nrn="result"`.
 * Challenge and no-results markers are only trusted when no result container
 * was found, so ordinary snippets cannot masquerade as either.
 */
export function extractSearchDom(doc: SearchDomDocument = document): SearchDomExtraction {
  const containerSelector = 'article[data-testid="result"]';
  const titleSelector = 'a[data-testid="result-title-a"]';
  const snippetSelector = '[data-result="snippet"]';
  const organicMarker = "result";
  const challengeMarkers = ["bots use", "select all squares"];

  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim();

  const hasMoreResults = (): boolean => {
    const buttons = doc.querySelectorAll("button");
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons[index];
      if (button === undefined) continue;
      if (normalize(button.textContent).toLowerCase() === "more results") return true;
    }
    return false;
  };

  const results: SearchDomResult[] = [];
  const containers = doc.querySelectorAll(containerSelector);
  for (let index = 0; index < containers.length; index += 1) {
    const container = containers[index];
    if (container === undefined) continue;
    const marker = container.getAttribute("data-nrn");
    if (marker !== null && marker.toLowerCase() !== organicMarker) continue;
    const anchor = container.querySelector(titleSelector);
    if (anchor === null) continue;
    const href = anchor.getAttribute("href");
    if (href === null || href.trim() === "") continue;
    const title = normalize(anchor.textContent);
    if (title === "") continue;
    const snippetElement = container.querySelector(snippetSelector);
    const snippet = snippetElement === null ? null : normalize(snippetElement.textContent);
    results.push({ title, href, snippet: snippet === "" ? null : snippet });
  }
  if (results.length > 0) {
    return { kind: "results", results, hasMore: hasMoreResults() };
  }

  if (doc.querySelector('script[src*="anomaly.js"]') !== null) return { kind: "challenge" };
  const bodyText = (doc.querySelector("body")?.textContent ?? "").toLowerCase();
  if (challengeMarkers.some((marker) => bodyText.includes(marker))) return { kind: "challenge" };
  if (doc.querySelector(".no-results") !== null) return { kind: "no_results" };
  if (bodyText.includes("no results.")) return { kind: "no_results" };
  return { kind: "unparseable" };
}

/** Self-contained in-page click on the text-matched `More results` button. */
export function clickMoreResults(doc: SearchDomDocument = document): boolean {
  const buttons = doc.querySelectorAll("button");
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index];
    if (button === undefined) continue;
    const label = (button.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (label !== "more results") continue;
    button.click?.();
    return true;
  }
  return false;
}

/** Injectable adapter dependencies (tests override the launcher). */
export interface BrowserSearchDeps {
  /** The `BROWSER` binding. */
  binding?: unknown;
  /** The shared browser capability launcher injected by the provider. */
  launch?: CapabilityLauncher;
  launchTimeoutMs?: number;
  callTimeoutMs?: number;
  navTimeoutMs?: number;
  closeTimeoutMs?: number;
  resultsTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPages?: number;
}

/** Whether a browser was attempted, plus the search result it produced. */
export interface BrowserSearchOutcome {
  attempted: boolean;
  result: SearchResult;
}

interface BrowserRunOptions {
  callTimeoutMs: number;
  navTimeoutMs: number;
  resultsTimeoutMs: number;
  pollIntervalMs: number;
  maxPages: number;
}

const FRESHNESS_DF: Record<Freshness, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/** Builds the DuckDuckGo query URL; query/region/freshness are encoded. */
export function buildBrowserSearchUrl(params: SearchParams): string {
  const url = new URL(BROWSER_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("kl", params.region);
  if (params.freshness !== undefined) url.searchParams.set("df", FRESHNESS_DF[params.freshness]);
  return url.toString();
}

/**
 * Runs one browser search. Never throws and never rejects: launch failures,
 * timeouts, challenges, parse anomalies and page limits are all mapped to a
 * {@link SearchResult}, and the browser is always closed under a bound.
 */
export async function searchViaBrowser(
  params: SearchParams,
  deps: BrowserSearchDeps = {},
): Promise<BrowserSearchOutcome> {
  const launch = deps.launch;
  if (launch === undefined) {
    // The provider is only enabled with a launcher; a missing one is a wiring
    // bug, not a browser attempt.
    return {
      attempted: false,
      result: failedBrowserResult("UPSTREAM_ERROR", "browser launcher is not configured"),
    };
  }
  const launchTimeoutMs = deps.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS;
  const callTimeoutMs = deps.callTimeoutMs ?? BROWSER_CALL_TIMEOUT_MS;
  const closeTimeoutMs = deps.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;
  const options: BrowserRunOptions = {
    callTimeoutMs,
    navTimeoutMs: deps.navTimeoutMs ?? BROWSER_NAV_TIMEOUT_MS,
    resultsTimeoutMs: deps.resultsTimeoutMs ?? BROWSER_SEARCH_RESULTS_TIMEOUT_MS,
    pollIntervalMs: deps.pollIntervalMs ?? BROWSER_SEARCH_POLL_INTERVAL_MS,
    maxPages: deps.maxPages ?? BROWSER_SEARCH_MAX_PAGES,
  };

  const launchPromise = launch(deps.binding);
  let browser: BrowserCapability;
  try {
    browser = await withTimeout(launchPromise, launchTimeoutMs, "browser launch timed out");
  } catch {
    // The launch may still resolve; close it so the session cannot leak.
    void launchPromise
      .then((late) => closeBounded(late, closeTimeoutMs))
      .catch(() => undefined);
    return {
      attempted: true,
      result: failedBrowserResult("UPSTREAM_ERROR", "browser launch failed"),
    };
  }

  try {
    return { attempted: true, result: await runBrowserSearch(browser, params, options) };
  } catch (error) {
    return { attempted: true, result: browserErrorResult(error) };
  } finally {
    await closeBounded(browser, closeTimeoutMs);
  }
}

async function runBrowserSearch(
  browser: BrowserCapability,
  params: SearchParams,
  options: BrowserRunOptions,
): Promise<SearchResult> {
  const page = await withTimeout(
    browser.newPage(),
    options.callTimeoutMs,
    "browser page creation timed out",
  );
  await configurePage(page, options);
  await navigate(page, params, options);

  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  const initial = await waitForExtraction(
    page,
    options,
    (extraction) => extraction.kind !== "unparseable",
  );
  if (initial.extraction.kind === "challenge") {
    return failedBrowserResult("PROVIDER_CHALLENGE", "DuckDuckGo returned a bot challenge");
  }
  if (initial.extraction.kind === "no_results") {
    return { status: "exhausted", results: [] };
  }
  if (initial.extraction.kind !== "results") {
    return initial.timedOut
      ? failedBrowserResult("UPSTREAM_ERROR", "browser results timed out")
      : failedBrowserResult("PARSE_FAILED", "could not parse the results page");
  }

  appendResults(initial.extraction.results, params, seen, results);
  let current = initial.extraction;
  let pages = 1;

  if (results.length >= params.maxResults) return { status: "ok", results };

  while (current.hasMore) {
    if (pages >= options.maxPages) {
      return interruptedOrFailed(
        results,
        makeError("PAGE_LIMIT", `stopped after ${options.maxPages} browser pages`),
      );
    }

    const before = current.results.length;
    let clicked: boolean;
    try {
      clicked = (await withTimeout(
        page.evaluate(serializeExpression(clickMoreResults)),
        options.callTimeoutMs,
        "browser click timed out",
      )) as boolean;
    } catch {
      return interruptedOrFailed(
        results,
        makeError("UPSTREAM_ERROR", "browser pagination click timed out"),
      );
    }
    if (!clicked) return { status: "exhausted", results };

    const waited = await waitForExtraction(
      page,
      options,
      (extraction) =>
        extraction.kind !== "results"
          ? extraction.kind !== "unparseable"
          : extraction.results.length > before,
    );
    const next = waited.extraction;

    if (next.kind === "challenge") {
      return interruptedOrFailed(
        results,
        makeError("PROVIDER_CHALLENGE", "DuckDuckGo returned a bot challenge"),
      );
    }
    if (next.kind === "no_results") return { status: "exhausted", results };
    if (next.kind !== "results") {
      return waited.timedOut
        ? interruptedOrFailed(results, makeError("UPSTREAM_ERROR", "browser pagination timed out"))
        : interruptedOrFailed(results, makeError("PARSE_FAILED", "could not parse the results page"));
    }
    // A load that never produced new containers within its window is a timeout,
    // not a confirmed last page; keep the partial results.
    if (waited.timedOut) {
      return interruptedOrFailed(results, makeError("UPSTREAM_ERROR", "browser pagination timed out"));
    }

    const added = appendResults(next.results, params, seen, results);
    // A click that produced no new unique results must not be retried forever.
    if (added === 0) return { status: "exhausted", results };
    pages += 1;
    if (results.length >= params.maxResults) return { status: "ok", results };
    if (!next.hasMore) return { status: "exhausted", results };
    current = next;
  }

  return { status: "exhausted", results };
}

async function configurePage(page: PageCapability, options: BrowserRunOptions): Promise<void> {
  if (typeof page.setUserAgent === "function") {
    await withTimeout(
      page.setUserAgent(BROWSER_SEARCH_USER_AGENT),
      options.callTimeoutMs,
      "browser setup timed out",
    );
  }
  if (typeof page.setViewport === "function") {
    await withTimeout(
      page.setViewport(BROWSER_SEARCH_VIEWPORT),
      options.callTimeoutMs,
      "browser setup timed out",
    );
  }
  if (typeof page.setExtraHTTPHeaders === "function") {
    await withTimeout(
      page.setExtraHTTPHeaders({ "accept-language": BROWSER_SEARCH_ACCEPT_LANGUAGE }),
      options.callTimeoutMs,
      "browser setup timed out",
    );
  }
}

async function navigate(
  page: PageCapability,
  params: SearchParams,
  options: BrowserRunOptions,
): Promise<void> {
  const gotoPromise = page.goto(buildBrowserSearchUrl(params), {
    waitUntil: "domcontentloaded",
    timeout: options.navTimeoutMs,
  });
  try {
    await withTimeout(gotoPromise, options.navTimeoutMs, "browser navigation timed out");
  } catch (error) {
    // A native timeout or a late navigation must not leave an unhandled rejection.
    gotoPromise.catch(() => undefined);
    throw error;
  }
}

interface ExtractionWait {
  extraction: SearchDomExtraction;
  timedOut: boolean;
}

/**
 * Polls one extraction under a single operation window. The timer is never
 * restarted per poll: the whole load shares `resultsTimeoutMs`.
 */
async function waitForExtraction(
  page: PageCapability,
  options: BrowserRunOptions,
  accept: (extraction: SearchDomExtraction) => boolean,
): Promise<ExtractionWait> {
  const window = operationWindow(options.resultsTimeoutMs);
  let extraction: SearchDomExtraction = { kind: "unparseable" };
  try {
    for (;;) {
      if (window.timedOut()) return { extraction, timedOut: true };
      try {
        extraction = await evaluateExtraction(page, options, window);
      } catch {
        return { extraction, timedOut: true };
      }
      if (accept(extraction)) return { extraction, timedOut: false };
      if (window.timedOut()) return { extraction, timedOut: true };
      await sleep(Math.min(options.pollIntervalMs, window.remaining()), window.signal);
    }
  } finally {
    window.dispose();
  }
}

function evaluateExtraction(
  page: PageCapability,
  options: BrowserRunOptions,
  window: OperationWindow,
): Promise<SearchDomExtraction> {
  const budget = Math.min(options.callTimeoutMs, window.remaining());
  if (budget <= 0) {
    return Promise.reject(new TimeoutError("browser extraction timed out"));
  }
  return withTimeout(
    page.evaluate(serializeExpression(extractSearchDom)),
    budget,
    "browser extraction timed out",
  ) as Promise<SearchDomExtraction>;
}

function appendResults(
  pageResults: SearchDomResult[],
  params: SearchParams,
  seen: Set<string>,
  out: SearchResultItem[],
): number {
  let added = 0;
  for (const result of pageResults) {
    if (out.length >= params.maxResults) break;
    const normalized = normalizeResultUrl(result.href, BROWSER_SEARCH_ENDPOINT);
    if (normalized === null || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    out.push({
      rank: out.length + 1,
      title: result.title,
      url: normalized.url,
      domain: normalized.domain,
      snippet: result.snippet,
    });
    added += 1;
  }
  return added;
}

function failedBrowserResult(code: ErrorCode, message: string): SearchResult {
  return { status: "failed", results: [], error: makeError(code, message) };
}

function browserErrorResult(error: unknown): SearchResult {
  const message = error instanceof TimeoutError
    ? "browser operation timed out"
    : "browser search failed";
  return failedBrowserResult("UPSTREAM_ERROR", message);
}

/** Closes a session under a bound; a slow or hanging close never blocks. */
async function closeBounded(browser: BrowserCapability, ms: number): Promise<void> {
  try {
    await withTimeout(browser.close(), ms, "browser close timed out");
  } catch {
    // Giving up on close must not block the result.
  }
}
