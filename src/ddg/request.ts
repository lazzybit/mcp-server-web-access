import { BROWSER_SEARCH_USER_AGENT, MAX_BODY_BYTES } from "../constants";
import type { Freshness, SearchParams } from "../types";

/** DuckDuckGo HTML endpoint. Fixed in code; user input never reaches the URL. */
export const DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Fixed request headers. `accept-encoding` is intentionally absent: the runtime
 * negotiates and decompresses compression itself.
 */
export const APP_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": BROWSER_SEARCH_USER_AGENT,
  "accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/x-www-form-urlencoded",
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Cancellable timer. */
export interface TimerHandle {
  cancel(): void;
}

export type ScheduleFn = (fn: () => void, ms: number) => TimerHandle;

const defaultSchedule: ScheduleFn = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(timer) };
};

export type TransportFailureCode = "TIMEOUT" | "ABORTED" | "TOO_LARGE" | "NETWORK";

export type PageResponse =
  | { kind: "http"; status: number; bytes: Uint8Array }
  | { kind: "failure"; code: TransportFailureCode; message: string };

export interface PageRequest {
  endpoint: string;
  /** Form body to POST. */
  form: URLSearchParams;
  /** Relative timeout for this single request (headers + body). */
  deadlineMs: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  maxBodyBytes?: number;
  /** Timer source for the attempt timeout; defaults to real `setTimeout`. */
  schedule?: ScheduleFn;
}

/** Hidden fields of the first page request: `q`, `b`, `kl`. */
export function initialFields(
  params: SearchParams,
): ReadonlyArray<readonly [string, string]> {
  return [["q", params.query], ["b", ""], ["kl", params.region]];
}

const FRESHNESS_DF: Record<Freshness, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/**
 * Replays the "Next" form and overrides `kl`/`l`/`df`. DuckDuckGo echoes old
 * values back, so they must be removed before appending the current ones.
 */
export function buildPageForm(
  fields: ReadonlyArray<readonly [string, string]>,
  params: SearchParams,
): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of fields) {
    if (key === "kl" || key === "l" || key === "df") continue;
    form.append(key, value);
  }
  form.set("kl", params.region);
  if (params.freshness !== undefined) form.set("df", FRESHNESS_DF[params.freshness]);
  return form;
}

/**
 * Performs one page request.
 *
 * Guarantees:
 * - an already-aborted signal returns `ABORTED` without touching the network;
 * - the timeout covers connect, headers and the streamed body, and races the
 *   whole operation so a fetch/body that ignores the abort cannot hang it;
 * - the body is capped at `maxBodyBytes` and cancelled when exceeded;
 * - the timer and abort listener are always released.
 */
export async function requestPage(request: PageRequest): Promise<PageResponse> {
  if (request.signal?.aborted === true) {
    return { kind: "failure", code: "ABORTED", message: "request aborted before it started" };
  }

  const fetchImpl: FetchLike = request.fetchImpl ?? ((input, init) => fetch(input, init));
  const schedule: ScheduleFn = request.schedule ?? defaultSchedule;
  const maxBodyBytes = request.maxBodyBytes ?? MAX_BODY_BYTES;
  const externalSignal = request.signal;
  const controller = new AbortController();
  let abortedByCaller = externalSignal?.aborted ?? false;

  const onExternalAbort = (): void => {
    abortedByCaller = true;
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timerRef: { handle: TimerHandle | null } = { handle: null };
  const timeout = new Promise<PageResponse>((resolve) => {
    timerRef.handle = schedule(() => {
      controller.abort(new DOMException("request deadline exceeded", "TimeoutError"));
      resolve({
        kind: "failure",
        code: "TIMEOUT",
        message: `request exceeded ${request.deadlineMs}ms deadline`,
      });
    }, Math.max(0, request.deadlineMs));
  });

  const work = readResponse(request, fetchImpl, controller.signal, maxBodyBytes, () =>
    abortedByCaller,
  );
  // The loser of the race may still settle later; never surface an unhandled
  // rejection.
  work.catch(() => undefined);

  try {
    return await Promise.race([work, timeout]);
  } finally {
    timerRef.handle?.cancel();
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function readResponse(
  request: PageRequest,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  maxBodyBytes: number,
  wasAbortedByCaller: () => boolean,
): Promise<PageResponse> {
  try {
    const response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: APP_HEADERS,
      body: request.form.toString(),
      signal,
    });
    const read = await readBodyCapped(response, maxBodyBytes, signal);
    if (read === TOO_LARGE) {
      return {
        kind: "failure",
        code: "TOO_LARGE",
        message: `response body exceeded ${maxBodyBytes} bytes`,
      };
    }
    return { kind: "http", status: response.status, bytes: read };
  } catch (error) {
    if (wasAbortedByCaller()) {
      return { kind: "failure", code: "ABORTED", message: "request aborted by caller" };
    }
    return {
      kind: "failure",
      code: "NETWORK",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const TOO_LARGE = Symbol("too-large");

async function readBodyCapped(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | typeof TOO_LARGE> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Bounded body cleanup: a timeout/abort must not leave a pending read
  // holding the stream open. Fire-and-forget; the read settles either way.
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) {
        throw new DOMException("request aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released after cancel; ignore.
    }
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
