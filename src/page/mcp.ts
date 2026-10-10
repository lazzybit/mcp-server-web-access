/**
 * `fetch_page` MCP tool: input validation, orchestration and output contract.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { advertisedSchema, inputJsonSchemaOf } from "../tool-schema";
import { PAGE_RUN_DEADLINE_MS, RENDER_THRESHOLD, USER_AGENT_NAME } from "./constants";
import { Deadline } from "./deadline";
import { decideNeedsRender, needsRender } from "./decide";
import { extract } from "./extract";
import { probePage } from "./probe";
import { parsePageUrl } from "./ssrf";
import type {
  FetchPageOutput,
  ExtractionResult,
  PageError,
  PageErrorCode,
  PageSnapshot,
  RouteDecision,
} from "./types";
import { PageFailure, makePageError } from "./types";
import { renderPage } from "./browser";
import type { BrowserLauncher } from "./browser";

export const FETCH_PAGE_TOOL_NAME = "fetch_page";

export const FETCH_PAGE_DESCRIPTION =
  "Fetch a web page and return its readable content as Markdown or plain text. " +
  "The server probes the static HTML, asks a decision model whether the page " +
  "needs JavaScript, and renders it once with a headless browser when it does. " +
  "No output truncation is performed; the caller decides what is enough.";

/** Runtime dependencies injected by the Worker entrypoint. */
export interface PageDeps {
  /** Public egress only; never the search VPC binding. */
  fetch: typeof fetch;
  getApiKey: () => Promise<string>;
  /** The `BROWSER` binding, when configured. */
  browser?: unknown;
  /** Test/override hook; defaults to `@cloudflare/puppeteer`. */
  launchBrowser?: BrowserLauncher;
  mcpDomain?: string;
  pageRouter?: string;
  browserEnabled?: string;
}

export const fetchPageInputSchema = z.object({
  url: z.string().min(1, "url must not be empty").max(2048, "url is too long"),
});

export const fetchPageOutputSchema = z.object({
  url: z.object({ requested: z.string(), final: z.string().nullable() }),
  page: z.object({
    title: z.string().nullable(),
    siteName: z.string().nullable(),
    byline: z.string().nullable(),
    language: z.string().nullable(),
  }),
  rendered: z.boolean(),
  extraction: z.enum(["source", "readability", "plain_text", "none"]),
  decision: z.object({
    source: z.enum(["model", "fallback", "error", "none"]),
    model: z.string().nullable(),
    needsRender: z.number().nullable(),
  }),
  content: z.object({
    format: z.enum(["markdown", "text"]),
    text: z.string(),
    chars: z.number().int().nonnegative(),
  }),
  status: z.enum(["ok", "failed"]),
  error: z
    .object({
      code: z.enum([
        "INVALID_INPUT",
        "BLOCKED_URL",
        "FETCH_FAILED",
        "TIMEOUT",
        "ABORTED",
        "TOO_LARGE",
        "RENDER_FAILED",
        "NOT_READABLE",
      ]),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export function registerFetchPageTool(server: McpServer, deps: PageDeps): void {
  server.registerTool(
    FETCH_PAGE_TOOL_NAME,
    {
      title: "Fetch Page",
      description: FETCH_PAGE_DESCRIPTION,
      inputSchema: advertisedSchema(inputJsonSchemaOf(fetchPageInputSchema)),
      outputSchema: fetchPageOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      const output = await runFetchPage(deps, rawArgs);
      return toFetchPageCallToolResult(output);
    },
  );
}

/** Validates arguments and runs the pipeline. Never throws. */
export async function runFetchPage(deps: PageDeps, rawArgs: unknown): Promise<FetchPageOutput> {
  const deadline = new Deadline(PAGE_RUN_DEADLINE_MS);
  try {
    return await executeFetchPage(deps, rawArgs, deadline);
  } finally {
    deadline.dispose();
  }
}

async function executeFetchPage(
  deps: PageDeps,
  rawArgs: unknown,
  deadline: Deadline,
): Promise<FetchPageOutput> {
  const raw = isRecord(rawArgs) ? rawArgs : {};
  const normalized: Record<string, unknown> = { ...raw };
  if (typeof raw["url"] === "string") normalized["url"] = raw["url"].trim();

  const parsed = fetchPageInputSchema.safeParse(normalized);
  if (!parsed.success) {
    const requested = typeof normalized["url"] === "string" ? normalized["url"] : "";
    const output = failedOutput(
      { requested, final: null },
      makePageError(
        "INVALID_INPUT",
        parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      ),
    );
    logPage(output, null, 0, Date.now() - deadline.startedAt);
    return output;
  }

  const requested = parsed.data.url;
  let url: URL;
  try {
    url = parsePageUrl(requested);
  } catch (error) {
    const output = failedOutput({ requested, final: null }, toPageError(error, "BLOCKED_URL"));
    logPage(output, null, 0, Date.now() - deadline.startedAt);
    return output;
  }

  const startedAt = deadline.startedAt;

  let snapshot: PageSnapshot;
  try {
    snapshot = await probePage(url, {
      fetch: deps.fetch,
      deadline,
      userAgent: userAgent(deps.mcpDomain),
    });
  } catch (error) {
    const output = failedOutput({ requested, final: null }, toPageError(error, "FETCH_FAILED"));
    logPage(output, null, 0, Date.now() - startedAt);
    return output;
  }

  const routerOn = (deps.pageRouter ?? "on") === "on";
  const browserEnabled = (deps.browserEnabled ?? "true") !== "false";

  let decision: RouteDecision;
  let rendered = false;
  let html = snapshot.body;
  let baseUrl = snapshot.finalUrl;
  let renderError: PageError | null = null;
  let renderMs = 0;

  if (snapshot.isMarkdownLike) {
    decision = { source: "none", model: null, needsRender: null };
  } else if (!routerOn) {
    decision = { source: "fallback", model: null, needsRender: null };
  } else {
    decision = await decideNeedsRender(snapshot, {
      fetch: deps.fetch,
      getApiKey: deps.getApiKey,
      deadline,
    });
    if (needsRender(decision, RENDER_THRESHOLD) && browserEnabled && deps.browser !== undefined) {
      const renderStart = Date.now();
      try {
        const outcome = await renderPage({
          binding: deps.browser,
          url: snapshot.finalUrl,
          deadline,
          ...(deps.launchBrowser !== undefined ? { launch: deps.launchBrowser } : {}),
        });
        html = outcome.html;
        baseUrl = outcome.finalUrl;
        rendered = true;
      } catch (error) {
        renderError = toPageError(error, "RENDER_FAILED");
      } finally {
        renderMs = Date.now() - renderStart;
      }
    }
  }

  if (snapshot.isMarkdownLike) {
    const result: ExtractionResult = {
      format: snapshot.mime === "text/markdown" ? "markdown" : "text",
      text: normalizeSource(snapshot.body),
      method: "source",
      title: snapshot.features.title,
      siteName: null,
      byline: null,
      language: snapshot.features.language,
    };
    const output = okOutput(
      { requested, final: snapshot.finalUrl },
      result,
      decision,
      rendered,
    );
    logPage(output, snapshot, renderMs, Date.now() - startedAt);
    return output;
  }

  const result = extract(html, baseUrl);
  if (result === null) {
    const error = renderError ?? makePageError("NOT_READABLE", "no readable content was extracted");
    const output = failedOutput({ requested, final: snapshot.finalUrl }, error);
    logPage(output, snapshot, renderMs, Date.now() - startedAt);
    return output;
  }

  const output = okOutput({ requested, final: snapshot.finalUrl }, result, decision, rendered);
  logPage(output, snapshot, renderMs, Date.now() - startedAt);
  return output;
}

export function toFetchPageCallToolResult(output: FetchPageOutput): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output as unknown as Record<string, unknown>,
  };
  if (output.status === "failed") result.isError = true;
  return result;
}

function okOutput(
  url: FetchPageOutput["url"],
  result: ExtractionResult,
  decision: RouteDecision,
  rendered: boolean,
): FetchPageOutput {
  return {
    url,
    page: {
      title: result.title,
      siteName: result.siteName,
      byline: result.byline,
      language: result.language,
    },
    rendered,
    extraction: result.method,
    decision: {
      source: decision.source,
      model: decision.model,
      needsRender: decision.needsRender,
    },
    content: { format: result.format, text: result.text, chars: result.text.length },
    status: "ok",
  };
}

function failedOutput(url: FetchPageOutput["url"], error: PageError): FetchPageOutput {
  return {
    url,
    page: { title: null, siteName: null, byline: null, language: null },
    rendered: false,
    extraction: "none",
    decision: { source: "none", model: null, needsRender: null },
    content: { format: "text", text: "", chars: 0 },
    status: "failed",
    error,
  };
}

function normalizeSource(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

function userAgent(domain?: string): string {
  if (domain === undefined || domain === "") return USER_AGENT_NAME;
  return `${USER_AGENT_NAME} (+https://${domain})`;
}

function toPageError(error: unknown, fallback: PageErrorCode): PageError {
  if (error instanceof PageFailure) return error.pageError;
  return makePageError(fallback, "the request failed");
}

/** One JSON observability line; never logs content, query values or secrets. */
function logPage(
  output: FetchPageOutput,
  snapshot: PageSnapshot | null,
  renderMs: number,
  elapsedMs: number,
): void {
  console.log(
    JSON.stringify({
      event: "fetch_page",
      status: output.status,
      rendered: output.rendered,
      extraction: output.extraction,
      format: output.content.format,
      decision: {
        source: output.decision.source,
        model: output.decision.model,
        needsRender: output.decision.needsRender,
      },
      renderMs,
      elapsedMs,
      redirects: snapshot?.redirects ?? 0,
      finalHost: hostOf(output.url.final),
      bytes: snapshot?.bytes ?? 0,
      chars: output.content.chars,
      error: output.error?.code ?? null,
    }),
  );
}

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
