import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import {
  buildBrowserSearchUrl,
  clickMoreResults,
  extractSearchDom,
  searchViaBrowser,
} from "../../src/ddg/browser-search";
import type {
  SearchDomDocument,
  SearchDomExtraction,
} from "../../src/ddg/browser-search";
import { serializeExpression } from "../../src/browser/launcher";
import type {
  BrowserCapability,
  CapabilityLauncher,
  PageCapability,
} from "../../src/browser/launcher";

function dom(html: string): SearchDomDocument {
  return parseHTML(html).document as unknown as SearchDomDocument;
}

function resultHtml(): string {
  return `<!DOCTYPE html><html><body>
    <article data-testid="result" data-nrn="result">
      <a data-testid="result-title-a" href="https://example.com/alpha">Alpha &amp; One</a>
      <div data-result="snippet">First snippet &lt;x&gt;.</div>
    </article>
    <article data-testid="result" data-nrn="result">
      <a data-testid="result-title-a"
        href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta%23frag">Beta Two</a>
      <span data-result="snippet">Second snippet</span>
    </article>
    <article data-testid="result" data-nrn="ad">
      <a data-testid="result-title-a" href="https://ads.example.com/promo">Ad result</a>
    </article>
    <article data-testid="result" data-nrn="result">
      <span data-result="snippet">Container without a title link</span>
    </article>
    <button>More results</button>
  </body></html>`;
}

function results(
  entries: Array<{ href: string; title?: string; snippet?: string | null }>,
  hasMore: boolean,
): SearchDomExtraction {
  return {
    kind: "results",
    results: entries.map((entry) => ({
      title: entry.title ?? entry.href,
      href: entry.href,
      snippet: entry.snippet ?? null,
    })),
    hasMore,
  };
}

class FakeSearchPage implements PageCapability {
  evaluates = 0;
  #batches: SearchDomExtraction[];
  #index = 0;

  constructor(batches: SearchDomExtraction[]) {
    this.#batches = batches;
  }

  async goto(): Promise<void> {
    return undefined;
  }

  async content(): Promise<string> {
    return "";
  }

  async url(): Promise<string> {
    return "about:blank";
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluates += 1;
    if (expression === serializeExpression(extractSearchDom)) {
      const batch = this.#batches[Math.min(this.#index, this.#batches.length - 1)];
      return batch ?? { kind: "unparseable" };
    }
    if (expression === serializeExpression(clickMoreResults)) {
      this.#index += 1;
      return true;
    }
    throw new Error("unexpected evaluate");
  }
}

class FakeSearchBrowser implements BrowserCapability {
  closes = 0;
  readonly page: FakeSearchPage;

  constructor(page: FakeSearchPage) {
    this.page = page;
  }

  async newPage(): Promise<PageCapability> {
    return this.page;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

describe("extractSearchDom", () => {
  it("extracts organic results, skips ads and containers without a title link", () => {
    expect(extractSearchDom(dom(resultHtml()))).toEqual({
      kind: "results",
      results: [
        {
          title: "Alpha & One",
          href: "https://example.com/alpha",
          snippet: "First snippet <x>.",
        },
        {
          title: "Beta Two",
          href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta%23frag",
          snippet: "Second snippet",
        },
      ],
      hasMore: true,
    });
  });

  it("detects the challenge script and markers", () => {
    expect(extractSearchDom(dom(`<html><body><script src="/anomaly.js"></script></body></html>`))).toEqual(
      { kind: "challenge" },
    );
    expect(extractSearchDom(dom(`<html><body>Please select all squares</body></html>`))).toEqual({
      kind: "challenge",
    });
  });

  it("detects an explicit no-results page", () => {
    expect(
      extractSearchDom(dom(`<html><body><div class="no-results">No results.</div></body></html>`)),
    ).toEqual({ kind: "no_results" });
    expect(extractSearchDom(dom(`<html><body>Your search returned no results.</body></html>`))).toEqual({
      kind: "no_results",
    });
  });

  it("returns unparseable when no known marker is present", () => {
    expect(extractSearchDom(dom(`<html><body><div>nothing</div></body></html>`))).toEqual({
      kind: "unparseable",
    });
  });

  it("does not mistake result snippets for challenge or no-results markers", () => {
    const extraction = extractSearchDom(
      dom(`<article data-testid="result" data-nrn="result">
        <a data-testid="result-title-a" href="https://example.com/x">X</a>
        <div data-result="snippet">This page has no results. Please select all squares.</div>
      </article>`),
    );
    expect(extraction.kind).toBe("results");
  });

  it("reports hasMore only for the text-matched More results button", () => {
    const extraction = extractSearchDom(
      dom(`<article data-testid="result" data-nrn="result">
        <a data-testid="result-title-a" href="https://example.com/x">X</a>
      </article><button>Next</button>`),
    );
    expect(extraction).toMatchObject({ kind: "results", hasMore: false });
  });
});

describe("clickMoreResults", () => {
  it("returns true for a text-matched button and false otherwise", () => {
    expect(clickMoreResults(dom(`<html><body><button>More results</button></body></html>`))).toBe(true);
    expect(clickMoreResults(dom(`<html><body><button>Next</button></body></html>`))).toBe(false);
  });
});

describe("buildBrowserSearchUrl", () => {
  it("encodes the query, region and freshness", () => {
    expect(
      buildBrowserSearchUrl({ query: "hello world", effort: "low", region: "us-en" }),
    ).toBe("https://duckduckgo.com/?q=hello+world&kl=us-en");
    expect(
      buildBrowserSearchUrl({ query: "x", effort: "low", region: "wt-wt", freshness: "week" }),
    ).toBe("https://duckduckgo.com/?q=x&kl=wt-wt&df=w");
  });
});

describe("searchViaBrowser", () => {
  it("normalizes, deduplicates, ranks and closes the browser", async () => {
    const browser = new FakeSearchBrowser(
      new FakeSearchPage([
        results(
          [
            { href: "https://example.com/a", snippet: "sa" },
            { href: "https://example.com/b" },
            { href: "https://duckduckgo.com/y.js?ad=1" },
          ],
          true,
        ),
        // The real page appends: a later extraction still sees page one.
        results(
          [
            { href: "https://example.com/a", snippet: "sa" },
            { href: "https://example.com/b" },
            { href: "https://duckduckgo.com/y.js?ad=1" },
            { href: "https://example.com/c", title: "C" },
          ],
          false,
        ),
      ]),
    );

    const outcome = await searchViaBrowser(
      { query: "q", effort: "medium", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100 },
    );

    expect(outcome.attempted).toBe(true);
    expect(outcome.result.status).toBe("exhausted");
    expect(outcome.result.results).toEqual([
      { rank: 1, title: "https://example.com/a", url: "https://example.com/a", domain: "example.com", snippet: "sa" },
      { rank: 2, title: "https://example.com/b", url: "https://example.com/b", domain: "example.com", snippet: null },
      { rank: 3, title: "C", url: "https://example.com/c", domain: "example.com", snippet: null },
    ]);
    expect(browser.closes).toBe(1);
  });

  it("completes at the effort limit with a continuation available", async () => {
    const browser = new FakeSearchBrowser(
      new FakeSearchPage([
        results(
          [
            { href: "https://example.com/a" },
            { href: "https://example.com/b" },
            { href: "https://example.com/c" },
          ],
          true,
        ),
      ]),
    );
    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100 },
    );
    expect(outcome.result.status).toBe("ok");
    expect(outcome.result.results).toHaveLength(3);
  });

  it("completes at the effort limit with partial pagination", async () => {
    const browser = new FakeSearchBrowser(
      new FakeSearchPage([
        results([{ href: "https://example.com/a" }], true),
        results([{ href: "https://example.com/a" }, { href: "https://example.com/b" }], true),
      ]),
    );
    const outcome = await searchViaBrowser(
      { query: "q", effort: "medium", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100 },
    );
    expect(outcome.result.status).toBe("ok");
    expect(outcome.result.results.map((item) => item.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("maps a challenge to PROVIDER_CHALLENGE", async () => {
    const browser = new FakeSearchBrowser(new FakeSearchPage([{ kind: "challenge" }]));
    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100 },
    );
    expect(outcome.result.status).toBe("failed");
    expect("error" in outcome.result ? outcome.result.error.code : undefined).toBe("PROVIDER_CHALLENGE");
  });

  it("returns exhausted for a confirmed no-results page", async () => {
    const browser = new FakeSearchBrowser(new FakeSearchPage([{ kind: "no_results" }]));
    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100 },
    );
    expect(outcome.result).toEqual({ status: "exhausted", results: [] });
  });

  it("times out an unparseable page as UPSTREAM_ERROR", async () => {
    const browser = new FakeSearchBrowser(new FakeSearchPage([{ kind: "unparseable" }]));
    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: async () => browser, callTimeoutMs: 20, pollIntervalMs: 1, resultsTimeoutMs: 30 },
    );
    expect(outcome.result.status).toBe("failed");
    expect("error" in outcome.result ? outcome.result.error.code : undefined).toBe("UPSTREAM_ERROR");
  });

  it("closes a launch that resolves after its timeout", async () => {
    let closed = 0;
    const launcher: CapabilityLauncher = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            newPage: async (): Promise<PageCapability> => {
              throw new Error("unused");
            },
            close: async () => {
              closed += 1;
            },
          });
        }, 30);
      });

    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: launcher, launchTimeoutMs: 10, closeTimeoutMs: 20 },
    );
    expect(outcome.result.status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(closed).toBe(1);
  });

  it("gives up on a hanging close without blocking the result", async () => {
    const page = new FakeSearchPage([results([{ href: "https://example.com/a" }], false)]);
    const browser: BrowserCapability = {
      newPage: async () => page,
      close: () => new Promise<void>(() => {}),
    };
    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100, closeTimeoutMs: 20 },
    );
    expect(outcome.result.status).toBe("exhausted");
    expect(outcome.result.results).toHaveLength(1);
  });

  it("bounds an evaluate that ignores abort", async () => {
    const page: PageCapability = {
      async goto() {
        return undefined;
      },
      async content() {
        return "";
      },
      async url() {
        return "about:blank";
      },
      async evaluate(): Promise<unknown> {
        return new Promise<unknown>(() => {});
      },
    };
    const browser: BrowserCapability = { newPage: async () => page, close: async () => {} };
    const outcome = await searchViaBrowser(
      { query: "q", effort: "low", region: "wt-wt" },
      { launch: async () => browser, callTimeoutMs: 20, resultsTimeoutMs: 20 },
    );
    expect(outcome.result.status).toBe("failed");
    expect("error" in outcome.result ? outcome.result.error.code : undefined).toBe("UPSTREAM_ERROR");
  });

  it("bounds a hanging click and keeps partial results", async () => {
    const page: PageCapability = {
      async goto() {
        return undefined;
      },
      async content() {
        return "";
      },
      async url() {
        return "about:blank";
      },
      async evaluate(expression: string): Promise<unknown> {
        if (expression === serializeExpression(extractSearchDom)) {
          return results([{ href: "https://example.com/a" }], true);
        }
        return new Promise<unknown>(() => {});
      },
    };
    const browser: BrowserCapability = { newPage: async () => page, close: async () => {} };
    const outcome = await searchViaBrowser(
      { query: "q", effort: "medium", region: "wt-wt" },
      { launch: async () => browser, callTimeoutMs: 20, pollIntervalMs: 1, resultsTimeoutMs: 30 },
    );
    expect(outcome.result.status).toBe("interrupted");
    expect(outcome.result.results).toHaveLength(1);
    expect("error" in outcome.result ? outcome.result.error.code : undefined).toBe("UPSTREAM_ERROR");
  });

  it("times out a click whose containers never advance", async () => {
    const same = results([{ href: "https://example.com/a" }], true);
    const browser = new FakeSearchBrowser(new FakeSearchPage([same, same]));
    const outcome = await searchViaBrowser(
      { query: "q", effort: "medium", region: "wt-wt" },
      { launch: async () => browser, callTimeoutMs: 20, pollIntervalMs: 1, resultsTimeoutMs: 30 },
    );
    expect(outcome.result.status).toBe("interrupted");
    expect(outcome.result.results).toHaveLength(1);
    expect("error" in outcome.result ? outcome.result.error.code : undefined).toBe("UPSTREAM_ERROR");
  });

  it("keeps paginating when a batch advances but only repeats URLs", async () => {
    const browser = new FakeSearchBrowser(
      new FakeSearchPage([
        results([{ href: "https://example.com/a" }], true),
        results([{ href: "https://example.com/a" }, { href: "https://example.com/a" }], true),
      ]),
    );
    const outcome = await searchViaBrowser(
      { query: "q", effort: "medium", region: "wt-wt" },
      { launch: async () => browser, pollIntervalMs: 1, resultsTimeoutMs: 100 },
    );
    expect(outcome.result.status).toBe("ok");
    expect(outcome.result.results.map((item) => item.url)).toEqual(["https://example.com/a"]);
  });
});

describe("in-page function serialization", () => {
  it("keeps the extraction and click functions self-contained", () => {
    // Rebuilding each function from source proves it closes over no module
    // bindings; a missing binding would throw a ReferenceError here.
    const extract = new Function(
      `return (${extractSearchDom.toString()})`,
    )() as (doc: SearchDomDocument) => SearchDomExtraction;
    expect(extract(dom(resultHtml())).kind).toBe("results");

    const click = new Function(
      `return (${clickMoreResults.toString()})`,
    )() as (doc: SearchDomDocument) => boolean;
    expect(click(dom(`<html><body><button>More results</button></body></html>`))).toBe(true);
  });
});
