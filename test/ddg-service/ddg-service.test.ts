import { env, evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DDG_OBJECT_NAME, DdgService } from "../../src/ddg-service";
import { clickMoreResults, extractSearchDom } from "../../src/ddg/browser-search";
import type {
  SearchBrowserLauncher,
  SearchBrowserLike,
  SearchDomExtraction,
  SearchPageLike,
} from "../../src/ddg/browser-search";
import type { ParsedPage } from "../../src/ddg/parse";
import type { FetchLike } from "../../src/ddg/request";
import { ManualClock, flushMicrotasks } from "./manual-clock";

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

function makeBrowser(batch: SearchDomExtraction, state: FakeBrowserState): SearchBrowserLike {
  const page: SearchPageLike = {
    async goto() {
      return undefined;
    },
    async evaluate<T>(fn: () => T): Promise<T> {
      if ((fn as unknown) === extractSearchDom) return batch as unknown as T;
      if ((fn as unknown) === clickMoreResults) return false as unknown as T;
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

function browserLauncher(batch: SearchDomExtraction, state: FakeBrowserState): SearchBrowserLauncher {
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

describe("DdgService", () => {
  afterEach(async () => {
    await evictAllDurableObjects();
  });

  it("runs a paginated search through the Durable Object", async () => {
    const clock = new ManualClock();
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const result = await runInDurableObject(stub, async (instance: DdgService) => {
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
        minIntervalMs: 0,
        maxIntervalMs: 0,
      });

      return instance.search({ query: "x", maxResults: 3, region: "wt-wt" });
    });

    expect(result.status).toBe("ok");
    expect(result.results.map((item) => item.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ]);
  });

  it("persists the cooldown after three consecutive failures and rejects the next call", async () => {
    const clock = new ManualClock();
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const outcome = await runInDurableObject(stub, async (instance: DdgService, state) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        minIntervalMs: 0,
        maxIntervalMs: 0,
        cooldownMs: 60_000,
      });

      const challenged = await instance.search({ query: "x", maxResults: 1, region: "wt-wt" });
      const stored = await state.storage.get<{
        intervalMs: number;
        consecutiveFailures: number;
        nextRetryAt: number;
      }>("ddgState");
      const immediate = await instance.search({ query: "y", maxResults: 1, region: "wt-wt" });
      return { challenged, stored, immediate };
    });

    expect(outcome.challenged.status).toBe("failed");
    expect("error" in outcome.challenged ? outcome.challenged.error.code : undefined).toBe(
      "PROVIDER_CHALLENGE",
    );
    expect(outcome.stored?.intervalMs).toBe(0);
    expect(outcome.stored?.consecutiveFailures).toBe(0);
    expect(outcome.stored?.nextRetryAt).toBe(clock.now() + 60_000);
    expect("error" in outcome.immediate ? outcome.immediate.error.code : undefined).toBe(
      "RATE_LIMITED",
    );
  });

  it("falls back to the browser while cooling down and keeps the engine state", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        minIntervalMs: 0,
        maxIntervalMs: 0,
        cooldownMs: 60_000,
      });
      await instance.search({ query: "a", maxResults: 1, region: "wt-wt" });
      const before = instance.getNextRetryAt();

      instance.setTestBrowserDeps({
        launch: browserLauncher(browserResult("https://example.com/x", false), state),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });
      const result = await instance.search({ query: "x", maxResults: 5, region: "wt-wt" });
      return { result, before, after: instance.getNextRetryAt() };
    });

    expect(outcome.result.status).toBe("exhausted");
    expect(outcome.result.results.map((item) => item.url)).toEqual(["https://example.com/x"]);
    expect(outcome.after).toBe(outcome.before);
    expect(state.closes).toBe(1);
  });

  it("recomputes retryAfterMs when the fallback fails with zero results", async () => {
    const clock = new ManualClock();
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        minIntervalMs: 0,
        maxIntervalMs: 0,
        cooldownMs: 60_000,
      });
      await instance.search({ query: "a", maxResults: 1, region: "wt-wt" });
      await clock.advance(20_000);

      instance.setTestBrowserDeps({
        launch: async () => {
          throw new Error("no browser available");
        },
      });
      return instance.search({ query: "x", maxResults: 5, region: "wt-wt" });
    });

    expect(outcome.status).toBe("failed");
    expect("error" in outcome ? outcome.error.code : undefined).toBe("RATE_LIMITED");
    expect("error" in outcome ? outcome.error.retryAfterMs : undefined).toBe(40_000);
  });

  it("returns partial browser results as interrupted", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        minIntervalMs: 0,
        maxIntervalMs: 0,
        cooldownMs: 60_000,
      });
      await instance.search({ query: "a", maxResults: 1, region: "wt-wt" });

      instance.setTestBrowserDeps({
        launch: browserLauncher(browserResult("https://example.com/p", true), state),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
        maxPages: 1,
      });
      return instance.search({ query: "x", maxResults: 5, region: "wt-wt" });
    });

    expect(outcome.status).toBe("interrupted");
    expect(outcome.results).toHaveLength(1);
    expect("error" in outcome ? outcome.error.code : undefined).toBe("PAGE_LIMIT");
  });

  it("continues the FIFO after a failed fallback", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        minIntervalMs: 0,
        maxIntervalMs: 0,
        cooldownMs: 60_000,
      });
      await instance.search({ query: "a", maxResults: 1, region: "wt-wt" });

      instance.setTestBrowserDeps({
        launch: async () => {
          state.launches += 1;
          if (state.launches === 1) throw new Error("first launch failed");
          return makeBrowser(browserResult("https://example.com/ok", false), state);
        },
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });
      const first = instance.search({ query: "x", maxResults: 5, region: "wt-wt" });
      const second = instance.search({ query: "y", maxResults: 5, region: "wt-wt" });
      return { first: await first, second: await second };
    });

    expect(outcome.first.status).toBe("failed");
    expect("error" in outcome.first ? outcome.first.error.code : undefined).toBe("RATE_LIMITED");
    expect(outcome.second.status).toBe("exhausted");
    expect(state.launches).toBe(2);
  });

  it("serializes concurrent fallbacks", async () => {
    const clock = new ManualClock();
    const state: FakeBrowserState = { closes: 0, launches: 0 };
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const stub = env.DDG_SERVICE.getByName(DDG_OBJECT_NAME);

    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setTestDeps({
        clock,
        fetchImpl: async () => new Response("body", { status: 200 }),
        parse: async () => ({ kind: "challenge" }),
        minIntervalMs: 0,
        maxIntervalMs: 0,
        cooldownMs: 60_000,
      });
      await instance.search({ query: "a", maxResults: 1, region: "wt-wt" });

      instance.setTestBrowserDeps({
        launch: async () => {
          state.launches += 1;
          if (state.launches === 1) await gate;
          return makeBrowser(browserResult("https://example.com/s", false), state);
        },
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      });
      const first = instance.search({ query: "x", maxResults: 5, region: "wt-wt" });
      const second = instance.search({ query: "y", maxResults: 5, region: "wt-wt" });
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
