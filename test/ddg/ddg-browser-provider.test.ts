import { describe, expect, it } from "vitest";
import {
  DDG_BROWSER_STATE_KEY,
  DdgBrowserSearchProvider,
} from "../../src/search/ddg-browser-provider";
import type { DdgBrowserDeps } from "../../src/search/ddg-browser-provider";
import { DDG_HTML_STATE_KEY } from "../../src/search/ddg-html-provider";
import type { ProviderOutcome } from "../../src/search/provider";
import type { StoragePort } from "../../src/search/deps";
import { clickMoreResults, extractSearchDom } from "../../src/ddg/browser-search";
import type {
  SearchBrowserLauncher,
  SearchBrowserLike,
  SearchDomExtraction,
  SearchPageLike,
} from "../../src/ddg/browser-search";
import type { SearchResult } from "../../src/types";
import { ManualClock, flushMicrotasks } from "./manual-clock";

function doneOf(outcome: ProviderOutcome): SearchResult {
  if (outcome.kind !== "done") throw new Error(`expected done, got ${outcome.error.code}`);
  return outcome.result;
}

function fallbackOf(outcome: ProviderOutcome): Extract<ProviderOutcome, { kind: "fallback" }> {
  if (outcome.kind !== "fallback") throw new Error("expected fallback");
  return outcome;
}

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, unknown>();
  puts = 0;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.puts += 1;
    this.values.set(key, value);
  }
}

function results(
  entries: Array<{ href: string; title?: string; snippet?: string | null }>,
  hasMore: boolean,
): SearchDomExtraction {
  return {
    kind: "results",
    results: entries.map((entry) => ({
      title: entry.title ?? entry.href,
      href: entry.href,
      snippet: entry.snippet ?? null,
    })),
    hasMore,
  };
}

class FakeSearchPage implements SearchPageLike {
  #batches: SearchDomExtraction[];

  constructor(batches: SearchDomExtraction[]) {
    this.#batches = batches;
  }

  async goto(): Promise<unknown> {
    return undefined;
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    if ((fn as unknown) === extractSearchDom) {
      const batch = this.#batches[0] ?? { kind: "unparseable" };
      return batch as unknown as T;
    }
    if ((fn as unknown) === clickMoreResults) return false as unknown as T;
    throw new Error("unexpected evaluate");
  }
}

function browserFor(batch: SearchDomExtraction): SearchBrowserLike {
  const page = new FakeSearchPage([batch]);
  return {
    newPage: async () => page,
    close: async () => {},
  };
}

function deps(
  clock: ManualClock,
  browserDeps: DdgBrowserDeps["browser"],
  overrides: Partial<DdgBrowserDeps> = {},
): DdgBrowserDeps {
  return {
    clock,
    browser: browserDeps,
    enabled: true,
    cooldownMs: 60_000,
    transientDelayMs: 1_500,
    logLevel: "error",
    ...overrides,
  };
}

const REQUEST = { query: "x", maxResults: 5, region: "wt-wt" };

describe("DdgBrowserSearchProvider", () => {
  it("maps exhausted and ok browser results to done", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    const exhaustedProvider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, {
        launch: async () => browserFor(results([{ href: "https://a.example/" }], false)),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      }),
    );
    const exhaustedResult = doneOf(await exhaustedProvider.search({ ...REQUEST }));
    expect(exhaustedResult.status).toBe("exhausted");
    expect(exhaustedResult.results.map((item) => item.url)).toEqual(["https://a.example/"]);

    const okProvider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, {
        launch: async () =>
          browserFor(
            results(
              [{ href: "https://a.example/" }, { href: "https://b.example/" }],
              false,
            ),
          ),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      }),
    );
    const okResult = doneOf(await okProvider.search({ ...REQUEST, maxResults: 2 }));
    expect(okResult.status).toBe("ok");
    expect(okResult.results).toHaveLength(2);
  });

  it("maps a page limit to a complete interrupted result", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    const provider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, {
        launch: async () =>
          browserFor(results([{ href: "https://a.example/" }], true)),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
        maxPages: 1,
      }),
    );

    const result = doneOf(await provider.search({ ...REQUEST }));
    expect(result.status).toBe("interrupted");
    if (result.status !== "interrupted") return;
    expect(result.error.code).toBe("PAGE_LIMIT");
  });

  it("opens a challenge cooldown and returns a fallback", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    const provider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, {
        launch: async () => browserFor({ kind: "challenge" }),
        pollIntervalMs: 1,
        resultsTimeoutMs: 100,
      }),
    );

    const outcome = fallbackOf(await provider.search({ ...REQUEST }));

    expect(outcome.error.code).toBe("PROVIDER_CHALLENGE");
    expect(outcome.error.retryAfterMs).toBe(60_000);
    expect(provider.getNextRetryAt()).toBe(clock.now() + 60_000);
    expect(provider.availability(clock.now())).toEqual({
      kind: "cooling",
      retryAfterMs: 60_000,
    });
  });

  it("opens a transient cooldown on a launch failure", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    const provider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, {
        launch: async () => {
          throw new Error("no browser available");
        },
      }),
    );

    const outcome = fallbackOf(await provider.search({ ...REQUEST }));

    expect(outcome.error.code).toBe("UPSTREAM_ERROR");
    expect(outcome.error.retryAfterMs).toBe(1_500);
    expect(provider.getNextRetryAt()).toBe(clock.now() + 1_500);
  });

  it("keeps its state under its own namespace, independent of the HTML provider", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    storage.values.set(DDG_BROWSER_STATE_KEY, { v: 1, nextRetryAt: clock.now() + 60_000 });
    storage.values.set(DDG_HTML_STATE_KEY, { v: 1, nextRetryAt: clock.now() + 10_000 });
    const provider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, { launch: async () => browserFor({ kind: "challenge" }) }),
    );
    await provider.load();

    expect(provider.getNextRetryAt()).toBe(clock.now() + 60_000);
    // Distinct keys: the HTML snapshot is untouched.
    expect(storage.values.get(DDG_HTML_STATE_KEY)).toEqual({
      v: 1,
      nextRetryAt: clock.now() + 10_000,
    });
  });

  it("reports disabled when the provider is switched off", () => {
    const clock = new ManualClock();
    const provider = new DdgBrowserSearchProvider(
      new MemoryStorage(),
      deps(clock, {}, { enabled: false }),
    );
    expect(provider.availability(clock.now())).toEqual({ kind: "disabled" });
  });

  it("serializes concurrent browser searches", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    let launches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch: SearchBrowserLauncher = async () => {
      launches += 1;
      if (launches === 1) await gate;
      return browserFor(results([{ href: "https://a.example/" }], false));
    };
    const provider = new DdgBrowserSearchProvider(
      storage,
      deps(clock, { launch, pollIntervalMs: 1, resultsTimeoutMs: 100 }),
    );

    const first = provider.search({ ...REQUEST });
    const second = provider.search({ ...REQUEST });
    await flushMicrotasks();

    expect(launches).toBe(1);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(launches).toBe(2);
    expect(firstResult.kind).toBe("done");
    expect(secondResult.kind).toBe("done");
  });
});
