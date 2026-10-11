/** Contracts for the `fetch_page` tool. */

/**
 * `ABORTED` is kept for wire compatibility but is no longer emitted: there is
 * no whole-call deadline or caller cancellation. `TIMEOUT` still covers a
 * per-stage probe timeout.
 */
export type PageErrorCode =
  | "INVALID_INPUT"
  | "BLOCKED_URL"
  | "FETCH_FAILED"
  | "TIMEOUT"
  | "ABORTED"
  | "TOO_LARGE"
  | "RENDER_FAILED"
  | "NOT_READABLE";

export interface PageError {
  code: PageErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

const RETRYABLE: Record<PageErrorCode, boolean> = {
  INVALID_INPUT: false,
  BLOCKED_URL: false,
  FETCH_FAILED: true,
  TIMEOUT: true,
  ABORTED: false,
  TOO_LARGE: false,
  RENDER_FAILED: true,
  NOT_READABLE: false,
};

export function isRetryable(code: PageErrorCode): boolean {
  return RETRYABLE[code];
}

export function makePageError(
  code: PageErrorCode,
  message: string,
  retryAfterMs?: number,
): PageError {
  const error: PageError = { code, message, retryable: isRetryable(code) };
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

/** Internal control-flow error carrying the structured failure. */
export class PageFailure extends Error {
  readonly pageError: PageError;

  constructor(pageError: PageError) {
    super(pageError.message);
    this.name = "PageFailure";
    this.pageError = pageError;
  }
}

export function pageFailure(
  code: PageErrorCode,
  message: string,
  retryAfterMs?: number,
): PageFailure {
  return new PageFailure(makePageError(code, message, retryAfterMs));
}

/** Evidence collected from the static HTML that the decision model sees. */
export interface PageFeatures {
  title: string | null;
  language: string | null;
  textChars: number;
  blockCount: number;
  structure: Record<string, number>;
  script: {
    count: number;
    bytesRatio: number;
    emptyAppRoot: boolean;
    hasNoscript: boolean;
  };
  sample: string;
}

export interface PageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  mime: string;
  body: string;
  /** Upstream raw byte count before filtering (observability only). */
  bytes: number;
  /** Number of redirect hops followed (observability only). */
  redirects: number;
  isMarkdownLike: boolean;
  features: PageFeatures;
}

export interface RouteDecision {
  source: "model" | "fallback" | "error" | "none";
  model: string | null;
  needsRender: number | null;
}

export type ExtractionMethod = "source" | "readability" | "plain_text" | "none";

export interface ExtractionResult {
  format: "markdown" | "text";
  text: string;
  method: "source" | "readability" | "plain_text";
  title: string | null;
  siteName: string | null;
  byline: string | null;
  language: string | null;
}

/** Tool output contract. */
export interface FetchPageOutput {
  url: { requested: string; final: string | null };
  page: {
    title: string | null;
    siteName: string | null;
    byline: string | null;
    language: string | null;
  };
  rendered: boolean;
  extraction: ExtractionMethod;
  decision: {
    source: "model" | "fallback" | "error" | "none";
    model: string | null;
    needsRender: number | null;
  };
  content: { format: "markdown" | "text"; text: string; chars: number };
  status: "ok" | "failed";
  error?: PageError;
}

/** The empty feature set used when the source is already Markdown/text. */
export function emptyFeatures(): PageFeatures {
  return {
    title: null,
    language: null,
    textChars: 0,
    blockCount: 0,
    structure: {},
    script: { count: 0, bytesRatio: 0, emptyAppRoot: false, hasNoscript: false },
    sample: "",
  };
}
