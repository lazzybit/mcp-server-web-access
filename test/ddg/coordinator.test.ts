import { describe, expect, it } from "vitest";
import { SearchCoordinator } from "../../src/search/coordinator";
import type { CoordinatorDeps } from "../../src/search/coordinator";
import type {
  ProviderAvailability,
  ProviderOutcome,
  SearchProvider,
} from "../../src/search/provider";
import { makeError } from "../../src/types";
import type { SearchParams, SearchResultItem } from "../../src/types";
import { ManualClock, drive, flushMicrotasks } from "./manual-clock";

function items(urls: string[]): SearchResultItem[] {
  return urls.map((url, index) => ({
    rank: index + 1,
    title: `Title ${index}`,
    url,
    domain: new URL(url).hostname,
    snippet: null,
  }));
}

function ok(results: string[]): ProviderOutcome {
  return { kind: "done", result: { status: "ok", results: items(results) } };
}

function exhausted(results: string[] = []): ProviderOutcome {
  return { kind: "done", result: { status: "exhausted", results: items(results) } };
}

function pageLimit(results: string[]): ProviderOutcome {
  return {
    kind: "done",
    result: {
      status: "interrupted",
      results: items(results),
      error: makeError("PAGE_LIMIT", "page limit"),
    },
  };
}

function fallback(code: "PROVIDER_CHALLENGE" | "UPSTREAM_ERROR", results: string[] = []): ProviderOutcome {
  return {
    kind: "fallback",
    results: items(results),
    error: makeError(code, `${code} from provider`),
  };
}

class FakeProvider implements SearchProvider {
  readonly id: string;
  calls = 0;
  queries: string[] = [];
  calledAt: number[] = [];
  #clock: ManualClock;
  #readyAt = 0;
  #disabled = false;
  #outcomes: ProviderOutcome[];
  #fallbackCooldownMs: number;
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;

  constructor(
    id: string,
    clock: ManualClock,
    outcomes: ProviderOutcome[],
    options: { fallbackCooldownMs?: number } = {},
  ) {
    this.id = id;
    this.#clock = clock;
    this.#outcomes = outcomes;
    this.#fallbackCooldownMs = options.fallbackCooldownMs ?? 0;
  }

  disable(): void {
    this.#disabled = true;
  }

  coolFor(ms: number): void {
    this.#readyAt = this.#clock.now() + ms;
  }

  gateNext(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
  }

  availability(now: number): ProviderAvailability {
    if (this.#disabled) return { kind: "disabled" };
    const remaining = this.#readyAt - now;
    if (remaining > 0) return { kind: "cooling", retryAfterMs: remaining };
    return { kind: "ready" };
  }

  async search(params: SearchParams): Promise<ProviderOutcome> {
    this.calls += 1;
    this.queries.push(params.query);
    this.calledAt.push(this.#clock.now());
    if (this.#gate !== undefined) {
      const gate = this.#gate;
      this.#gate = undefined;
      await gate;
    }
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) throw new Error(`no scripted outcome for ${this.id}`);
    if (outcome.kind === "fallback" && this.#fallbackCooldownMs > 0) {
      this.#readyAt = this.#clock.now() + this.#fallbackCooldownMs;
    }
    return outcome;
  }
}

function coordinatorFor(clock: ManualClock, providers: SearchProvider[]): SearchCoordinator {
  const deps: CoordinatorDeps = {
    clock,
    cooldownWaitMaxMs: 10_000,
    logLevel: "error",
  };
  return new SearchCoordinator(providers, deps);
}

const REQUEST: SearchParams = { query: "x", maxResults: 5, region: "wt-wt" };

describe("SearchCoordinator", () => {
  it("falls back to the next provider within the same search", async () => {
    const clock = new ManualClock();
    const html = new FakeProvider("ddg-html", clock, [fallback("PROVIDER_CHALLENGE")]);
    const browser = new FakeProvider("ddg-browser", clock, [ok(["https://b.example/"])]);
    const coordinator = coordinatorFor(clock, [html, browser]);

    const result = await drive(clock, coordinator.search({ ...REQUEST, maxResults: 1 }));

    expect(result.status).toBe("ok");
    expect(result.results.map((item) => item.url)).toEqual(["https://b.example/"]);
    expect(html.calls).toBe(1);
    expect(browser.calls).toBe(1);
  });

  it("waits for a recovering provider when the remainder is at most 10 s", async () => {
    const clock = new ManualClock();
    const start = clock.now();
    const provider = new FakeProvider("ddg-html", clock, [exhausted(["https://a.example/"])]);
    provider.coolFor(10_000);
    const coordinator = coordinatorFor(clock, [provider]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("exhausted");
    expect(provider.calls).toBe(1);
    expect(provider.calledAt[0]).toBe(start + 10_000);
  });

  it("does not wait when the remainder is 10 001 ms", async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider("ddg-html", clock, [exhausted(["https://a.example/"])]);
    provider.coolFor(10_001);
    const coordinator = coordinatorFor(clock, [provider]);

    const result = await coordinator.search({ ...REQUEST });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    expect(result.error.retryAfterMs).toBe(10_001);
    expect(provider.calls).toBe(0);
  });

  it("waits for a provider at most once and never retries it", async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider(
      "ddg-html",
      clock,
      [fallback("UPSTREAM_ERROR"), exhausted(["https://unused.example/"])],
      { fallbackCooldownMs: 60_000 },
    );
    provider.coolFor(10_000);
    const coordinator = coordinatorFor(clock, [provider]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    expect(result.error.retryAfterMs).toBe(60_000);
    expect(provider.calls).toBe(1);
  });

  it("never waits while another provider is usable", async () => {
    const clock = new ManualClock();
    const start = clock.now();
    const cooling = new FakeProvider("a", clock, [ok(["https://a.example/"])]);
    cooling.coolFor(5_000);
    const ready = new FakeProvider("b", clock, [exhausted(["https://b.example/"])]);
    const coordinator = coordinatorFor(clock, [cooling, ready]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("exhausted");
    expect(result.results.map((item) => item.url)).toEqual(["https://b.example/"]);
    expect(ready.calls).toBe(1);
    expect(cooling.calls).toBe(0);
    expect(clock.now()).toBe(start);
  });

  it("merges and reranks partials from earlier providers into a done result", async () => {
    const clock = new ManualClock();
    const first = new FakeProvider("a", clock, [fallback("PROVIDER_CHALLENGE", ["https://a.example/"])]);
    const second = new FakeProvider("b", clock, [exhausted(["https://b.example/"])]);
    const coordinator = coordinatorFor(clock, [first, second]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("exhausted");
    expect(result.results).toEqual([
      { rank: 1, title: "Title 0", url: "https://a.example/", domain: "a.example", snippet: null },
      { rank: 2, title: "Title 0", url: "https://b.example/", domain: "b.example", snippet: null },
    ]);
  });

  it("participates all configured providers in the fallback chain", async () => {
    const clock = new ManualClock();
    const first = new FakeProvider("a", clock, [fallback("PROVIDER_CHALLENGE")]);
    const second = new FakeProvider("b", clock, [fallback("UPSTREAM_ERROR")]);
    const third = new FakeProvider("c", clock, [ok(["https://c.example/"])]);
    const coordinator = coordinatorFor(clock, [first, second, third]);

    const result = await drive(clock, coordinator.search({ ...REQUEST, maxResults: 1 }));

    expect(result.status).toBe("ok");
    expect(result.results.map((item) => item.url)).toEqual(["https://c.example/"]);
    expect([first.calls, second.calls, third.calls]).toEqual([1, 1, 1]);
  });

  it("stops fallback on ok and on exhausted (including zero matches)", async () => {
    const clock = new ManualClock();
    const first = new FakeProvider("a", clock, [ok(["https://a.example/"])]);
    const second = new FakeProvider("b", clock, [ok(["https://b.example/"])]);
    const coordinator = coordinatorFor(clock, [first, second]);

    const okResult = await drive(clock, coordinator.search({ ...REQUEST, maxResults: 1 }));
    expect(okResult.status).toBe("ok");
    expect(second.calls).toBe(0);

    const emptyFirst = new FakeProvider("a", clock, [exhausted()]);
    const emptySecond = new FakeProvider("b", clock, [ok(["https://b.example/"])]);
    const emptyCoordinator = coordinatorFor(clock, [emptyFirst, emptySecond]);
    const emptyResult = await drive(clock, emptyCoordinator.search({ ...REQUEST }));
    expect(emptyResult.status).toBe("exhausted");
    expect(emptyResult.results).toHaveLength(0);
    expect(emptySecond.calls).toBe(0);
  });

  it("does not fall back on a page limit", async () => {
    const clock = new ManualClock();
    const first = new FakeProvider("a", clock, [pageLimit(["https://a.example/"])]);
    const second = new FakeProvider("b", clock, [ok(["https://b.example/"])]);
    const coordinator = coordinatorFor(clock, [first, second]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("interrupted");
    expect(result.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    if (result.status !== "interrupted") return;
    expect(result.error.code).toBe("PAGE_LIMIT");
    expect(second.calls).toBe(0);
  });

  it("returns NO_SEARCH_PROVIDER_AVAILABLE with retained partial results", async () => {
    const clock = new ManualClock();
    const first = new FakeProvider(
      "a",
      clock,
      [fallback("PROVIDER_CHALLENGE", ["https://a.example/"])],
      { fallbackCooldownMs: 60_000 },
    );
    const second = new FakeProvider("b", clock, [fallback("UPSTREAM_ERROR")]);
    second.disable();
    const coordinator = coordinatorFor(clock, [first, second]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("interrupted");
    expect(result.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    if (result.status !== "interrupted") return;
    expect(result.error.code).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    expect(result.error.retryAfterMs).toBe(60_000);
    expect(second.calls).toBe(0);
  });

  it("reports the minimum known recovery and recomputes it at return", async () => {
    const clock = new ManualClock();
    const a = new FakeProvider("a", clock, [fallback("UPSTREAM_ERROR")]);
    a.coolFor(30_000);
    const b = new FakeProvider("b", clock, [exhausted()]);
    b.coolFor(20_000);
    const coordinator = coordinatorFor(clock, [a, b]);

    const result = await coordinator.search({ ...REQUEST });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.retryAfterMs).toBe(20_000);
    expect([a.calls, b.calls]).toEqual([0, 0]);
  });

  it("recomputes the recovery hint after a wait and a provider failure", async () => {
    const clock = new ManualClock();
    const a = new FakeProvider("a", clock, [fallback("UPSTREAM_ERROR")], {
      fallbackCooldownMs: 5_000,
    });
    a.coolFor(8_000);
    const b = new FakeProvider("b", clock, [exhausted()]);
    b.coolFor(20_000);
    const coordinator = coordinatorFor(clock, [a, b]);

    const result = await drive(clock, coordinator.search({ ...REQUEST }));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("NO_SEARCH_PROVIDER_AVAILABLE");
    // a's cooldown started after the 8 s wait; b still has 12 s to recover.
    expect(result.error.retryAfterMs).toBe(5_000);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
  });

  it("runs queued searches FIFO and one at a time", async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider("a", clock, [
      ok(["https://first.example/"]),
      ok(["https://second.example/"]),
    ]);
    provider.gateNext();
    const coordinator = coordinatorFor(clock, [provider]);

    const first = coordinator.search({ query: "first", maxResults: 1, region: "wt-wt" });
    const second = coordinator.search({ query: "second", maxResults: 1, region: "wt-wt" });

    await flushMicrotasks();
    expect(provider.calls).toBe(1);

    provider.release();
    const [firstResult, secondResult] = await drive(clock, Promise.all([first, second]));

    expect(firstResult.status).toBe("ok");
    expect(secondResult.status).toBe("ok");
    expect(provider.queries).toEqual(["first", "second"]);
  });
});
