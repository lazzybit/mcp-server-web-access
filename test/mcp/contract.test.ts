import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  buildServer,
  runWebSearch,
  shrinkOutput,
  toCallToolResult,
  webSearchInputSchema,
} from "../../src/mcp";
import type { WebSearchOutput } from "../../src/mcp";
import type { PageDeps } from "../../src/page/mcp";
import type { SearchParams, SearchResult } from "../../src/types";

function pageStub(): PageDeps {
  return {
    fetch: (async () => new Response("")) as typeof fetch,
    getApiKey: async () => "test-secret-placeholder",
  };
}

function output(overrides: Partial<WebSearchOutput> = {}): WebSearchOutput {
  return {
    query: { text: "x", region: "wt-wt", requested: 3 },
    results: [
      { rank: 1, title: "A", url: "https://a.example/", domain: "a.example", snippet: "sa" },
    ],
    count: 1,
    truncated: false,
    status: "ok",
    ...overrides,
  };
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("runWebSearch", () => {
  it("forwards validated params with defaults", async () => {
    const seen: SearchParams[] = [];
    const deps = {
      search: async (params: SearchParams): Promise<SearchResult> => {
        seen.push(params);
        return { status: "ok", results: [] };
      },
    };
    await runWebSearch(deps, { query: "  hello  ", maxResults: 5 });
    expect(seen).toEqual([{ query: "hello", maxResults: 5, region: "wt-wt" }]);
  });

  it("returns a structured INVALID_INPUT result", async () => {
    const deps = { search: async (): Promise<SearchResult> => ({ status: "ok", results: [] }) };
    const result = await runWebSearch(deps, { query: "", maxResults: 0 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(toCallToolResult(result).isError).toBe(true);
  });
});

describe("toCallToolResult", () => {
  it("keeps text and structured content in sync", () => {
    const value = output();
    const result = toCallToolResult(value);
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(value) });
    expect(result.structuredContent).toEqual(value);
    expect(result.isError).toBeUndefined();
  });

  it("marks failed results as errors", () => {
    const result = toCallToolResult(
      output({ status: "failed", results: [], count: 0, error: { code: "UPSTREAM_ERROR", message: "x", retryable: true } }),
    );
    expect(result.isError).toBe(true);
  });
});

describe("shrinkOutput", () => {
  it("clears snippets before dropping results", () => {
    const value = output({
      query: { text: "x", region: "wt-wt", requested: 1 },
      results: [
        {
          rank: 1,
          title: "A",
          url: "https://a.example/",
          domain: "a.example",
          snippet: "s".repeat(400),
        },
      ],
      count: 1,
    });
    const shrunk = shrinkOutput(value, 400);
    expect(shrunk.results[0]?.snippet).toBeNull();
    expect(shrunk.count).toBe(1);
    expect(shrunk.truncated).toBe(true);
    expect(shrunk.status).toBe("ok");
    expect(utf8Bytes(shrunk)).toBeLessThanOrEqual(400);
  });

  it("becomes interrupted with OUTPUT_TRUNCATED when it drops below requested", () => {
    const results = Array.from({ length: 5 }, (_, index) => ({
      rank: index + 1,
      title: `Result ${index} `.repeat(20),
      url: `https://example.com/${index}`,
      domain: "example.com",
      snippet: `snippet ${index} `.repeat(30),
    }));
    const value = output({
      query: { text: "x", region: "wt-wt", requested: 5 },
      results,
      count: results.length,
    });
    const shrunk = shrinkOutput(value, 900);
    expect(shrunk.count).toBeLessThan(5);
    expect(shrunk.truncated).toBe(true);
    expect(shrunk.status).toBe("interrupted");
    expect(shrunk.error?.code).toBe("OUTPUT_TRUNCATED");
    expect(utf8Bytes(shrunk)).toBeLessThanOrEqual(900);
  });

  it("keeps the finalized object within the cap for Unicode-heavy output", () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      rank: index + 1,
      title: "\u6a19\u984c\ud83d\ude00".repeat(40),
      url: `https://example.com/${index}?q=${encodeURIComponent("\u5024".repeat(50))}`,
      domain: "example.com",
      snippet: "\u30b9\u30cb\u30da\u30c3\u30c8\ud83d\ude00".repeat(40),
    }));
    const value = output({
      query: { text: "x", region: "wt-wt", requested: 8 },
      results,
      count: results.length,
    });
    const shrunk = shrinkOutput(value, 1_200);
    expect(shrunk.truncated).toBe(true);
    expect(utf8Bytes(shrunk)).toBeLessThanOrEqual(1_200);
  });

  it("preserves an upstream error", () => {
    const value = output({
      query: { text: "x", region: "wt-wt", requested: 5 },
      results: [
        { rank: 1, title: "A".repeat(300), url: "https://a.example/", domain: "a.example", snippet: "s".repeat(300) },
      ],
      count: 1,
      status: "interrupted",
      error: { code: "PROVIDER_CHALLENGE", message: "challenge", retryable: true },
    });
    const shrunk = shrinkOutput(value, 300);
    expect(shrunk.error?.code).toBe("PROVIDER_CHALLENGE");
    expect(shrunk.status).toBe("interrupted");
    expect(shrunk.truncated).toBe(true);
    expect(utf8Bytes(shrunk)).toBeLessThanOrEqual(300);
  });
});

describe("advertised input schema", () => {
  it("describes the tool arguments", () => {
    const json = z.toJSONSchema(webSearchInputSchema, {
      target: "draft-2020-12",
      io: "input",
    }) as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "freshness",
      "maxResults",
      "query",
      "region",
    ]);
    expect(json.required).toEqual(["query", "maxResults"]);
  });
});

describe("MCP server", () => {
  async function connect(deps: Omit<Parameters<typeof buildServer>[0], "page">) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer({ ...deps, page: pageStub() });
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return { client, server };
  }

  it("lists search_topic and calls it", async () => {
    const { client, server } = await connect({
      search: async (): Promise<SearchResult> => ({
        status: "ok",
        results: [
          { rank: 1, title: "Alpha", url: "https://alpha.example/", domain: "alpha.example", snippet: "a" },
        ],
      }),
    });
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("search_topic");

      const result = await client.callTool({
        name: "search_topic",
        arguments: { query: "alpha", maxResults: 1 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: "ok", count: 1 });
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        result.structuredContent,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the structured INVALID_INPUT contract for bad arguments", async () => {
    const { client, server } = await connect({
      search: async (): Promise<SearchResult> => ({ status: "ok", results: [] }),
    });
    try {
      const result = await client.callTool({
        name: "search_topic",
        arguments: { query: "", maxResults: 999 },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        error: { code: "INVALID_INPUT" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
