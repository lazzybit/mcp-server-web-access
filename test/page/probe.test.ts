import { describe, expect, it } from "vitest";
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
      userAgent: USER_AGENT,
    });
    expect(markdown.isMarkdownLike).toBe(true);
    expect(markdown.mime).toBe("text/markdown");
    expect(markdown.body).toContain("# Title");

    const plain = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => new Response("plain", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })),
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
      probePage(parsePageUrl(START), { fetch: fetchImpl, userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ pageError: { code: "BLOCKED_URL" } });
  });

  it("stops after too many redirects", async () => {
    const fetchImpl = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
    await expect(
      probePage(parsePageUrl(START), { fetch: fetchImpl, userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ pageError: { code: "FETCH_FAILED" } });
  });

  it("reports HTTP errors and retry hints", async () => {
    await expect(
      probePage(parsePageUrl(START), {
        fetch: stubFetch(() => html("nope", 404)),
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "FETCH_FAILED", retryable: true } });

    await expect(
      probePage(parsePageUrl(START), {
        fetch: stubFetch(() => html("slow down", 429, { "retry-after": "2" })),
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
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TOO_LARGE" } });
  });

  it("times out when a hop exceeds its timeout", async () => {
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
        attemptTimeoutMs: 30,
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TIMEOUT" } });
  });

  it("bounds each redirect hop independently", async () => {
    let calls = 0;
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "/next" } }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as typeof fetch;

    await expect(
      probePage(parsePageUrl(START), {
        fetch: hanging,
        attemptTimeoutMs: 30,
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TIMEOUT" } });
    expect(calls).toBe(2);
  });

  it("times out even when fetch ignores the abort signal", async () => {
    const ignoring = (() => new Promise<Response>(() => {})) as typeof fetch;
    await expect(
      probePage(parsePageUrl(START), {
        fetch: ignoring,
        attemptTimeoutMs: 30,
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TIMEOUT" } });
  });

  it("strips non-content markup while streaming", async () => {
    const body =
      `<!DOCTYPE html><!-- top --><html lang="en"><head><title>T</title>` +
      `<style>.a{color:red}</style><script>var s=1;</script>` +
      `<script type="application/ld+json">{"headline":"LD"}</script></head>` +
      `<body><!-- inner --><svg><text>svg</text></svg>` +
      `<p>Hello <a href="data:text/html,x">link</a></p>` +
      `<img src="https://example.com/a.png" srcset="data:image/png;base64,AAAA 1x, https://example.com/b.png 2x">` +
      `</body></html>`;
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => html(body)),
      userAgent: USER_AGENT,
    });
    expect(snapshot.body).not.toContain("var s=1");
    expect(snapshot.body).not.toContain("<style");
    expect(snapshot.body).not.toContain("<svg");
    expect(snapshot.body).not.toContain("<!--");
    expect(snapshot.body).not.toContain("data:image");
    expect(snapshot.body).not.toContain('href="data:');
    expect(snapshot.body).toContain('type="application/ld+json"');
    expect(snapshot.body).toContain("https://example.com/a.png");
    expect(snapshot.body).toContain("https://example.com/b.png 2x");
    expect(snapshot.body).toContain("Hello");
    expect(snapshot.bytes).toBe(new TextEncoder().encode(body).byteLength);
  });

  it("succeeds for a script-heavy page whose filtered HTML fits the cap", async () => {
    const filler = "<p>Readable content that stays in the snapshot body.</p>".repeat(20);
    const scripts = `<script>${"var x=1;".repeat(400_000)}</script>`;
    const body = `<html><head><title>Big</title></head><body>${filler}${scripts}</body></html>`;
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => html(body)),
      userAgent: USER_AGENT,
    });
    expect(snapshot.bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(snapshot.body).toContain("Readable content");
    expect(snapshot.body).not.toContain("var x=1");
    expect(new TextEncoder().encode(snapshot.body).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("fails with TOO_LARGE when the filtered HTML crosses the cap and cancels the source", async () => {
    let cancelled = false;
    let emitted = 0;
    const chunk = new TextEncoder().encode(`<p>${"x".repeat(512 * 1024 - 7)}</p>`);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 8) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      probePage(parsePageUrl(START), {
        fetch: stubFetch(() => new Response(stream, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
        userAgent: USER_AGENT,
      }),
    ).rejects.toMatchObject({ pageError: { code: "TOO_LARGE" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelled).toBe(true);
  });

  it("decodes correctly when tags, entities and multibyte characters are split across chunks", async () => {
    const value = `<html><body><p>h\u00e9llo \u2014 \u4e16\u754c &amp; more</p><script>var s=1;</script></body></html>`;
    const bytes = new TextEncoder().encode(value);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => new Response(stream, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
      userAgent: USER_AGENT,
    });
    expect(snapshot.body).toContain("h\u00e9llo \u2014 \u4e16\u754c &amp; more");
    expect(snapshot.body).not.toContain("var s=1");
    expect(snapshot.bytes).toBe(bytes.byteLength);
    expect(snapshot.features.script.bytesRatio).toBeGreaterThan(0);
    expect(snapshot.features.script.bytesRatio).toBeLessThan(1);
  });

  it("decodes a latin-1 body and keeps a sane upstream/ratio split", async () => {
    const value = `<html><body><p>caf\u00e9</p><script>var a=1;</script></body></html>`;
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value.charCodeAt(index) & 0xff;
    }
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=iso-8859-1" } })),
      userAgent: USER_AGENT,
    });
    expect(snapshot.body).toContain("caf\u00e9");
    expect(snapshot.bytes).toBe(bytes.byteLength);
    expect(snapshot.features.script.bytesRatio).toBeGreaterThan(0);
    expect(snapshot.features.script.bytesRatio).toBeLessThan(1);
  });

  it("removes an oversized inline data: asset and keeps the page", async () => {
    // A single attribute this large is still buffered by HTMLRewriter before the
    // element callback; it is filtered, so the raw size never reaches the cap.
    const data = `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`;
    const scripts = `<script>${"var x=1;".repeat(150_000)}</script>`;
    const body = `<html><body><img src="${data}"><p>Hello</p>${scripts}</body></html>`;
    const snapshot = await probePage(parsePageUrl(START), {
      fetch: stubFetch(() => html(body)),
      userAgent: USER_AGENT,
    });
    expect(snapshot.bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(snapshot.body).not.toContain("data:image");
    expect(snapshot.body).toContain("Hello");
  });
});
