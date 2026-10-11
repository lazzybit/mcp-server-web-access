import { describe, expect, it } from "vitest";
import { collectFeatures, createEvidenceRewriter } from "../../src/page/features";

const HTML = `<!DOCTYPE html>
<html lang="de">
  <head>
    <title>T &amp; T</title>
    <style>.a { color: red }</style>
  </head>
  <body>
    <div id="root"></div>
    <p>Hello <b>world</b></p>
    <script>var secret = "do-not-collect";</script>
    <noscript>enable js</noscript>
    <ul><li>one</li><li>two</li></ul>
  </body>
</html>`;

describe("collectFeatures", () => {
  it("collects visible text and skips script/style content", async () => {
    const features = await collectFeatures(HTML);
    expect(features.title).toBe("T & T");
    expect(features.language).toBe("de");
    expect(features.textChars).toBe("Hello worldonetwo".length);
    expect(features.sample).toContain("Hello world");
    expect(features.sample).not.toContain("secret");
    expect(features.sample).not.toContain("color: red");
  });

  it("counts structure and script evidence", async () => {
    const features = await collectFeatures(HTML);
    expect(features.script.count).toBe(1);
    expect(features.script.bytesRatio).toBeGreaterThan(0);
    expect(features.script.bytesRatio).toBeLessThan(1);
    expect(features.script.hasNoscript).toBe(true);
    expect(features.script.emptyAppRoot).toBe(true);
    expect(features.structure["p"]).toBe(1);
    expect(features.structure["li"]).toBe(2);
    expect(features.structure["a"]).toBe(0);
    expect(features.blockCount).toBe(3);
  });

  it("detects an application root that already has text", async () => {
    const features = await collectFeatures(
      `<html><body><div id="app"><h1>Rendered</h1></div></body></html>`,
    );
    expect(features.script.emptyAppRoot).toBe(false);
    expect(features.textChars).toBe("Rendered".length);
  });

  it("handles a body split across many text chunks", async () => {
    const body = Array.from({ length: 500 }, (_, index) => `<p>chunk ${index}</p>`).join("");
    const features = await collectFeatures(`<html><body>${body}</body></html>`);
    expect(features.structure["p"]).toBe(500);
    expect(features.blockCount).toBe(500);
    expect(features.textChars).toBeGreaterThan(3000);
    expect(features.sample.length).toBeLessThanOrEqual(1500);
  });

  it("bounds the sample when a single text node is huge", async () => {
    const features = await collectFeatures(`<html><body><p>${"x".repeat(100_000)}</p></body></html>`);
    expect(features.sample.length).toBeLessThanOrEqual(1500);
  });

  it("uses the unfiltered UTF-8 length as the bytesRatio denominator", async () => {
    const html = `<html><body><script>abcd</script><p>x</p></body></html>`;
    const features = await collectFeatures(html);
    const encoder = new TextEncoder();
    expect(features.script.bytesRatio).toBeCloseTo(
      encoder.encode("abcd").byteLength / encoder.encode(html).byteLength,
      10,
    );
  });

  it("counts script bytes even though the script is removed", async () => {
    const html = `<html><body><script>var removed = "secret";</script><p>kept</p></body></html>`;
    const { rewriter, finish } = createEvidenceRewriter();
    const filtered = await rewriter
      .transform(new Response(html, { headers: { "content-type": "text/html" } }))
      .text();
    expect(filtered).not.toContain("secret");
    const features = finish(new TextEncoder().encode(html).byteLength);
    expect(features.script.count).toBe(1);
    expect(features.script.bytesRatio).toBeGreaterThan(0);
  });

  it("still counts text and structure inside a removed svg subtree", async () => {
    const html = `<html><body><svg><g><text>chart</text></g></svg><p>body</p></body></html>`;
    const { rewriter, finish } = createEvidenceRewriter();
    const filtered = await rewriter
      .transform(new Response(html, { headers: { "content-type": "text/html" } }))
      .text();
    expect(filtered).not.toContain("chart");
    const features = finish(new TextEncoder().encode(html).byteLength);
    expect(features.textChars).toBe("chartbody".length);
    expect(features.structure["p"]).toBe(1);
  });

  it("filters non-content markup but keeps JSON-LD and ordinary URLs", async () => {
    const { rewriter } = createEvidenceRewriter();
    const filtered = await rewriter
      .transform(
        new Response(
          `<!DOCTYPE html><!-- top --><html><head>` +
            `<style>.a{background:url(data:image/png;base64,AAAA)}</style>` +
            `<script>var secret = 1;</script>` +
            `<script type="application/ld+json">{"headline":"LD"}</script>` +
            `</head><body><!-- inner --><svg><text>svg</text></svg>` +
            `<img src="https://example.com/a.png" srcset="data:image/png;base64,AAAA 1x, https://example.com/b.png 2x">` +
            `<a href="data:text/html,x" style="color: red; background: url(data:image/gif;base64,BBBB)">link</a>` +
            `<div data="data:foo"></div><object data="https://example.com/x.swf"></object>` +
            `</body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
      )
      .text();
    expect(filtered).not.toContain("var secret");
    expect(filtered).not.toContain("<style");
    expect(filtered).not.toContain("<svg");
    expect(filtered).not.toContain("<!--");
    expect(filtered).not.toContain("data:image");
    expect(filtered).not.toContain('href="data:');
    expect(filtered).not.toContain('data="data:');
    expect(filtered).toContain('type="application/ld+json"');
    expect(filtered).toContain("https://example.com/a.png");
    expect(filtered).toContain("https://example.com/b.png 2x");
    expect(filtered).toContain("color: red");
    expect(filtered).toContain('data="https://example.com/x.swf"');
  });
});
