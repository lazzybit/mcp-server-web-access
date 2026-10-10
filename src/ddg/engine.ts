import {
  ATTEMPT_TIMEOUT_MS,
  COOLDOWN_MS,
  FAILURE_THRESHOLD,
  INTERVAL_DECREASE_FACTOR,
  INTERVAL_INCREASE_FACTOR,
  MAX_BODY_BYTES,
  MAX_INTERVAL_MS,
  MAX_PAGES,
  MIN_INTERVAL_MS,
  TRANSIENT_DELAY_MS,
} from "../constants";
import {
  DEFAULT_ENDPOINT,
  buildPageForm,
  initialFields,
  requestPage,
} from "./request";
import type { FetchLike } from "./request";
import { parsePage } from "./parse";
import type { ParsedPage, ParsedResult } from "./parse";
import { interruptedOrFailed, makeError } from "../types";
import type { AppEnv } from "../env";
import type {
  ErrorCode,
  SearchError,
  SearchRequest,
  SearchResult,
  SearchResultItem,
} from "../types";

/**
 * Search engine behind `DdgService`: FIFO queue, adaptive persisted pacing,
 * per-job deadlines, in-job retries and a persisted cooldown. Free of
 * `cloudflare:workers` so it also runs under Node.
 */

/** Cancellable timer. */
export interface CancelTimer {
  cancel(): void;
}

export interface Clock {
  now(): number;
  /** Sleeps up to `ms`; resolves early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  schedule(fn: () => void, ms: number): CancelTimer;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  schedule(fn: () => void, ms: number): CancelTimer {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  }
}

/** Parser injection point. */
export type ParseFn = (
  body: Uint8Array | ReadableStream<Uint8Array>,
  status: number,
  base: string,
) => Promise<ParsedPage>;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Engine dependencies (injectable). */
export interface DdgDeps {
  clock: Clock;
  fetchImpl: FetchLike;
  parse: ParseFn;
  endpoint: string;
  maxBodyBytes: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  increaseFactor: number;
  decreaseFactor: number;
  failureThreshold: number;
  attemptTimeoutMs: number;
  cooldownMs: number;
  transientDelayMs: number;
  maxPages: number;
  logLevel: LogLevel;
}

/** Persistence port supplied by the Durable Object. */
export interface StoragePort {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * One atomic snapshot of the pacing/cooldown policy, stored under a single
 * key. `load()` reads only this format; there is no legacy migration.
 */
interface PersistedState {
  v: 1;
  intervalMs: number;
  consecutiveFailures: number;
  nextRetryAt: number;
}

const STATE_KEY = "ddgState";

export function defaultDdgDeps(env: AppEnv): DdgDeps {
  // `SEARCH_VNC` present → upstream egress uses the VPC Network binding;
  // otherwise the built-in fetch. No other fallback.
  const vpc = env.SEARCH_VNC;
  return {
    clock: new RealClock(),
    fetchImpl: vpc !== undefined
      ? (input, init) => vpc.fetch(input, init)
      : (input, init) => fetch(input, init),
    parse: parsePage,
    endpoint: DEFAULT_ENDPOINT,
    maxBodyBytes: MAX_BODY_BYTES,
    minIntervalMs: MIN_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
    increaseFactor: INTERVAL_INCREASE_FACTOR,
    decreaseFactor: INTERVAL_DECREASE_FACTOR,
    failureThreshold: FAILURE_THRESHOLD,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
    cooldownMs: COOLDOWN_MS,
    transientDelayMs: TRANSIENT_DELAY_MS,
    maxPages: MAX_PAGES,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

interface Job {
  readonly req: SearchRequest;
  readonly abort: AbortController;
  readonly promise: Promise<SearchResult>;
  resolve: (result: SearchResult) => void;
  settled: boolean;
  state: "queued" | "active";
  cancelTimer: () => void;
  dispatches: number;
  pages: number;
  waitMs: number;
  startedAt: number;
}

interface UpstreamFailure {
  kind: "challenge" | "transient";
  code: ErrorCode;
  message: string;
}

type ResultsPage = Extract<ParsedPage, { kind: "results" }>;

type DispatchOutcome =
  | { kind: "results"; page: ResultsPage }
  | { kind: "no_results" }
  | { kind: "challenge" }
  | { kind: "unparseable" }
  | { kind: "failure"; failure: UpstreamFailure }
  | { kind: "aborted"; message: string };

const NEVER_DISPATCHED = Number.NEGATIVE_INFINITY;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class DdgEngine {
  readonly #storage: StoragePort;
  #deps: DdgDeps;
  #nextRetryAt = 0;
  #intervalMs: number;
  #consecutiveFailures = 0;
  #persisted: PersistedState;
  #queue: Job[] = [];
  #running = false;
  #lastDispatchAt = NEVER_DISPATCHED;

  constructor(storage: StoragePort, deps: DdgDeps) {
    this.#storage = storage;
    this.#deps = deps;
    this.#intervalMs = deps.minIntervalMs;
    this.#persisted = this.#snapshot();
  }

  /** Loads the persisted pacing/cooldown snapshot. Idempotent. */
  async load(): Promise<void> {
    const stored = await this.#storage.get<PersistedState>(STATE_KEY);
    if (stored === undefined || stored.v !== 1) return;
    if (typeof stored.intervalMs === "number" && Number.isFinite(stored.intervalMs)) {
      this.#intervalMs = this.#clampInterval(stored.intervalMs);
    }
    if (
      typeof stored.consecutiveFailures === "number" &&
      Number.isInteger(stored.consecutiveFailures) &&
      stored.consecutiveFailures >= 0
    ) {
      this.#consecutiveFailures = Math.min(
        stored.consecutiveFailures,
        this.#deps.failureThreshold,
      );
    }
    if (
      typeof stored.nextRetryAt === "number" &&
      Number.isFinite(stored.nextRetryAt) &&
      stored.nextRetryAt >= 0
    ) {
      this.#nextRetryAt = stored.nextRetryAt;
    }
    this.#persisted = this.#snapshot();
  }

  /** Test-only seam: override timing/transport dependencies. */
  setDeps(overrides: Partial<DdgDeps>): void {
    this.#deps = { ...this.#deps, ...overrides };
    this.#intervalMs = this.#clampInterval(this.#intervalMs);
  }

  getNextRetryAt(): number {
    return this.#nextRetryAt;
  }

  getIntervalMs(): number {
    return this.#intervalMs;
  }

  getConsecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  #clampInterval(value: number): number {
    const min = this.#deps.minIntervalMs;
    const max = Math.max(min, this.#deps.maxIntervalMs);
    return Math.min(Math.max(value, min), max);
  }

  #snapshot(): PersistedState {
    return {
      v: 1,
      intervalMs: this.#intervalMs,
      consecutiveFailures: this.#consecutiveFailures,
      nextRetryAt: this.#nextRetryAt,
    };
  }

  #sameState(left: PersistedState, right: PersistedState): boolean {
    return (
      left.v === right.v &&
      left.intervalMs === right.intervalMs &&
      left.consecutiveFailures === right.consecutiveFailures &&
      left.nextRetryAt === right.nextRetryAt
    );
  }

  /** Persists the snapshot when it changed; never rejects. */
  async #persistState(): Promise<void> {
    const next = this.#snapshot();
    if (this.#sameState(this.#persisted, next)) return;
    try {
      await this.#storage.put(STATE_KEY, next);
      this.#persisted = next;
    } catch (error) {
      // Keep the in-memory state; a failed write must not undo policy changes.
      this.#log("error", {
        event: "ddg_storage_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Runs one complete search. `deadlineAt` is set by the Worker. Caller
   * cancellation does not cross RPC; only the `deadlineAt` timer aborts an
   * active job. While the global cooldown is active, the call is rejected
   * immediately with `RATE_LIMITED`.
   */
  async search(req: SearchRequest): Promise<SearchResult> {
    const now = this.#now();
    if (now < this.#nextRetryAt) {
      const retryAfterMs = this.#nextRetryAt - now;
      this.#log("info", { event: "ddg_search_rejected", code: "RATE_LIMITED", retryAfterMs });
      return failed(makeError("RATE_LIMITED", "upstream cooling down", retryAfterMs));
    }
    const job = this.#createJob(req);
    this.#queue.push(job);
    this.#ensureDrain();
    return job.promise;
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  #createJob(req: SearchRequest): Job {
    let resolve: (result: SearchResult) => void = () => {};
    const promise = new Promise<SearchResult>((res) => {
      resolve = res;
    });
    const abort = new AbortController();
    const job: Job = {
      req,
      abort,
      promise,
      resolve,
      settled: false,
      state: "queued",
      cancelTimer: () => {},
      dispatches: 0,
      pages: 0,
      waitMs: 0,
      startedAt: this.#now(),
    };
    const delay = Math.max(0, req.deadlineAt - this.#now());
    const timer = this.#deps.clock.schedule(() => {
      if (job.settled) return;
      if (job.state === "queued") {
        this.#settle(job, failed(makeError("TIMEOUT", "deadline exceeded while queued")));
      } else {
        job.abort.abort(new Error("job deadline exceeded"));
      }
    }, delay);
    job.cancelTimer = () => timer.cancel();
    return job;
  }

  #settle(job: Job, result: SearchResult): void {
    if (job.settled) return;
    job.settled = true;
    job.cancelTimer();
    this.#logSearch(job, result);
    job.resolve(result);
  }

  #ensureDrain(): void {
    if (this.#running) return;
    void this.#drainQueue().catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "ddg_drain_error",
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  async #drainQueue(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift();
        if (job === undefined) break;
        if (job.settled) continue;
        if (this.#now() >= job.req.deadlineAt) {
          this.#settle(job, failed(makeError("TIMEOUT", "deadline exceeded before start")));
          continue;
        }
        job.state = "active";
        job.waitMs = Math.max(0, this.#now() - job.startedAt);
        await this.#runJob(job);
        if (this.#now() < this.#nextRetryAt) this.#flushQueueForCooldown();
      }
    } finally {
      this.#running = false;
      if (this.#queue.length > 0) this.#ensureDrain();
    }
  }

  async #runJob(job: Job): Promise<void> {
    const { params } = job.req;
    const results: SearchResultItem[] = [];
    const seen = new Set<string>();
    let fields = initialFields(params);
    let pages = 0;

    try {
      for (;;) {
        if (job.abort.signal.aborted) {
          this.#settle(job, interruptedOrFailed(results, makeError("ABORTED", "search aborted")));
          return;
        }
        if (this.#now() >= job.req.deadlineAt) {
          this.#settle(job, interruptedOrFailed(results, makeError("TIMEOUT", "search deadline exceeded")));
          return;
        }
        if (pages >= this.#deps.maxPages) {
          this.#settle(
            job,
            interruptedOrFailed(
              results,
              makeError("PAGE_LIMIT", `stopped after ${this.#deps.maxPages} pages`),
            ),
          );
          return;
        }

        await this.#waitForPacing(job);

        if (job.abort.signal.aborted) {
          this.#settle(job, interruptedOrFailed(results, makeError("ABORTED", "search aborted")));
          return;
        }
        const beforeDispatch = this.#now();
        if (beforeDispatch >= job.req.deadlineAt) {
          this.#settle(job, interruptedOrFailed(results, makeError("TIMEOUT", "search deadline exceeded")));
          return;
        }
        if (beforeDispatch < this.#nextRetryAt) {
          this.#settle(
            job,
            interruptedOrFailed(
              results,
              makeError("RATE_LIMITED", "upstream cooling down", this.#nextRetryAt - beforeDispatch),
            ),
          );
          return;
        }

        this.#lastDispatchAt = this.#now();
        job.dispatches += 1;
        const remaining = job.req.deadlineAt - this.#now();
        const timeoutMs = Math.max(1, Math.min(this.#deps.attemptTimeoutMs, remaining));
        const outcome = await this.#dispatch(fields, job, timeoutMs);

        switch (outcome.kind) {
          case "aborted":
            this.#settle(job, interruptedOrFailed(results, makeError("ABORTED", outcome.message)));
            return;
          case "failure":
            if (!(await this.#handleUpstreamFailure(job, outcome.failure, results))) return;
            break;
          case "challenge":
            if (
              !(await this.#handleUpstreamFailure(job, {
                kind: "challenge",
                code: "PROVIDER_CHALLENGE",
                message: "DuckDuckGo returned a bot challenge",
              }, results))
            ) {
              return;
            }
            break;
          case "no_results":
            await this.#recordSuccess();
            this.#settle(job, { status: "exhausted", results });
            return;
          case "unparseable":
            if (
              !(await this.#handleUpstreamFailure(job, {
                kind: "transient",
                code: "PARSE_FAILED",
                message: "could not parse the results page",
              }, results))
            ) {
              return;
            }
            break;
          case "results": {
            await this.#recordSuccess();
            pages += 1;
            job.pages = pages;
            mergeResults(outcome.page.results, seen, results, params.maxResults);
            // Re-check cancellation/deadline after fetching and parsing.
            if (job.abort.signal.aborted) {
              this.#settle(job, interruptedOrFailed(results, makeError("ABORTED", "search aborted")));
              return;
            }
            if (this.#now() >= job.req.deadlineAt) {
              this.#settle(job, interruptedOrFailed(results, makeError("TIMEOUT", "search deadline exceeded")));
              return;
            }
            if (results.length >= params.maxResults) {
              this.#settle(job, { status: "ok", results });
              return;
            }
            if (outcome.page.next === null) {
              this.#settle(job, { status: "exhausted", results });
              return;
            }
            fields = outcome.page.next.fields;
            break;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#settle(
        job,
        interruptedOrFailed(results, makeError("UPSTREAM_ERROR", `unexpected failure: ${message}`)),
      );
    }
  }

  async #dispatch(
    fields: ReadonlyArray<readonly [string, string]>,
    job: Job,
    timeoutMs: number,
  ): Promise<DispatchOutcome> {
    const form = buildPageForm(fields, job.req.params);
    const response = await requestPage({
      endpoint: this.#deps.endpoint,
      form,
      deadlineMs: timeoutMs,
      signal: job.abort.signal,
      fetchImpl: this.#deps.fetchImpl,
      maxBodyBytes: this.#deps.maxBodyBytes,
      schedule: (fn, ms) => this.#deps.clock.schedule(fn, ms),
    });

    if (response.kind === "failure") {
      if (response.code === "ABORTED") {
        return { kind: "aborted", message: response.message };
      }
      return {
        kind: "failure",
        failure: { kind: "transient", code: "UPSTREAM_ERROR", message: response.message },
      };
    }

    // Parse before status classification: anomaly pages can arrive on non-200.
    let parsed: ParsedPage;
    try {
      parsed = await this.#deps.parse(response.bytes, response.status, this.#deps.endpoint);
    } catch (error) {
      // A parser throw is an upstream-content failure, not an internal bug:
      // classify it deliberately so it feeds the retry/cooldown policy.
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "failure",
        failure: {
          kind: "transient",
          code: "PARSE_FAILED",
          message: `could not parse the results page: ${message}`,
        },
      };
    }
    if (parsed.kind === "challenge" || response.status === 429) {
      return { kind: "challenge" };
    }
    if (response.status !== 200 && response.status !== 202) {
      return {
        kind: "failure",
        failure: {
          kind: "transient",
          code: "UPSTREAM_ERROR",
          message: `upstream status ${response.status}`,
        },
      };
    }

    switch (parsed.kind) {
      case "results":
        return { kind: "results", page: parsed };
      case "no_results":
        return { kind: "no_results" };
      case "unparseable":
        return { kind: "unparseable" };
    }
  }

  /**
   * Records one upstream failure. Returns `true` when the caller should retry
   * the same page within the active job, `false` once cooldown was entered and
   * the job has been settled.
   */
  async #handleUpstreamFailure(
    job: Job,
    failure: UpstreamFailure,
    results: SearchResultItem[],
  ): Promise<boolean> {
    this.#consecutiveFailures += 1;
    this.#intervalMs = this.#clampInterval(this.#intervalMs * this.#deps.increaseFactor);

    if (this.#consecutiveFailures < this.#deps.failureThreshold) {
      await this.#persistState();
      return true;
    }

    const cooldown =
      failure.kind === "challenge" ? this.#deps.cooldownMs : this.#deps.transientDelayMs;
    this.#nextRetryAt = this.#now() + cooldown;
    this.#consecutiveFailures = 0;
    // Flush queued searches before awaiting storage: a slow or failed write
    // must not let them escape a (possibly short) cooldown window.
    this.#flushQueueForCooldown();
    await this.#persistState();
    const error: SearchError = makeError(failure.code, failure.message, cooldown);
    this.#settle(job, interruptedOrFailed(results, error));
    return false;
  }

  /** Records one successful dispatch: reset the streak, decay the interval. */
  async #recordSuccess(): Promise<void> {
    this.#consecutiveFailures = 0;
    this.#intervalMs = this.#clampInterval(this.#intervalMs * this.#deps.decreaseFactor);
    await this.#persistState();
  }

  #flushQueueForCooldown(): void {
    const remaining = Math.max(0, this.#nextRetryAt - this.#now());
    const queued = this.#queue.splice(0, this.#queue.length);
    for (const job of queued) {
      if (job.settled) continue;
      this.#settle(job, failed(makeError("RATE_LIMITED", "upstream cooling down", remaining)));
    }
  }

  async #waitForPacing(job: Job): Promise<void> {
    if (this.#lastDispatchAt === NEVER_DISPATCHED) return;
    const wait = this.#lastDispatchAt + this.#intervalMs - this.#now();
    if (wait > 0) await this.#deps.clock.sleep(wait, job.abort.signal);
  }

  #logSearch(job: Job, result: SearchResult): void {
    const level: LogLevel =
      result.status === "failed" ? "error" : result.status === "interrupted" ? "warn" : "info";
    this.#log(level, {
      event: "ddg_search",
      status: result.status,
      count: result.results.length,
      requested: job.req.params.maxResults,
      pages: job.pages,
      dispatches: job.dispatches,
      waitMs: job.waitMs,
      elapsedMs: Math.max(0, this.#now() - job.startedAt),
      ...(result.status === "interrupted" || result.status === "failed"
        ? { code: result.error.code, retryAfterMs: result.error.retryAfterMs }
        : {}),
    });
  }

  #log(level: LogLevel, payload: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#deps.logLevel]) return;
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else console.log(line);
  }
}

function failed(error: SearchError): SearchResult {
  return { status: "failed", results: [], error };
}

function mergeResults(
  pageResults: ParsedResult[],
  seen: Set<string>,
  out: SearchResultItem[],
  maxResults: number,
): void {
  for (const result of pageResults) {
    if (out.length >= maxResults) return;
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    out.push({
      rank: out.length + 1,
      title: result.title,
      url: result.url,
      domain: result.domain,
      snippet: result.snippet,
    });
  }
}
