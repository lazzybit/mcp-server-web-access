import { describe, expect, it } from "vitest";
import { normalizeResultUrl, parsePage } from "../../src/ddg/parse";
import adsOnly from "../fixtures/ads_only.html?raw";
import challenge from "../fixtures/challenge.html?raw";
import malformed from "../fixtures/malformed.html?raw";
import noResults from "../fixtures/no_results.html?raw";
import page1 from "../fixtures/results_page1.html?raw";
import page2 from "../fixtures/results_page2.html?raw";

const BASE = "https://html.duckduckgo.com/html/";

function bytes(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

/** Yields the encoded HTML in deliberately tiny, arbitrary chunks. */
function chunked(html: string, size: number): ReadableStream<Uint8Array> {
  const encoded = bytes(html);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoded.slice(offset, offset + size));
      offset += size;
    },
  });
}

describe("normalizeResultUrl", () => {
  it("resolves, unwraps uddg, drops fragments and rejects ads", () => {
    expect(
      normalizeResultUrl(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%23frag&rut=z",
        BASE,
      ),
    ).toEqual({ url: "https://example.com/a?x=1", domain: "example.com" });
    expect(normalizeResultUrl("/docs/page", "https://example.com/root/")).toEqual({
      url: "https://example.com/docs/page",
      domain: "example.com",
    });
    expect(normalizeResultUrl("https://duckduckgo.com/y.js?ad=1", BASE)).toBeNull();
    expect(normalizeResultUrl("javascript:alert(1)", BASE)).toBeNull();
  });
});

describe("parsePage", () => {
  it("extracts organic results, filters ads and decodes entities", async () => {
    const page = await parsePage(bytes(page1), 200, BASE);
    expect(page.kind).toBe("results");
    if (page.kind !== "results") return;
    expect(page.results).toEqual([
      {
        title: "Alpha & One",
        url: "https://example.com/alpha",
        domain: "example.com",
        snippet: "First snippet about alpha.",
      },
      {
        title: "Beta Two",
        url: "https://example.com/beta",
        domain: "example.com",
        snippet: "Second snippet with <tag> entities.",
      },
      {
        title: "Gamma Headline",
        url: "https://news.example.org/gamma",
        domain: "news.example.org",
        snippet: null,
      },
    ]);
  });

  it("returns the forward Next form and ignores Previous", async () => {
    const first = await parsePage(bytes(page1), 200, BASE);
    expect(first.kind).toBe("results");
    if (first.kind !== "results") return;
    const fields = new Map(first.next?.fields ?? []);
    expect(fields.get("s")).toBe("25");
    expect(fields.get("vqd")).toBe("4-1234567890");

    const second = await parsePage(bytes(page2), 200, BASE);
    expect(second.kind).toBe("results");
    if (second.kind !== "results") return;
    expect(new Map(second.next?.fields ?? []).get("s")).toBe("50");
  });

  it("produces identical results from deliberately fragmented chunks", async () => {
    const whole = await parsePage(bytes(page1), 200, BASE);
    const fragmented = await parsePage(chunked(page1, 3), 200, BASE);
    expect(fragmented).toEqual(whole);
  });

  it("decodes entities and multi-byte text split into one-byte chunks", async () => {
    const html = `<!DOCTYPE html><html><body><div class="serp__results">
      <div class="result"><h2 class="result__title"><a class="result__a"
        href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcaf%C3%A9">Caf\u00e9 &amp; \u65e5\u672c \u2014 \u201cquoted\u201d</a></h2>
        <a class="result__snippet" href="#">\u96ea &lt;tag&gt; caf\u00e9</a></div>
      </div></body></html>`;
    const page = await parsePage(chunked(html, 1), 200, BASE);
    expect(page.kind).toBe("results");
    if (page.kind !== "results") return;
    expect(page.results[0]).toEqual({
      title: "Caf\u00e9 & \u65e5\u672c \u2014 \u201cquoted\u201d",
      url: "https://example.com/caf%C3%A9",
      domain: "example.com",
      snippet: "\u96ea <tag> caf\u00e9",
    });
  });

  it("detects challenges from status 202 and body markers", async () => {
    expect((await parsePage(bytes(challenge), 200, BASE)).kind).toBe("challenge");
    expect((await parsePage(bytes(""), 202, BASE)).kind).toBe("challenge");
    expect((await parsePage(bytes(page1), 200, BASE)).kind).not.toBe("challenge");
  });

  it("distinguishes no_results from malformed and ad-only pages", async () => {
    expect((await parsePage(bytes(noResults), 200, BASE)).kind).toBe("no_results");
    expect((await parsePage(bytes(malformed), 200, BASE)).kind).toBe("unparseable");
    expect((await parsePage(bytes(adsOnly), 200, BASE)).kind).toBe("unparseable");
  });
});
