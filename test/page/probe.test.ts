import { describe, expect, it } from "vitest";
import { Deadline } from "../../src/page/deadline";
import { probePage } from "../../src/page/probe";
import { parsePageUrl } from "../../src/page/ssrf";

const START = "https://example.com/start";
const USER_AGENT = "test/0.1";

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

describe("probePage", () => {
  it("returns a snapshot for static HTML with features", async () => {
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => html("<html lang='en'><head><title>T</title></head><body><p>Hello</p></body></html>")),
      deadline: new Deadline(5_000),
      userAgent: USER_AGENT,
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.mime).toBe("text/html");
    expect(snapshot.isMarkdownLike).toBe(false);
    expect(snapshot.features.title).toBe("T");
    expect(snapshot.finalUrl).toBe(START);
    expect(snapshot.bytes).toBeGreaterThan(0);
  });

  it("passes through text/markdown and text/plain without features", async () => {
    const markdown = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => new Response("# Title\n", { status: 200, headers: { "content-type": "text/markdown" } })),
      deadline: new Deadline(5_000),
      userAgent: USER_AGENT,
    });
    expect(markdown.isMarkdownLike).toBe(true);
    expect(markdown.mime).toBe("text/markdown");
    expect(markdown.body).toContain("# Title");

    const plain = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => new Response("plain", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })),
      deadline: new Deadline(5_000),
      userAgent: USER_AGENT,
    });
    expect(plain.isMarkdownLike).toBe(true);
    expect(plain.body).toBe("plain");
  });

  it("decodes a chunked body assembled from many pieces", async () => {
    const parts = ["<html><body><p>", "Hello ", "chunked ", "world", "</p></body></html>"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => new Response(stream, { status: 200, headers: { "content-type": "text/html" } })),
      deadline: new Deadline(5_000),
      userAgent: USER_AGENT,
    });
    expect(snapshot.body).toBe(parts.join(""));
    expect(snapshot.features.textChars).toBe("Hello chunked world".length);
  });

  it("follows validated redirects", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: "/next" } });
      }
      return html("<html><body><p>done</p></body></html>");
    });
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: fetchImpl,
      deadline: new Deadline(5_000),
      userAgent: USER_AGENT,
    });
    expect(snapshot.finalUrl).toBe("https://example.com/next");
    expect(snapshot.redirects).toBe(1);
  });

  it("rejects a redirect to a blocked host", async () => {
    const fetchImpl = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    );
    await expect(
      probePage(parsePageUrl(START), { fetch: fetchImpl, deadline: new Deadline(5_000), userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ pageError: { code: "BLOCKED_URL" } });
  });

  it("stops after too many redirects", async () => {
    const fetchImpl = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
    await expect(
      probePage(parsePageUrl(START), { fetch: fetchImpl, deadline: new Deadline(5_000), userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ pageError: { code: "FETCH_FAILED" } });
  });

  it("reports HTTP errors and retry hints", async () => {
    await expect(
      probePage(parsePageUrl(START), {
        fetch: stubFetch(() => html("nope", 404)),
        deadline: new Deadline(5_000),
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "FETCH_FAILED", retryable: true } });

    await expect(
      probePage(parsePageUrl(START), {
        fetch: stubFetch(() => html("slow down", 429, { "retry-after": "2" })),
        deadline: new Deadline(5_000),
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "FETCH_FAILED", retryAfterMs: 2_000 } });
  });

  it("fails with TOO_LARGE as soon as the body cap is crossed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    await expect(
      probePage(parsePageUrl(START), {
        fetch: stubFetch(() => new Response(stream, { status: 200, headers: { "content-type": "text/html" } })),
        deadline: new Deadline(5_000),
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TOO_LARGE" } });
  });

  it("times out when a stage exceeds the deadline", async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;

    await expect(
      probePage(parsePageUrl(START), {
        fetch: hanging,
        deadline: new Deadline(30),
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TIMEOUT" } });
  });
});
