import { describe, expect, it } from "vitest";
import {
  DDG_HTML_STATE_KEY,
  DdgHtmlSearchProvider,
  defaultHtmlDeps,
} from "../../src/search/ddg-html-provider";
import type { DdgHtmlDeps } from "../../src/search/ddg-html-provider";
import type { ProviderOutcome } from "../../src/search/provider";
import type { StoragePort } from "../../src/search/deps";
import { DEFAULT_ENDPOINT } from "../../src/ddg/request";
import type { FetchLike } from "../../src/ddg/request";
import type { ParsedPage } from "../../src/ddg/parse";
import type { AppEnv } from "../../src/env";
import type { SearchResult } from "../../src/types";
import { ManualClock, drive, flushMicrotasks } from "./manual-clock";

function doneOf(outcome: ProviderOutcome): SearchResult {
  if (outcome.kind !== "done") {
    throw new Error(`expected done, got fallback (${outcome.error.code})`);
  }
  return outcome.result;
}

function fallbackOf(outcome: ProviderOutcome): Extract<ProviderOutcome, { kind: "fallback" }> {
  if (outcome.kind !== "fallback") {
    throw new Error("expected fallback");
  }
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

/** Upstream stub: keys pages by the form's `s` offset. */
class Upstream {
  lastForm = new URLSearchParams();
  pages: Record<string, ParsedPage> = {};
  statuses: Record<string, number> = {};
  blockOn: Set<string> = new Set();
  calls: Array<{ s: string; at: number }> = [];
  throwOn: Set<string> = new Set();
  #clock: ManualClock;

  constructor(clock: ManualClock) {
    this.#clock = clock;
  }

  fetchImpl: FetchLike = async (_input, init) => {
    this.lastForm = new URLSearchParams(String(init?.body ?? ""));
    const s = this.lastForm.get("s") ?? "0";
    this.calls.push({ s, at: this.#clock.now() });
    if (this.throwOn.has(s)) throw new Error("network down");
    if (this.blockOn.has(s)) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return new Response("body", { status: this.statuses[s] ?? 200 });
  };

  parse = async (): Promise<ParsedPage> => {
    const s = this.lastForm.get("s") ?? "0";
    return this.pages[s] ?? { kind: "unparseable" };
  };
}

function deps(
  clock: ManualClock,
  upstream: Upstream,
  overrides: Partial<DdgHtmlDeps> = {},
): DdgHtmlDeps {
  return {
    clock,
    fetchImpl: upstream.fetchImpl,
    parse: upstream.parse,
    endpoint: "https://html.duckduckgo.com/html/",
    maxBodyBytes: 2 * 1024 * 1024,
    intervalMs: 5_000,
    attemptTimeoutMs: 10_000,
    cooldownMs: 60_000,
    transientDelayMs: 1_500,
    maxPages: 5,
    logLevel: "error",
    ...overrides,
  };
}

function page(urls: string[], next: string | null): ParsedPage {
  return {
    kind: "results",
    results: urls.map((url, index) => ({
      title: `Title ${index}`,
      url,
      domain: new URL(url).hostname,
      snippet: `snippet ${index}`,
    })),
    next: next === null ? null : { fields: [["q", "x"], ["s", next]] },
  };
}

function providerFor(
  clock: ManualClock,
  upstream: Upstream,
  overrides: Partial<DdgHtmlDeps> = {},
) {
  const storage = new MemoryStorage();
  const provider = new DdgHtmlSearchProvider(storage, deps(clock, upstream, overrides));
  return { provider, storage };
}

const REQUEST = { query: "x", maxResults: 4, region: "wt-wt" };

describe("defaultHtmlDeps", () => {
  it("always uses the compiled-in upstream endpoint and fixed interval", () => {
    const dev = defaultHtmlDeps({ ENVIRONMENT: "development", LOG_LEVEL: "info" } as AppEnv);
    const prod = defaultHtmlDeps({ ENVIRONMENT: "production", LOG_LEVEL: "error" } as AppEnv);
    expect(dev.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(prod.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(dev.intervalMs).toBe(5_000);
    expect(prod.intervalMs).toBe(5_000);
  });
});

describe("DdgHtmlSearchProvider", () => {
  it("paginates, deduplicates and reports ok at the requested count", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a.example/", "https://b.example/"], "25"),
      "25": page(["https://b.example/", "https://c.example/", "https://d.example/"], null),
    };
    const { provider } = providerFor(clock, upstream);

    const result = doneOf(await drive(clock, provider.search({ ...REQUEST })));

    expect(result.status).toBe("ok");
    expect(result.results.map((item) => item.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
    ]);
    expect(result.results.map((item) => item.rank)).toEqual([1, 2, 3, 4]);
  });

  it("reports exhausted when the provider runs out of pages", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const { provider } = providerFor(clock, upstream);

    const result = doneOf(
      await drive(clock, provider.search({ query: "x", maxResults: 10, region: "wt-wt" })),
    );
    expect(result.status).toBe("exhausted");
    expect(result.results).toHaveLength(1);
  });

  it("keeps a fixed 5 s interval across pagination", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a.example/"], "25"),
      "25": page(["https://b.example/"], null),
    };
    const { provider } = providerFor(clock, upstream);

    await drive(clock, provider.search({ query: "x", maxResults: 50, region: "wt-wt" }));

    expect(upstream.calls.map((call) => call.s)).toEqual(["0", "25"]);
    expect(upstream.calls[1]!.at - upstream.calls[0]!.at).toBe(5_000);
  });

  it("keeps a fixed 5 s interval across consecutive searches", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const { provider } = providerFor(clock, upstream);

    await drive(clock, provider.search({ query: "a", maxResults: 1, region: "wt-wt" }));
    await drive(clock, provider.search({ query: "b", maxResults: 1, region: "wt-wt" }));

    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1]!.at - upstream.calls[0]!.at).toBe(5_000);
  });

  it("opens the challenge cooldown immediately and keeps partial results", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a.example/"], "25"),
      "25": { kind: "challenge" },
    };
    const { provider, storage } = providerFor(clock, upstream);

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 50, region: "wt-wt" })),
    );

    expect(outcome.error.code).toBe("PROVIDER_CHALLENGE");
    expect(outcome.error.retryAfterMs).toBe(60_000);
    expect(outcome.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    expect(upstream.calls.map((call) => call.s)).toEqual(["0", "25"]);
    expect(provider.getNextRetryAt()).toBe(clock.now() + 60_000);
    expect(storage.values.get(DDG_HTML_STATE_KEY)).toEqual({
      v: 1,
      nextRetryAt: clock.now() + 60_000,
    });
    expect(provider.availability(clock.now())).toEqual({
      kind: "cooling",
      retryAfterMs: 60_000,
    });
  });

  it("does not dispatch while cooling and reports the remainder", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const { provider } = providerFor(clock, upstream);

    await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" }));
    const callsAfterChallenge = upstream.calls.length;

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "y", maxResults: 1, region: "wt-wt" })),
    );
    expect(outcome.error.code).toBe("RATE_LIMITED");
    expect(outcome.error.retryAfterMs).toBe(60_000);
    expect(upstream.calls).toHaveLength(callsAfterChallenge);

    await clock.advance(60_000);
    expect(provider.availability(clock.now()).kind).toBe("ready");
  });

  it("opens the transient cooldown on a network failure", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], "25") };
    upstream.throwOn = new Set(["25"]);
    const { provider } = providerFor(clock, upstream);

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 50, region: "wt-wt" })),
    );

    expect(outcome.error.code).toBe("UPSTREAM_ERROR");
    expect(outcome.error.retryAfterMs).toBe(1_500);
    expect(outcome.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    expect(provider.getNextRetryAt()).toBe(clock.now() + 1_500);
  });

  it("classifies a parser throw as a transient PARSE_FAILED", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const parse = async (): Promise<ParsedPage> => {
      throw new Error("parser exploded");
    };
    const { provider } = providerFor(clock, upstream, { parse });

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 2, region: "wt-wt" })),
    );

    expect(outcome.error.code).toBe("PARSE_FAILED");
    expect(outcome.error.retryable).toBe(true);
    expect(provider.getNextRetryAt()).toBe(clock.now() + 1_500);
  });

  it("maps an unparseable page to a transient PARSE_FAILED", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "unparseable" } };
    const { provider } = providerFor(clock, upstream);

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" })),
    );
    expect(outcome.error.code).toBe("PARSE_FAILED");
    expect(provider.getNextRetryAt()).toBe(clock.now() + 1_500);
  });

  it("classifies HTTP 429 as a challenge", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    upstream.statuses = { "0": 429 };
    const { provider } = providerFor(clock, upstream);

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" })),
    );
    expect(outcome.error.code).toBe("PROVIDER_CHALLENGE");
    expect(provider.getNextRetryAt()).toBe(clock.now() + 60_000);
  });

  it("detects an anomaly challenge that arrives with an error status", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    upstream.statuses = { "0": 503 };
    const { provider } = providerFor(clock, upstream);

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" })),
    );
    expect(outcome.error.code).toBe("PROVIDER_CHALLENGE");
  });

  it("stops at the page limit as a complete interrupted result", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a.example/"], "25"),
      "25": page(["https://b.example/"], "50"),
    };
    const { provider } = providerFor(clock, upstream, { maxPages: 2 });

    const result = doneOf(
      await drive(clock, provider.search({ query: "x", maxResults: 50, region: "wt-wt" })),
    );
    expect(result.status).toBe("interrupted");
    expect(result.results.map((item) => item.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    if (result.status !== "interrupted") return;
    expect(result.error.code).toBe("PAGE_LIMIT");
  });

  it("does not write storage on a successful search", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const { provider, storage } = providerFor(clock, upstream);

    await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" }));
    expect(storage.puts).toBe(0);
  });

  it("loads a persisted cooldown from its own namespace and ignores legacy keys", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const storage = new MemoryStorage();
    storage.values.set("ddgState", { v: 1, nextRetryAt: clock.now() + 10_000 });
    storage.values.set(DDG_HTML_STATE_KEY, { v: 1, nextRetryAt: clock.now() + 30_000 });
    const provider = new DdgHtmlSearchProvider(storage, deps(clock, upstream));
    await provider.load();

    expect(provider.getNextRetryAt()).toBe(clock.now() + 30_000);
    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" })),
    );
    expect(outcome.error.code).toBe("RATE_LIMITED");
    expect(upstream.calls).toHaveLength(0);
  });

  it("ignores an unknown snapshot version", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const storage = new MemoryStorage();
    storage.values.set(DDG_HTML_STATE_KEY, { v: 2, nextRetryAt: 123 });
    const provider = new DdgHtmlSearchProvider(storage, deps(clock, upstream));
    await provider.load();

    expect(provider.getNextRetryAt()).toBe(0);
  });

  it("persists the challenge cooldown durably", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const { provider, storage } = providerFor(clock, upstream);

    await drive(clock, provider.search({ query: "x", maxResults: 1, region: "wt-wt" }));
    await flushMicrotasks(4);

    const restored = new DdgHtmlSearchProvider(storage, deps(clock, new Upstream(clock)));
    await restored.load();
    expect(restored.getNextRetryAt()).toBe(clock.now() + 60_000);
  });

  it("times out a stalled attempt and opens the transient cooldown", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], "25") };
    upstream.blockOn = new Set(["25"]);
    const { provider } = providerFor(clock, upstream, { attemptTimeoutMs: 1_000 });

    const outcome = fallbackOf(
      await drive(clock, provider.search({ query: "x", maxResults: 50, region: "wt-wt" })),
    );

    expect(outcome.error.code).toBe("UPSTREAM_ERROR");
    expect(outcome.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    expect(provider.getNextRetryAt()).toBe(clock.now() + 1_500);
  });
});
