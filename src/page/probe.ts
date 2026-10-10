/**
 * The single bounded GET used as the probe.
 *
 * No HEAD request: the first GET is the probe. Redirects are followed
 * manually so every hop is re-validated. The decoded body (or, for
 * `text/markdown`/`text/plain`, the raw text) is kept for reuse.
 */
import { ACCEPT_HEADER, FETCH_ATTEMPT_TIMEOUT_MS, MAX_BODY_BYTES, MAX_REDIRECTS } from "./constants";
import { TimeoutError, operationWindow, withTimeout } from "./timeout";
import { collectFeatures } from "./features";
import { assertAllowedUrl } from "./ssrf";
import { emptyFeatures } from "./types";
import type { PageSnapshot } from "./types";
import { PageFailure, pageFailure } from "./types";

export interface ProbeOptions {
  fetch: typeof fetch;
  userAgent: string;
  maxRedirects?: number;
  /** Upper bound for one redirect hop (headers + body). Defaults to `FETCH_ATTEMPT_TIMEOUT_MS`. */
  attemptTimeoutMs?: number;
}

export async function probePage(initialUrl: URL, options: ProbeOptions): Promise<PageSnapshot> {
  const fetchImpl = options.fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? FETCH_ATTEMPT_TIMEOUT_MS;
  let current = initialUrl;
  let redirects = 0;

  while (true) {
    // A fresh window per hop covers headers and body; the race guarantees
    // settlement even when the fetch implementation ignores the abort signal.
    const window = operationWindow(attemptTimeoutMs);
    try {
      const response = await withTimeout(
        fetchImpl(current.href, {
          method: "GET",
          redirect: "manual",
          headers: { accept: ACCEPT_HEADER, "user-agent": options.userAgent },
          signal: window.signal,
        }),
        window.remaining(),
        "the request exceeded its deadline",
      );

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await cancelBody(response);
        if (location === null || location === "") {
          throw pageFailure("FETCH_FAILED", "redirect response without a Location header");
        }
        if (redirects >= maxRedirects) {
          throw pageFailure("FETCH_FAILED", `more than ${maxRedirects} redirects`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw pageFailure("BLOCKED_URL", "redirect Location could not be parsed");
        }
        assertAllowedUrl(next);
        current = next;
        redirects += 1;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        await cancelBody(response);
        throw pageFailure(
          "FETCH_FAILED",
          `upstream returned HTTP ${response.status}`,
          retryAfterMs(response),
        );
      }

      const { mime, charset } = parseContentType(response.headers.get("content-type"));
      const bytes = await withTimeout(
        readBody(response, window.signal),
        window.remaining(),
        "the request exceeded its deadline",
      );
      const body = decodeBody(bytes, charset);
      const isMarkdownLike = mime === "text/markdown" || mime === "text/plain";
      const features = isMarkdownLike ? emptyFeatures() : await collectFeatures(body);

      return {
        requestedUrl: initialUrl.href,
        finalUrl: current.href,
        status: response.status,
        mime,
        body,
        bytes: bytes.byteLength,
        redirects,
        isMarkdownLike,
        features,
      };
    } catch (error) {
      if (error instanceof PageFailure) throw error;
      throw classifyTransportError(error, window.timedOut());
    } finally {
      window.dispose();
    }
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function classifyTransportError(error: unknown, stageTimedOut: boolean): PageFailure {
  if (stageTimedOut || error instanceof TimeoutError) {
    return pageFailure("TIMEOUT", "the request exceeded its deadline");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return pageFailure("ABORTED", "the request was aborted");
  }
  return pageFailure("FETCH_FAILED", "the upstream request failed");
}

export function parseContentType(header: string | null): { mime: string; charset: string | null } {
  if (header === null || header.trim() === "") return { mime: "text/html", charset: null };
  const parts = header.split(";");
  const mime = (parts.shift() ?? "").trim().toLowerCase() || "text/html";
  let charset: string | null = null;
  for (const part of parts) {
    const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(part);
    if (match !== null && match[1] !== undefined) charset = match[1].toLowerCase();
  }
  return { mime, charset };
}

/** Streams the body while enforcing the decoded-size cap. */
export async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Bounded cleanup: an abort/timeout must not leave a pending read holding
  // the stream open.
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) {
        const abortError = new Error("the request was aborted");
        abortError.name = "AbortError";
        throw abortError;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw pageFailure("TOO_LARGE", `response body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeBody(bytes: Uint8Array, charset: string | null): string {
  if (charset !== null) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel().catch(() => undefined);
}

function retryAfterMs(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
