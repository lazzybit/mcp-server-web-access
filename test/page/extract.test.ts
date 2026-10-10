import { describe, expect, it } from "vitest";
import { extract, htmlToPlainText, tryReadability } from "../../src/page/extract";
import article from "../fixtures/page/article.html?raw";
import spaShell from "../fixtures/page/spa_shell.html?raw";

const BASE = "https://example.com/docs/getting-started";

describe("tryReadability", () => {
  it("extracts article content as Markdown", () => {
    const result = tryReadability(article, BASE);
    expect(result).not.toBeNull();
    expect(result?.method).toBe("readability");
    expect(result?.format).toBe("markdown");
    expect(result?.title).toBe("Getting started — Example Docs");
    expect(result?.text).toContain("## Installation");
  });

  it("serialises GFM tables and fenced code blocks", () => {
    const result = tryReadability(article, BASE);
    const text = result?.text ?? "";
    expect(text).toContain("| Option | Default | Description |");
    expect(text).toContain("```");
    expect(text).toContain("createClient");
  });

  it("resolves relative links against the page URL", () => {
    const result = tryReadability(article, BASE);
    expect(result?.text).toContain("https://example.com/docs/configuration");
  });

  it("returns null for an app shell", () => {
    expect(tryReadability(spaShell, "https://example.com/")).toBeNull();
  });
});

describe("htmlToPlainText", () => {
  it("decodes entities and keeps block breaks", () => {
    const text = htmlToPlainText("<div><p>a &amp; b</p><p>c &lt; d</p></div>");
    expect(text).toBe("a & b\n\nc < d");
  });

  it("removes script, style and head content", () => {
    const text = htmlToPlainText(
      "<html><head><title>x</title><style>.a{}</style></head><body>keep<script>drop()</script></body></html>",
    );
    expect(text).toBe("keep");
  });
});

describe("extract", () => {
  it("prefers readability for a full article", () => {
    const result = extract(article, BASE);
    expect(result?.method).toBe("readability");
    expect(result?.format).toBe("markdown");
  });

  it("falls back to plain text when readability fails", () => {
    const result = extract("<html><body><button>Click me now</button></body></html>", BASE);
    expect(result?.method).toBe("plain_text");
    expect(result?.format).toBe("text");
    expect(result?.text).toBe("Click me now");
  });

  it("returns null when nothing readable remains", () => {
    expect(extract("<html><head></head><body><script>x()</script></body></html>", BASE)).toBeNull();
  });
});
