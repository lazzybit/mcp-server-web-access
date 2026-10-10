import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SELF, evictAllDurableObjects } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import page1 from "../fixtures/results_page1.html?raw";

const ORIGIN = "https://example.com";

// The worker and DO run in the same isolate, so overriding the global fetch
// stubs upstream calls. This pool version has no `fetchMock` helper.
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://html.duckduckgo.com/")) {
      return new Response(page1, { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(async () => {
  // Evict the singleton DO between tests so state does not leak.
  await evictAllDurableObjects();
});

function connectClient(): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (input, init) => {
      // Forward via SELF.fetch with an absolute URL and an explicit Host header;
      // this pool's in-process dispatch does not synthesise one.
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      headers.set("host", "example.com");
      const method = input instanceof Request ? input.method : init?.method ?? "GET";
      const body = input instanceof Request ? input.body : init?.body;
      return SELF.fetch(url, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" || body == null ? {} : { body }),
      });
    },
  });
  const client = new Client({ name: "handler-test", version: "1.0.0" });
  return { client, transport };
}

describe("worker entry", () => {
  it("serves /healthz without authentication", async () => {
    const response = await SELF.fetch(`${ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("rejects a non-canonical Host", async () => {
    const response = await SELF.fetch("https://evil.example.com/mcp", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("rejects an unknown path", async () => {
    const response = await SELF.fetch(`${ORIGIN}/other`);
    expect(response.status).toBe(404);
  });
});

describe("MCP handler", () => {
  it("lists the tool and returns structured results", async () => {
    const { client, transport } = connectClient();
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("search_ddg");

      const result = await client.callTool({
        name: "search_ddg",
        arguments: { query: "test query", maxResults: 2 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: "ok", count: 2 });
    } finally {
      await client.close();
    }
  });

  it("returns the structured INVALID_INPUT contract", async () => {
    const { client, transport } = connectClient();
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "search_ddg",
        arguments: { query: "", maxResults: 1 },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        error: { code: "INVALID_INPUT" },
      });
    } finally {
      await client.close();
    }
  });
});
