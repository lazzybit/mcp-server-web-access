import { env, evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SearchService } from "../../src/search-service";
import { DDG_HTML_STATE_KEY } from "../../src/search/ddg-html-provider";
import { DDG_BROWSER_STATE_KEY } from "../../src/search/ddg-browser-provider";
import { clickMoreResults, extractSearchDom } from "../../src/ddg/browser-search";
import type { SearchDomExtraction } from "../../src/ddg/browser-search";
import { serializeExpression } from "../../src/browser/launcher";
import type {
  BrowserCapability,
  CapabilityLauncher,
  PageCapability,
} from "../../src/browser/launcher";
import type { ParsedPage } from "../../src/ddg/parse";
import type { FetchLike } from "../../src/ddg/request";
import type { SearchError, SearchResult } from "../../src/types";
import { ManualClock, drive, flushMicrotasks } from "../ddg/manual-clock";

function resultsPage(urls: string[], next: string | null): ParsedPage {
  return {
    kind: "results",
    results: urls.map((url, index) => ({
      title: `Title ${index}`,
      url,
      domain: new URL(url).hostname,
      snippet: null,
    })),
    next: next === null ? null : { fields: [["q", "x"], ["s", next]] },
  };
}

interface FakeBrowserState {
  closes: number;
  launches: number;
}

function makeBrowser(batch: SearchDomExtraction, state: FakeBrowserState): BrowserCapability {
  const page: PageCapability = {
    async goto() {
      return undefined;
    },
    async content() {
      return "";
    },
    async url() {
      return "about:blank";
    },
    async evaluate(expression: string): Promise<unknown> {
      if (expression === serializeExpression(extractSearchDom)) return batch;
      if (expression === serializeExpression(clickMoreResults)) return false;
      throw new Error("unexpected evaluate");
    },
  };
  return {
    newPage: async () => page,
    close: async () => {
      state.closes += 1;
    },
  };
}

function browserLauncher(
  batch: SearchDomExtraction,
  state: FakeBrowserState,
): CapabilityLauncher {
  return async () => {
    state.launches += 1;
    return makeBrowser(batch, state);
  };
}

function browserResult(url: string, hasMore: boolean): SearchDomExtraction {
  return {
    kind: "results",
    results: [{ title: `Title ${url}`, href: url, snippet: null }],
    hasMore,
  };
}

function codeOf(result: SearchResult): string | undefined {
  return errorOf(result)?.code;
}

function errorOf(result: SearchResult): SearchError | undefined {
  return "error" in result ? result.error : undefined;
}

/**
 * Each test gets its own object name: eviction clears memory but durable
 * storage outlives it, so a shared singleton would leak provider cooldowns
 * between tests (and make a search wait on a clock nobody drives).
 */
let objectCounter = 0;
function freshStub() {
  objectCounter += 1;
  return env.SEARCH_SERVICE.getByName(`test-${objectCounter}`);
}

describe("SearchService", () => {
  afterEach(async () => {
    await evictAllDurableObjects();
  });

  it("runs a paginated search through the Durable Object", async () => {
    const clock = new ManualClock();
    const stub = freshStub();

    const result = await runInDurableObject(stub, async (instance: SearchService) => {
      let lastForm = new URLSearchParams();
      const fetchImpl: FetchLike = async (_input, init) => {
        lastForm = new URLSearchParams(String(init?.body ?? ""));
        return new Response("body", { status: 200 });
      };
      instance.setTestDeps({
        clock,
        fetchImpl,
        parse: async () =>
          lastForm.get("s") === "25"
            ? resultsPage(["https://b.example/", "https://c.example/"], null)
            : resultsPage(["https://a.example/", "https://b.example/"], "25"),
        intervalMs: 0,
      });

      return instance.search({ query: "x", effort: "medium", region: "wt-wt" });
    });

    expect(result.status).toBe("exhausted");
    expect(result.results.map((item) => item.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ]);
  });

  it("persists the HTML cooldown and reports NO_SEARCH_PROVIDER_AVAILABLE with no browser", async () => {
    const clock = new ManualClock();
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance: SearchService, state) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });

      const challenged = await instance.search({ query: "x", effort: "low", region: "wt-wt" });
      const stored = await state.storage.get<{ v: number; nextRetryAt: number }>(
        DDG_HTML_STATE_KEY,
      );
      const immediate = await instance.search({ query: "y", effort: "low", region: "wt-wt" });
      return { challenged, stored, immediate };
    });

    expect(outcome.challenged.status).toBe("failed");
    expect(codeOf(outcome.challenged)).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    expect(outcome.stored?.v).toBe(1);
    expect(outcome.stored?.nextRetryAt).toBe(clock.now() + 60_000);
    expect(outcome.immediate.status).toBe("failed");
    expect(codeOf(outcome.immediate)).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    expect(errorOf(outcome.immediate)?.retryAfterMs).toBe(60_000);
  });

  it("falls back to the browser within the same search", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });
      instance.setTestBrowserDeps({
        launch: browserLauncher(browserResult("https://example.com/x", false), state),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });

      const result = await instance.search({ query: "x", effort: "low", region: "wt-wt" });
      return { result, htmlNextRetryAt: instance.getNextRetryAt(), browserNextRetryAt: instance.getBrowserNextRetryAt() };
    });

    expect(outcome.result.status).toBe("exhausted");
    expect(outcome.result.results.map((item) => item.url)).toEqual(["https://example.com/x"]);
    expect(outcome.htmlNextRetryAt).toBe(clock.now() + 60_000);
    // A successful browser search does not open a cooldown.
    expect(outcome.browserNextRetryAt).toBe(0);
    expect(state.closes).toBe(1);
  });

  it("keeps provider state in independent namespaces", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance, durableState) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });
      instance.setTestBrowserDeps({
        launch: async () => {
          state.launches += 1;
          throw new Error("no browser available");
        },
      });
      await instance.search({ query: "x", effort: "low", region: "wt-wt" });

      return {
        html: await durableState.storage.get(DDG_HTML_STATE_KEY),
        browser: await durableState.storage.get(DDG_BROWSER_STATE_KEY),
      };
    });

    expect(outcome.html).toEqual({ v: 1, nextRetryAt: clock.now() + 60_000 });
    expect(outcome.browser).toEqual({ v: 1, nextRetryAt: clock.now() + 1_500 });
  });

  it("returns NO_SEARCH_PROVIDER_AVAILABLE when every provider fails", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });
      instance.setTestBrowserDeps({
        launch: async () => {
          state.launches += 1;
          throw new Error("no browser available");
        },
      });
      return instance.search({ query: "x", effort: "low", region: "wt-wt" });
    });

    expect(outcome.status).toBe("failed");
    expect(codeOf(outcome)).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    // The soonest known recovery is the browser's transient cooldown.
    expect(errorOf(outcome)?.retryAfterMs).toBe(1_500);
    expect(state.launches).toBe(1);
  });

  it("returns effort-limit browser results as ok", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });
      instance.setTestBrowserDeps({
        launch: browserLauncher(browserResult("https://example.com/p", true), state),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });
      return instance.search({ query: "x", effort: "low", region: "wt-wt" });
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.results).toHaveLength(1);
  });

  it("continues the FIFO after a failed search", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });
      instance.setTestBrowserDeps({
        launch: async () => {
          state.launches += 1;
          if (state.launches === 1) throw new Error("first launch failed");
          return makeBrowser(browserResult("https://example.com/ok", false), state);
        },
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });
      const first = instance.search({ query: "x", effort: "low", region: "wt-wt" });
      const second = instance.search({ query: "y", effort: "low", region: "wt-wt" });
      const [firstResult, secondResult] = await drive(clock, Promise.all([first, second]));
      return { first: firstResult, second: secondResult };
    });

    expect(outcome.first.status).toBe("failed");
    expect(codeOf(outcome.first)).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    expect(outcome.second.status).toBe("exhausted");
    expect(state.launches).toBe(2);
  });

  it("serializes concurrent browser searches", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const stub = freshStub();

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        intervalMs: 0,
        cooldownMs: 60_000,
      });
      instance.setTestBrowserDeps({
        launch: async () => {
          state.launches += 1;
          if (state.launches === 1) await gate;
          return makeBrowser(browserResult("https://example.com/s", false), state);
        },
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });
      const first = instance.search({ query: "x", effort: "low", region: "wt-wt" });
      const second = instance.search({ query: "y", effort: "low", region: "wt-wt" });
      await flushMicrotasks();
      const launchesBeforeRelease = state.launches;
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      return { launchesBeforeRelease, launches: state.launches, firstResult, secondResult };
    });

    expect(outcome.launchesBeforeRelease).toBe(1);
    expect(outcome.launches).toBe(2);
    expect(outcome.firstResult.status).toBe("exhausted");
    expect(outcome.secondResult.status).toBe("exhausted");
  });
});
