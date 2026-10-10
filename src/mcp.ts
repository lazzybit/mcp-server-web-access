import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  DEFAULT_REGION,
  MAX_OUTPUT_BYTES,
  MAX_QUERY_LENGTH,
  MAX_RESULTS_LIMIT,
} from "./constants";
import { registerFetchPageTool } from "./page/mcp";
import type { PageDeps } from "./page/mcp";
import { advertisedSchema, inputJsonSchemaOf } from "./tool-schema";
import { makeError } from "./types";
import type { SearchParams, SearchResult } from "./types";

export const SERVER_NAME = "mcp-server-web-access";
export const SERVER_VERSION = "0.1.0";
export const SEARCH_DDG_TOOL_NAME = "search_ddg";

export const SERVER_INSTRUCTIONS =
  "Web access tools. Call search_ddg with a query and the number of results " +
  "you want; the server paginates and deduplicates internally and preserves " +
  "partial results with an explicit status when interrupted. Call fetch_page " +
  "with a URL to get the page's readable content as Markdown or plain text; " +
  "the server decides whether a JavaScript render is needed and returns the " +
  "full content untruncated.";

export const SEARCH_DDG_DESCRIPTION =
  "Search the web with DuckDuckGo and return up to 50 structured results. " +
  "The server paginates internally and deduplicates URLs; callers only specify " +
  "how many results they want. Returns partial results with an explicit status " +
  "when interrupted.";

export const REGION_PATTERN = /^([a-z]{2}-[a-z]{2}|wt-wt)$/;

/** Tool input contract. */
export const webSearchInputSchema = z.object({
  query: z
    .string()
    .min(1, "query must not be empty")
    .max(MAX_QUERY_LENGTH, `query must be at most ${MAX_QUERY_LENGTH} characters`),
  maxResults: z
    .number()
    .int("maxResults must be an integer")
    .min(1, "maxResults must be at least 1")
    .max(MAX_RESULTS_LIMIT, `maxResults must be at most ${MAX_RESULTS_LIMIT}`),
  region: z
    .string()
    .regex(REGION_PATTERN, "region must look like us-en or wt-wt")
    .optional(),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

const errorCodeSchema = z.enum([
  "INVALID_INPUT",
  "TIMEOUT",
  "ABORTED",
  "OUTPUT_TRUNCATED",
  "PAGE_LIMIT",
  "RATE_LIMITED",
  "PROVIDER_CHALLENGE",
  "UPSTREAM_ERROR",
  "PARSE_FAILED",
]);

const searchErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});

const searchResultItemSchema = z.object({
  rank: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  snippet: z.string().nullable(),
});

/** Tool output contract; `content[0].text` mirrors it exactly. */
export const webSearchOutputSchema = z.object({
  query: z.object({
    text: z.string(),
    region: z.string(),
    freshness: z.enum(["day", "week", "month", "year"]).optional(),
    requested: z.number().int().nonnegative(),
  }),
  results: z.array(searchResultItemSchema),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  status: z.enum(["ok", "exhausted", "interrupted", "failed"]),
  error: searchErrorSchema.optional(),
});

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

/** The search dependency the tool is bound to (the Durable Object RPC). */
export interface WebSearchDeps {
  search(params: SearchParams): Promise<SearchResult>;
}

/** Both tool dependencies, injected by the Worker entrypoint. */
export interface ServerDeps extends WebSearchDeps {
  page: PageDeps;
}

/** Validated request identity bound into the server closure. */
export interface RequestPrincipal {
  subject: string;
}

function inputJsonSchema(): Record<string, unknown> {
  return inputJsonSchemaOf(webSearchInputSchema);
}

/** Builds the MCP server with `search_ddg` and `fetch_page`. */
export function buildServer(deps: ServerDeps, principal?: RequestPrincipal): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    SEARCH_DDG_TOOL_NAME,
    {
      title: "Web Search",
      description: SEARCH_DDG_DESCRIPTION,
      inputSchema: advertisedSchema(inputJsonSchema()),
      outputSchema: webSearchOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      if (principal !== undefined) {
        // Operational counter only; never log the query string.
        console.log(JSON.stringify({ event: "search_ddg_tool", subject: principal.subject }));
      }
      const output = await runWebSearch(deps, rawArgs);
      return toCallToolResult(output);
    },
  );

  registerFetchPageTool(server, deps.page);

  return server;
}

/** Creates the stateless HTTP handler for one authenticated request. */
export function createWebSearchHandler(
  deps: ServerDeps,
  options: { allowedHostnames: string[]; principal?: RequestPrincipal },
) {
  return createMcpHandler(() => buildServer(deps, options.principal), {
    route: "/mcp",
    allowedHostnames: options.allowedHostnames,
    allowedOriginHostnames: options.allowedHostnames,
  });
}

/** Validates arguments, runs the search and shrinks the output. */
export async function runWebSearch(
  deps: WebSearchDeps,
  rawArgs: unknown,
): Promise<WebSearchOutput> {
  const raw: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
  const normalized: Record<string, unknown> = { ...raw };
  if (typeof raw["query"] === "string") normalized["query"] = raw["query"].trim();

  const parsed = webSearchInputSchema.safeParse(normalized);
  if (!parsed.success) return invalidInputOutput(raw, parsed.error);

  const params: SearchParams = {
    query: parsed.data.query,
    maxResults: parsed.data.maxResults,
    region: parsed.data.region ?? DEFAULT_REGION,
    ...(parsed.data.freshness !== undefined ? { freshness: parsed.data.freshness } : {}),
  };
  const result = await deps.search(params);
  return shrinkOutput(toOutput(params, result), MAX_OUTPUT_BYTES);
}

function toOutput(params: SearchParams, result: SearchResult): WebSearchOutput {
  const query: WebSearchOutput["query"] = {
    text: params.query,
    region: params.region,
    requested: params.maxResults,
  };
  if (params.freshness !== undefined) query.freshness = params.freshness;

  if (result.status === "interrupted" || result.status === "failed") {
    return {
      query,
      results: result.results,
      count: result.results.length,
      truncated: false,
      status: result.status,
      error: result.error,
    };
  }
  return {
    query,
    results: result.results,
    count: result.results.length,
    truncated: false,
    status: result.status,
  };
}

/** Builds a schema-valid response for rejected arguments. */
export function invalidInputOutput(
  raw: Record<string, unknown>,
  error: z.ZodError,
): WebSearchOutput {
  const query =
    typeof raw["query"] === "string" ? raw["query"].slice(0, MAX_QUERY_LENGTH) : "";
  const regionRaw = raw["region"];
  const region =
    typeof regionRaw === "string" && REGION_PATTERN.test(regionRaw) ? regionRaw : DEFAULT_REGION;
  const maxRaw = raw["maxResults"];
  const requested =
    typeof maxRaw === "number" && Number.isFinite(maxRaw)
      ? clamp(Math.trunc(maxRaw), 0, MAX_RESULTS_LIMIT)
      : 0;
  const message = error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return {
    query: { text: query, region, requested },
    results: [],
    count: 0,
    truncated: false,
    status: "failed",
    error: makeError("INVALID_INPUT", message),
  };
}

/** Wraps an output as a `CallToolResult`; text and structured content agree. */
export function toCallToolResult(output: WebSearchOutput): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output as unknown as Record<string, unknown>,
  };
  if (output.status === "failed") result.isError = true;
  return result;
}

/**
 * Shrinks output until it fits, in order: clear snippets, truncate strings,
 * drop results. An upstream error is preserved; only an originally successful
 * result becomes `interrupted`/`OUTPUT_TRUNCATED`. Size checks measure the
 * finalized object.
 */
export function shrinkOutput(output: WebSearchOutput, maxBytes: number): WebSearchOutput {
  if (byteLength(output) <= maxBytes) return output;

  const originallySuccessful = output.error === undefined;
  const requested = output.query.requested;
  const finalize = (candidate: WebSearchOutput): WebSearchOutput =>
    finalizeReduction(candidate, originallySuccessful, requested);
  const fits = (candidate: WebSearchOutput): boolean =>
    byteLength(finalize(candidate)) <= maxBytes;

  let current: WebSearchOutput = {
    ...output,
    results: output.results.map((item) => ({ ...item })),
  };

  // Step 1: clear snippets.
  for (let i = current.results.length - 1; i >= 0; i -= 1) {
    if (fits(current)) break;
    const item = current.results[i];
    if (item === undefined || item.snippet === null) continue;
    current.results[i] = { ...item, snippet: null };
  }
  if (fits(current)) return finalize(current);

  // Step 2: truncate strings.
  current = {
    ...current,
    results: current.results.map((item) => ({
      ...item,
      title: clip(item.title, 160),
      snippet: item.snippet === null ? null : clip(item.snippet, 200),
    })),
  };
  if (fits(current)) return finalize(current);

  // Step 3: reduce the number of results.
  const kept = current.results.slice();
  while (kept.length > 0 && !fits({ ...current, results: kept })) {
    kept.pop();
  }
  return finalize({ ...current, results: kept });
}

function finalizeReduction(
  current: WebSearchOutput,
  originallySuccessful: boolean,
  requested: number,
): WebSearchOutput {
  const count = current.results.length;
  const next: WebSearchOutput = { ...current, count, truncated: true };
  if (originallySuccessful && count < requested) {
    next.status = "interrupted";
    next.error = makeError(
      "OUTPUT_TRUNCATED",
      `output reduced to ${count} of ${requested} requested results`,
    );
  }
  return next;
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function byteLength(value: WebSearchOutput): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
