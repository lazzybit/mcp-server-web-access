import { describe, expect, it, vi } from "vitest";
import { Deadline } from "../../src/page/deadline";
import { decideNeedsRender, needsRender } from "../../src/page/decide";
import { emptyFeatures } from "../../src/page/types";
import type { PageSnapshot } from "../../src/page/types";

const SYNTHETIC_KEY = "sk-synthetic-placeholder";

function snapshot(): PageSnapshot {
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    mime: "text/html",
    body: "<html></html>",
    bytes: 13,
    redirects: 0,
    isMarkdownLike: false,
    features: { ...emptyFeatures(), textChars: 10, sample: "sample text" },
  };
}

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function options(fetchImpl: typeof fetch, key: () => Promise<string> = async () => SYNTHETIC_KEY) {
  return { fetch: fetchImpl, getApiKey: key, deadline: new Deadline(5_000) };
}

describe("decideNeedsRender", () => {
  it("parses a valid noul answer", async () => {
    const decision = await decideNeedsRender(
      snapshot(),
      options(jsonFetch({ answers: { needs_render: { type: "noul", noul: 0.87 } } })),
    );
    expect(decision).toEqual({ source: "model", model: "typesafe/jev-1.13", needsRender: 0.87 });
    expect(needsRender(decision, 0.5)).toBe(true);
  });

  it("treats non-2xx as a decision failure", async () => {
    const decision = await decideNeedsRender(
      snapshot(),
      options(jsonFetch({ error: "nope" }, 503)),
    );
    expect(decision.source).toBe("error");
    expect(decision.needsRender).toBeNull();
    expect(needsRender(decision, 0.5)).toBe(false);
  });

  it("treats malformed JSON as a decision failure", async () => {
    const decision = await decideNeedsRender(
      snapshot(),
      options((async () => new Response("not-json")) as typeof fetch),
    );
    expect(decision.source).toBe("error");
  });

  it("treats missing fields and invalid values as failures", async () => {
    const cases: unknown[] = [
      {},
      { answers: {} },
      { answers: { needs_render: { type: "noul" } } },
      { answers: { needs_render: { type: "boolean", noul: 1 } } },
      { answers: { needs_render: { type: "noul", noul: "1" } } },
      { answers: { needs_render: { type: "noul", noul: 2 } } },
      { answers: { needs_render: { type: "noul", noul: Number.NaN } } },
    ];
    for (const payload of cases) {
      const decision = await decideNeedsRender(snapshot(), options(jsonFetch(payload)));
      expect(decision.source).toBe("error");
    }
  });

  it("treats a redirect response as a decision failure and does not follow it", async () => {
    let redirect: string | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://example.com/elsewhere" } });
    }) as typeof fetch;
    const decision = await decideNeedsRender(snapshot(), options(fetchImpl));
    expect(decision.source).toBe("error");
    expect(redirect).toBe("manual");
  });

  it("calls the endpoint at most once", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ answers: { needs_render: { type: "noul", noul: 0.1 } } }));
    }) as typeof fetch;
    await decideNeedsRender(snapshot(), options(fetchImpl));
    expect(calls).toBe(1);
  });

  it("fails without calling the network when the secret is unavailable", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const decision = await decideNeedsRender(
      snapshot(),
      options(fetchImpl, async () => {
        throw new Error("secret unavailable");
      }),
    );
    expect(decision.source).toBe("error");
    expect(calls).toBe(0);
  });

  it("fails when the request exceeds the deadline", async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    const decision = await decideNeedsRender(snapshot(), {
      fetch: hanging,
      getApiKey: async () => SYNTHETIC_KEY,
      deadline: new Deadline(30),
    });
    expect(decision.source).toBe("error");
  });

  it("never leaks the credential into the returned value or logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const decision = await decideNeedsRender(
        snapshot(),
        options(jsonFetch({ answers: { needs_render: { type: "noul", noul: 0.5 } } })),
      );
      expect(JSON.stringify(decision)).not.toContain(SYNTHETIC_KEY);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SYNTHETIC_KEY);
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
