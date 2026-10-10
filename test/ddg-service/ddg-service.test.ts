import { env, evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DDG_OBJECT_NAME, DdgService } from "../../src/ddg-service";
import type { ParsedPage } from "../../src/ddg/parse";
import type { FetchLike } from "../../src/ddg/request";
import { ManualClock } from "./manual-clock";

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

      return instance.search({
        params: { query: "x", maxResults: 3, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      });
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

      const challenged = await instance.search({
        params: { query: "x", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 120_000,
      });
      const stored = await state.storage.get<{
        intervalMs: number;
        consecutiveFailures: number;
        nextRetryAt: number;
      }>("ddgState");
      const immediate = await instance.search({
        params: { query: "y", maxResults: 1, region: "wt-wt" },
        deadlineAt: clock.now() + 60_000,
      });
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
});
