import { describe, expect, it } from "vitest";
import { collectFeatures } from "../../src/page/features";

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
});
