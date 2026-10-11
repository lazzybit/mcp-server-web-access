import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/mcp";
import {
  FETCH_PAGE_TOOL_NAME,
  runFetchPage,
  toFetchPageCallToolResult,
} from "../../src/page/mcp";
import type { PageDeps } from "../../src/page/mcp";
import type { SearchResult } from "../../src/types";
import article from "../fixtures/page/article.html?raw";
import sampleMarkdown from "../fixtures/page/sample.md?raw";
import spaShell from "../fixtures/page/spa_shell.html?raw";

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function noulResponse(value: number): Response {
  return new Response(
    JSON.stringify({ answers: { needs_render: { type: "noul", noul: value } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface Harness {
  deps: PageDeps;
  decisionCalls: () => number;
}

function harness(
  probe: () => Response,
  decision?: () => Response,
  extra: Partial<PageDeps> = {},
): Harness {
  let decisionCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/")) {
      decisionCalls += 1;
      return decision !== undefined ? decision() : new Response("", { status: 500 });
    }
    return probe();
  }) as typeof fetch;
  return {
    deps: { fetch: fetchImpl, getApiKey: async () => "synthetic-key", ...extra },
    decisionCalls: () => decisionCalls,
  };
}

const RENDERED_BROWSER = {
  async newPage() {
    return {
      async goto() {},
      async content() {
        return article;
      },
      url() {
        return "https://example.com/app";
      },
      async setRequestInterception() {},
      on() {},
    };
  },
  async close() {},
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runFetchPage", () => {
  it("returns the source directly for text/markdown", async () => {
    const { deps, decisionCalls } = harness(
      () => new Response(sampleMarkdown, { headers: { "content-type": "text/markdown" } }),
    );
    const output = await runFetchPage(deps, { url: "https://example.com/sample.md" });
    expect(output.status).toBe("ok");
    expect(output.extraction).toBe("source");
    expect(output.decision.source).toBe("none");
    expect(output.content.format).toBe("markdown");
    expect(output.content.text).toContain("# Sample document");
    expect(decisionCalls()).toBe(0);
  });

  it("extracts static HTML without the model when PAGE_ROUTER=off", async () => {
    const { deps, decisionCalls } = harness(() => htmlResponse(article), undefined, {
      pageRouter: "off",
    });
    const output = await runFetchPage(deps, { url: "https://example.com/docs" });
    expect(output.extraction).toBe("readability");
    expect(output.decision.source).toBe("fallback");
    expect(output.rendered).toBe(false);
    expect(decisionCalls()).toBe(0);
  });

  it("uses the model decision without rendering when needs_render is low", async () => {
    const { deps, decisionCalls } = harness(() => htmlResponse(article), () => noulResponse(0.1));
    const output = await runFetchPage(deps, { url: "https://example.com/docs" });
    expect(output.decision).toEqual({
      source: "model",
      model: "typesafe/jev-1.13",
      needsRender: 0.1,
    });
    expect(output.rendered).toBe(false);
    expect(output.extraction).toBe("readability");
    expect(decisionCalls()).toBe(1);
  });

  it("renders an app shell once when the model asks for it", async () => {
    const { deps } = harness(() => htmlResponse(spaShell), () => noulResponse(0.9), {
      browser: {},
      launchBrowser: async () => RENDERED_BROWSER,
    });
    const output = await runFetchPage(deps, { url: "https://example.com/app" });
    expect(output.rendered).toBe(true);
    expect(output.extraction).toBe("readability");
    expect(output.decision.source).toBe("model");
    expect(output.url.final).toBe("https://example.com/app");
  });

  it("falls back to static HTML when the decision path errors", async () => {
    const { deps } = harness(
      () => htmlResponse(article),
      () => new Response("", { status: 500 }),
    );
    const output = await runFetchPage(deps, { url: "https://example.com/docs" });
    expect(output.decision.source).toBe("error");
    expect(output.status).toBe("ok");
    expect(output.extraction).toBe("readability");
  });

  it("falls back to static HTML when rendering fails", async () => {
    const { deps } = harness(() => htmlResponse(article), () => noulResponse(0.9), {
      browser: {},
      launchBrowser: async () => {
        throw new Error("render failed");
      },
    });
    const output = await runFetchPage(deps, { url: "https://example.com/docs" });
    expect(output.rendered).toBe(false);
    expect(output.status).toBe("ok");
    expect(output.extraction).toBe("readability");
  });

  it("reports RENDER_FAILED when neither the render nor the static HTML is readable", async () => {
    const { deps } = harness(
      () => htmlResponse(spaShell),
      () => noulResponse(0.9),
      {
        browser: {},
        launchBrowser: async () => {
          throw new Error("render failed");
        },
      },
    );
    const output = await runFetchPage(deps, { url: "https://example.com/app" });
    expect(output.status).toBe("failed");
    expect(output.error?.code).toBe("RENDER_FAILED");
  });

  it("reports NOT_READABLE when static HTML yields nothing", async () => {
    const { deps } = harness(
      () => htmlResponse("<html><head></head><body><script>x()</script></body></html>"),
      undefined,
      { pageRouter: "off" },
    );
    const output = await runFetchPage(deps, { url: "https://example.com/empty" });
    expect(output.status).toBe("failed");
    expect(output.error?.code).toBe("NOT_READABLE");
  });

  it("returns INVALID_INPUT for missing arguments", async () => {
    const { deps } = harness(() => htmlResponse(article));
    const output = await runFetchPage(deps, {});
    expect(output.status).toBe("failed");
    expect(output.error?.code).toBe("INVALID_INPUT");
    expect(toFetchPageCallToolResult(output).isError).toBe(true);
  });

  it("returns BLOCKED_URL for a disallowed URL", async () => {
    const { deps } = harness(() => htmlResponse(article));
    const output = await runFetchPage(deps, { url: "http://127.0.0.1/" });
    expect(output.status).toBe("failed");
    expect(output.error?.code).toBe("BLOCKED_URL");
  });
});

describe("fetch_page MCP contract", () => {
  it("lists and calls both tools", async () => {
    const { deps } = harness(
      () => new Response(sampleMarkdown, { headers: { "content-type": "text/markdown" } }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(
      { search: async (): Promise<SearchResult> => ({ status: "ok", results: [] }), page: deps },
    );
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("search_topic");
      expect(names).toContain(FETCH_PAGE_TOOL_NAME);

      const result = await client.callTool({
        name: FETCH_PAGE_TOOL_NAME,
        arguments: { url: "https://example.com/sample.md" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        extraction: "source",
        decision: { source: "none" },
      });
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        result.structuredContent,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
