import { describe, expect, it } from "vitest";
import { DdgEngine, defaultDdgDeps } from "../../src/ddg/engine";
import type { DdgDeps, ParseFn, StoragePort } from "../../src/ddg/engine";
import { COOLDOWN_WAIT_MAX_MS } from "../../src/constants";
import { DEFAULT_ENDPOINT } from "../../src/ddg/request";
import type { FetchLike } from "../../src/ddg/request";
import type { ParsedPage } from "../../src/ddg/parse";
import type { AppEnv } from "../../src/env";
import type { SearchResult } from "../../src/types";
import { ManualClock, drive, flushMicrotasks } from "./manual-clock";

function codeOf(result: SearchResult): string | undefined {
  return "error" in result ? result.error.code : undefined;
}

interface PersistedState {
  v: 1;
  intervalMs: number;
  consecutiveFailures: number;
  nextRetryAt: number;
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

class GatedStorage extends MemoryStorage {
  gate: Promise<void> | undefined;

  override async put<T>(key: string, value: T): Promise<void> {
    if (this.gate !== undefined) await this.gate;
    this.puts += 1;
    this.values.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override async put<T>(_key: string, _value: T): Promise<void> {
    throw new Error("storage unavailable");
  }
}

/** Upstream stub: keys pages by the form's `s` offset. */
class Upstream {
  lastForm = new URLSearchParams();
  pages: Record<string, ParsedPage> = {};
  statuses: Record<string, number> = {};
  gate: Promise<Response> | undefined;
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
    if (this.gate !== undefined) {
      const gate = this.gate;
      this.gate = undefined;
      return gate;
    }
    return new Response("body", { status: this.statuses[s] ?? 200 });
  };

  parse: ParseFn = async () => {
    const s = this.lastForm.get("s") ?? "0";
    return this.pages[s] ?? { kind: "unparseable" };
  };
}

function deps(clock: ManualClock, upstream: Upstream, overrides: Partial<DdgDeps> = {}): DdgDeps {
  return {
    clock,
    fetchImpl: upstream.fetchImpl,
    parse: upstream.parse,
    endpoint: "https://html.duckduckgo.com/html/",
    maxBodyBytes: 2 * 1024 * 1024,
    minIntervalMs: 5_000,
    maxIntervalMs: 20_000,
    increaseFactor: 2,
    decreaseFactor: 0.7071,
    failureThreshold: 3,
    attemptTimeoutMs: 10_000,
    cooldownMs: 60_000,
    cooldownWaitMaxMs: COOLDOWN_WAIT_MAX_MS,
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

function engineFor(clock: ManualClock, upstream: Upstream, overrides: Partial<DdgDeps> = {}) {
  const storage = new MemoryStorage();
  const engine = new DdgEngine(storage, deps(clock, upstream, overrides));
  return { engine, storage };
}

function saveState(storage: MemoryStorage, partial: Partial<PersistedState> = {}): PersistedState {
  const state: PersistedState = {
    v: 1,
    intervalMs: 5_000,
    consecutiveFailures: 0,
    nextRetryAt: 0,
    ...partial,
  };
  storage.values.set("ddgState", state);
  return state;
}

const REQUEST = { params: { query: "x", maxResults: 4, region: "wt-wt" } };

describe("defaultDdgDeps", () => {
  it("always uses the compiled-in upstream endpoint", () => {
    const dev = defaultDdgDeps({ ENVIRONMENT: "development", LOG_LEVEL: "info" } as AppEnv);
    const prod = defaultDdgDeps({ ENVIRONMENT: "production", LOG_LEVEL: "error" } as AppEnv);
    expect(dev.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(prod.endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it("uses the compiled-in adaptive pacing bounds and factors", () => {
    const env = { ENVIRONMENT: "development", LOG_LEVEL: "info" } as AppEnv;
    const resolved = defaultDdgDeps(env);
    expect(resolved.minIntervalMs).toBe(5_000);
    expect(resolved.maxIntervalMs).toBe(20_000);
    expect(resolved.increaseFactor).toBeGreaterThan(1);
    expect(resolved.decreaseFactor).toBeGreaterThan(0);
    expect(resolved.decreaseFactor).toBeLessThan(1);
    expect(resolved.increaseFactor * resolved.decreaseFactor).toBeGreaterThan(1);
    expect(resolved.failureThreshold).toBe(3);
  });
});

describe("DdgEngine", () => {
  it("paginates, deduplicates and reports ok at the requested count", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a.example/", "https://b.example/"], "25"),
      "25": page(["https://b.example/", "https://c.example/", "https://d.example/"], null),
    };
    const { engine } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({ params: { ...REQUEST.params }, deadlineAt: clock.now() + 60_000 }),
    );

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
    const { engine } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 10, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );
    expect(result.status).toBe("exhausted");
    expect(result.results).toHaveLength(1);
  });

  it("paces dispatches across consecutive searches", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const { engine } = engineFor(clock, upstream);

    const first = engine.search({
      params: { query: "a", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    const second = engine.search({
      params: { query: "b", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });

    await drive(clock, first);
    await drive(clock, second);

    expect(upstream.calls).toHaveLength(2);
    const [firstCall, secondCall] = upstream.calls;
    expect(secondCall!.at - firstCall!.at).toBeGreaterThanOrEqual(5_000);
  });

  it("times out a job while it is still queued", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    let release: (response: Response) => void = () => {};
    upstream.gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { engine } = engineFor(clock, upstream);

    const active = engine.search({
      params: { query: "a", maxResults: 50, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    const queued = engine.search({
      params: { query: "b", maxResults: 50, region: "wt-wt" },
      deadlineAt: clock.now() + 1_000,
    });

    await flushMicrotasks();
    await clock.advance(1_000);
    const queuedResult = await queued;
    expect(queuedResult.status).toBe("failed");
    expect(codeOf(queuedResult)).toBe("TIMEOUT");

    release(new Response("body", { status: 200 }));
    const activeResult = await drive(clock, active);
    expect(activeResult.status).toBe("exhausted");
  });

  it("aborts an active job at its deadline and keeps partial results", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], "25") };
    upstream.blockOn = new Set(["25"]);
    const { engine } = engineFor(clock, upstream);

    const promise = engine.search({
      params: { query: "a", maxResults: 50, region: "wt-wt" },
      deadlineAt: clock.now() + 5_000,
    });
    const result = await drive(clock, promise);

    expect(result.status).toBe("interrupted");
    expect(result.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    if (result.status !== "interrupted") return;
    expect(result.error.code).toBe("ABORTED");
    // A job deadline must not count as an upstream failure or set a cooldown.
    expect(engine.getNextRetryAt()).toBe(0);
    expect(engine.getConsecutiveFailures()).toBe(0);
  });

  it("retries the same page and enters cooldown on the third consecutive failure", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const { engine, storage } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );

    expect(codeOf(result)).toBe("PROVIDER_CHALLENGE");
    if ("error" in result) expect(result.error.retryAfterMs).toBe(60_000);
    expect(upstream.calls.map((call) => call.s)).toEqual(["0", "0", "0"]);
    expect(engine.getNextRetryAt()).toBe(clock.now() + 60_000);
    expect(engine.getConsecutiveFailures()).toBe(0);
    const stored = storage.values.get("ddgState") as PersistedState;
    expect(stored.nextRetryAt).toBe(clock.now() + 60_000);
    expect(stored.consecutiveFailures).toBe(0);

    const immediate = await engine.search({
      params: { query: "y", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    expect(codeOf(immediate)).toBe("RATE_LIMITED");
    expect(upstream.calls).toHaveLength(3);
  });

  it("flushes queued searches when retries trigger a cooldown", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const { engine } = engineFor(clock, upstream);

    const first = engine.search({
      params: { query: "a", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 120_000,
    });
    const second = engine.search({
      params: { query: "b", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 120_000,
    });

    const [firstResult, secondResult] = await drive(clock, Promise.all([first, second]));

    expect(codeOf(firstResult)).toBe("PROVIDER_CHALLENGE");
    expect(codeOf(secondResult)).toBe("RATE_LIMITED");
    expect(upstream.calls).toHaveLength(3);
  });

  it("rejects queued searches before the cooldown persist completes", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const storage = new GatedStorage();
    saveState(storage, { intervalMs: 10_000, consecutiveFailures: 2 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    let release: () => void = () => {};
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let firstSettled = false;
    const first = engine
      .search({
        params: { query: "a", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      })
      .then((value) => {
        firstSettled = true;
        return value;
      });
    const second = engine.search({
      params: { query: "b", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });

    await flushMicrotasks(10);
    expect(firstSettled).toBe(false);
    const secondResult = await second;
    expect(codeOf(secondResult)).toBe("RATE_LIMITED");
    expect(firstSettled).toBe(false);

    release();
    const firstResult = await first;
    expect(codeOf(firstResult)).toBe("PROVIDER_CHALLENGE");
    expect((storage.values.get("ddgState") as PersistedState).nextRetryAt).toBe(
      clock.now() + 60_000,
    );
  });

  it("expires a cooldown without writing storage", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    const stored = saveState(storage, { nextRetryAt: clock.now() + 1_000 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();
    const putsAfterLoad = storage.puts;

    await clock.advance(1_001);
    const result = await drive(
      clock,
      engine.search({
        params: { query: "y", maxResults: 2, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );

    expect(result.status).toBe("exhausted");
    expect(storage.puts).toBe(putsAfterLoad);
    expect((storage.values.get("ddgState") as PersistedState).nextRetryAt).toBe(stored.nextRetryAt);
  });

  it("grows the interval on failure up to the clamp and decays it on success", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const { engine, storage } = engineFor(clock, upstream);

    const failed = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );
    expect(codeOf(failed)).toBe("PROVIDER_CHALLENGE");
    expect(engine.getIntervalMs()).toBe(20_000);
    expect((storage.values.get("ddgState") as PersistedState).intervalMs).toBe(20_000);

    upstream.pages = { "0": page(["https://a.example/"], null) };
    await clock.advance(60_001);
    const ok = await drive(
      clock,
      engine.search({
        params: { query: "y", maxResults: 2, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );
    expect(ok.status).toBe("exhausted");
    expect(engine.getIntervalMs()).toBe(20_000 * 0.7071);
    expect((storage.values.get("ddgState") as PersistedState).intervalMs).toBe(
      20_000 * 0.7071,
    );
  });

  it("resets the failure streak after a successful page", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    saveState(storage, { intervalMs: 10_000, consecutiveFailures: 2 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 2, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );
    expect(result.status).toBe("exhausted");
    expect(engine.getConsecutiveFailures()).toBe(0);
    expect(engine.getIntervalMs()).toBe(10_000 * 0.7071);
  });

  it("persists and restores the interval and failure streak", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const storage = new MemoryStorage();
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    // A short deadline stops the job after two failures, before the third
    // attempt can trigger cooldown.
    const partial = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 12_000,
      }),
    );
    expect(codeOf(partial)).toBe("ABORTED");
    expect(engine.getConsecutiveFailures()).toBe(2);
    expect(engine.getIntervalMs()).toBe(20_000);
    expect(upstream.calls).toHaveLength(2);

    const restored = new DdgEngine(storage, deps(clock, new Upstream(clock)));
    await restored.load();
    expect(restored.getConsecutiveFailures()).toBe(2);
    expect(restored.getIntervalMs()).toBe(20_000);
  });

  it("keeps draining when the parser throws", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    let parseCalls = 0;
    const parse: ParseFn = async () => {
      parseCalls += 1;
      if (parseCalls === 1) throw new Error("parser exploded");
      return page(["https://a.example/"], null);
    };
    const { engine } = engineFor(clock, upstream, { parse });

    const result = await drive(
      clock,
      engine.search({
        params: { query: "a", maxResults: 2, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );

    // The parser throw is a retryable PARSE_FAILED, so the retry recovers.
    expect(result.status).toBe("exhausted");
    expect(upstream.calls).toHaveLength(2);
    expect(engine.getConsecutiveFailures()).toBe(0);
  });

  it("enters cooldown after three consecutive parser failures", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const parse: ParseFn = async () => {
      throw new Error("parser exploded");
    };
    const { engine } = engineFor(clock, upstream, { parse });

    const result = await drive(
      clock,
      engine.search({
        params: { query: "a", maxResults: 2, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );

    expect(codeOf(result)).toBe("PARSE_FAILED");
    expect(upstream.calls).toHaveLength(3);
    expect(engine.getNextRetryAt()).toBe(clock.now() + 1_500);
  });

  it("enters cooldown after three consecutive transport failures", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    upstream.throwOn = new Set(["0"]);
    const { engine } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({
        params: { query: "a", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );

    expect(codeOf(result)).toBe("UPSTREAM_ERROR");
    expect(upstream.calls).toHaveLength(3);
    expect(engine.getNextRetryAt()).toBe(clock.now() + 1_500);
  });

  it("handles a failed cooldown write without stalling", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    const storage = new ThrowingStorage();
    saveState(storage, { intervalMs: 10_000, consecutiveFailures: 2 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );

    expect(codeOf(result)).toBe("PROVIDER_CHALLENGE");
    expect(engine.getNextRetryAt()).toBe(clock.now() + 60_000);
    expect(upstream.calls).toHaveLength(1);
  });

  it("holds the active slot through abort cleanup before the next dispatch", async () => {
    const clock = new ManualClock();
    const start = clock.now();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], "25") };
    upstream.blockOn = new Set(["25"]);
    const { engine } = engineFor(clock, upstream);

    const first = engine.search({
      params: { query: "a", maxResults: 50, region: "wt-wt" },
      deadlineAt: start + 5_000,
    });
    const second = engine.search({
      params: { query: "b", maxResults: 1, region: "wt-wt" },
      deadlineAt: start + 60_000,
    });
    const [firstResult] = await drive(clock, Promise.all([first, second]));

    expect(firstResult.status).toBe("interrupted");
    const firstPageCalls = upstream.calls.filter((call) => call.s === "0");
    expect(firstPageCalls).toHaveLength(2);
    // The second job only dispatches after the first was aborted at its deadline.
    expect(firstPageCalls[1]!.at).toBeGreaterThanOrEqual(start + 5_000);
  });

  it("treats an unparseable page as a retryable PARSE_FAILED", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "unparseable" } };
    const { engine, storage } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );

    expect(codeOf(result)).toBe("PARSE_FAILED");
    if ("error" in result) expect(result.error.retryable).toBe(true);
    expect(upstream.calls).toHaveLength(3);
    expect(engine.getNextRetryAt()).toBe(clock.now() + 1_500);
    expect((storage.values.get("ddgState") as PersistedState).nextRetryAt).toBe(
      clock.now() + 1_500,
    );
  });

  it("classifies HTTP 429 as a provider challenge", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    upstream.statuses = { "0": 429 };
    const { engine } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );
    expect(codeOf(result)).toBe("PROVIDER_CHALLENGE");
    expect(upstream.calls).toHaveLength(3);
    expect(engine.getNextRetryAt()).toBe(clock.now() + 60_000);
  });

  it("detects an anomaly challenge that arrives with an error status", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": { kind: "challenge" } };
    upstream.statuses = { "0": 503 };
    const { engine } = engineFor(clock, upstream);

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      }),
    );
    expect(codeOf(result)).toBe("PROVIDER_CHALLENGE");
  });

  it("does not write storage on a successful search", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const { engine, storage } = engineFor(clock, upstream);

    await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      }),
    );
    expect(storage.puts).toBe(0);
  });

  it("loads a persisted cooldown on start", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const storage = new MemoryStorage();
    saveState(storage, { nextRetryAt: clock.now() + 30_000 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await engine.search({
      params: { query: "x", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    expect(codeOf(result)).toBe("RATE_LIMITED");
    expect(upstream.calls).toHaveLength(0);
  });

  it("waits out a restored cooldown of exactly the wait limit", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    const start = clock.now();
    saveState(storage, { nextRetryAt: start + 10_000 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: start + 60_000,
      }),
    );

    expect(result.status).toBe("ok");
    // Nothing dispatches before the cooldown expires, and no pacing wait is
    // added on top (there was no previous dispatch).
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.at).toBe(start + 10_000);
  });

  it("rejects a cooldown just beyond the wait limit", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    const start = clock.now();
    saveState(storage, { nextRetryAt: start + 10_001 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await engine.search({
      params: { query: "x", maxResults: 1, region: "wt-wt" },
      deadlineAt: start + 60_000,
    });

    expect(codeOf(result)).toBe("RATE_LIMITED");
    if ("error" in result) expect(result.error.retryAfterMs).toBe(10_001);
    expect(upstream.calls).toHaveLength(0);
  });

  it("rejects a cooldown that outlasts the deadline", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    const start = clock.now();
    saveState(storage, { nextRetryAt: start + 9_000 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await engine.search({
      params: { query: "x", maxResults: 1, region: "wt-wt" },
      deadlineAt: start + 5_000,
    });

    expect(codeOf(result)).toBe("RATE_LIMITED");
    expect(upstream.calls).toHaveLength(0);
  });

  it("waits out a short transient cooldown within the threshold", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    const start = clock.now();
    saveState(storage, { nextRetryAt: start + 1_500 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: start + 60_000,
      }),
    );

    expect(result.status).toBe("ok");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.at).toBe(start + 1_500);
  });

  it("runs multiple admitted searches FIFO and paced after a cooldown", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new MemoryStorage();
    const start = clock.now();
    saveState(storage, { intervalMs: 5_000, nextRetryAt: start + 3_000 });
    const engine = new DdgEngine(
      storage,
      deps(clock, upstream, { increaseFactor: 1, decreaseFactor: 1 }),
    );
    await engine.load();

    const first = engine.search({
      params: { query: "a", maxResults: 1, region: "wt-wt" },
      deadlineAt: start + 60_000,
    });
    const second = engine.search({
      params: { query: "b", maxResults: 1, region: "wt-wt" },
      deadlineAt: start + 60_000,
    });
    await drive(clock, Promise.all([first, second]));

    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0]!.at).toBe(start + 3_000);
    expect(upstream.calls[1]!.at - upstream.calls[0]!.at).toBeGreaterThanOrEqual(5_000);
  });

  it("still aborts an active job at its deadline after waiting out a cooldown", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], "25") };
    upstream.blockOn = new Set(["25"]);
    const storage = new MemoryStorage();
    const start = clock.now();
    saveState(storage, { nextRetryAt: start + 8_000 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 50, region: "wt-wt" },
        deadlineAt: start + 20_000,
      }),
    );

    expect(result.status).toBe("interrupted");
    expect(codeOf(result)).toBe("ABORTED");
    expect(result.results.map((item) => item.url)).toEqual(["https://a.example/"]);
    expect(upstream.calls).toHaveLength(2);
    // The first dispatch happens only after the cooldown has expired.
    expect(upstream.calls[0]!.at).toBe(start + 8_000);
    // A deadline abort must not count as an upstream failure or set a cooldown.
    expect(engine.getNextRetryAt()).toBe(start + 8_000);
  });

  it("keeps an eligible arrival that lands while a cooldown write is pending", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://late.example/"], null) };
    upstream.throwOn = new Set(["0"]);
    const storage = new GatedStorage();
    saveState(storage, { intervalMs: 5_000, consecutiveFailures: 2 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    let release: () => void = () => {};
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The third consecutive failure enters a 1.5 s transient cooldown, then
    // blocks on the storage write.
    const triggering = engine.search({
      params: { query: "a", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    await flushMicrotasks(10);

    // Arrives while the write is pending: the remainder is within the wait
    // limit, so it is admitted rather than rejected.
    const late = engine.search({
      params: { query: "b", maxResults: 10, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });

    release();
    upstream.throwOn = new Set();

    const triggeringResult = await drive(clock, triggering);
    expect(codeOf(triggeringResult)).toBe("UPSTREAM_ERROR");

    const lateResult = await drive(clock, late);
    expect(lateResult.status).toBe("exhausted");
    expect(lateResult.results.map((item) => item.url)).toEqual(["https://late.example/"]);
    expect(upstream.calls).toHaveLength(2);
  });

  it("waits out a cooldown when the storage write keeps failing", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = { "0": page(["https://a.example/"], null) };
    const storage = new ThrowingStorage();
    const start = clock.now();
    saveState(storage, { nextRetryAt: start + 2_000 });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    const result = await drive(
      clock,
      engine.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: start + 60_000,
      }),
    );

    expect(result.status).toBe("ok");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.at).toBe(start + 2_000);
  });

  it("ignores a legacy nextRetryAt key", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const storage = new MemoryStorage();
    storage.values.set("nextRetryAt", clock.now() + 10_000);
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    expect(engine.getNextRetryAt()).toBe(0);
    expect(engine.getIntervalMs()).toBe(5_000);
  });

  it("clamps a corrupt snapshot", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const storage = new MemoryStorage();
    storage.values.set("ddgState", {
      v: 1,
      intervalMs: 999_999,
      consecutiveFailures: 99,
      nextRetryAt: -5,
    });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    expect(engine.getIntervalMs()).toBe(20_000);
    expect(engine.getConsecutiveFailures()).toBe(3);
    expect(engine.getNextRetryAt()).toBe(0);
  });

  it("ignores an unknown snapshot version", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    const storage = new MemoryStorage();
    storage.values.set("ddgState", {
      v: 2,
      intervalMs: 7_000,
      consecutiveFailures: 2,
      nextRetryAt: 123,
    });
    const engine = new DdgEngine(storage, deps(clock, upstream));
    await engine.load();

    expect(engine.getIntervalMs()).toBe(5_000);
    expect(engine.getConsecutiveFailures()).toBe(0);
    expect(engine.getNextRetryAt()).toBe(0);
  });

  it("retries the same page ahead of queued searches", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a.example/"], "25"),
      "25": page(["https://b.example/"], null),
    };
    let failures = 0;
    const parse: ParseFn = async () => {
      const s = upstream.lastForm.get("s") ?? "0";
      if (s === "25") {
        failures += 1;
        if (failures === 1) return { kind: "unparseable" };
      }
      return upstream.pages[s] ?? { kind: "unparseable" };
    };
    const { engine } = engineFor(clock, upstream, { parse });

    const first = engine.search({
      params: { query: "a", maxResults: 50, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    const second = engine.search({
      params: { query: "b", maxResults: 1, region: "wt-wt" },
      deadlineAt: clock.now() + 60_000,
    });
    const [firstResult] = await drive(clock, Promise.all([first, second]));

    expect(firstResult.status).toBe("exhausted");
    expect(firstResult.results.map((item) => item.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    // The retried page runs again before the queued search starts.
    expect(upstream.calls.map((call) => call.s)).toEqual(["0", "25", "25", "0"]);
  });

  it("runs whole multipage searches FIFO without interleaving", async () => {
    const clock = new ManualClock();
    const upstream = new Upstream(clock);
    upstream.pages = {
      "0": page(["https://a0.example/"], "25"),
      "25": page(["https://a1.example/"], null),
    };
    const { engine } = engineFor(clock, upstream);

    const first = engine.search({
      params: { query: "first", maxResults: 50, region: "wt-wt" },
      deadlineAt: clock.now() + 120_000,
    });
    const second = engine.search({
      params: { query: "second", maxResults: 50, region: "wt-wt" },
      deadlineAt: clock.now() + 120_000,
    });
    let firstResolvedAt = -1;
    void first.then(() => {
      firstResolvedAt = clock.now();
    });

    await drive(clock, Promise.all([first, second]));

    expect(upstream.calls.map((call) => call.s)).toEqual(["0", "25", "0", "25"]);
    for (let i = 1; i < upstream.calls.length; i += 1) {
      expect(upstream.calls[i]!.at - upstream.calls[i - 1]!.at).toBeGreaterThanOrEqual(5_000);
    }
    expect(firstResolvedAt).toBeLessThanOrEqual(upstream.calls[2]!.at);
  });
});
