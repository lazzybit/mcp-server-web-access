/**
 * DuckDuckGo HTML transport as a {@link SearchProvider}.
 *
 * Owns one complete search: pagination up to the effort budget, a fixed
 * dispatch spacing, and its own persisted cooldown under
 * `search/providers/v2/ddg-html/state`. A challenge or any other failure ends
 * the search immediately and hands the partial results to the coordinator;
 * there is no same-provider retry.
 */
import {
  ATTEMPT_TIMEOUT_MS,
  COOLDOWN_MS,
  DDG_EFFORT_PAGES,
  MAX_BODY_BYTES,
  PROVIDER_INTERVAL_MS,
  TRANSIENT_DELAY_MS,
} from "../constants";
import {
  DEFAULT_ENDPOINT,
  buildPageForm,
  initialFields,
  requestPage,
} from "../ddg/request";
import type { FetchLike } from "../ddg/request";
import { parsePage } from "../ddg/parse";
import type { ParsedPage, ParsedResult } from "../ddg/parse";
import { makeError } from "../types";
import type { AppEnv } from "../env";
import type {
  ErrorCode,
  SearchError,
  SearchParams,
  SearchResultItem,
} from "../types";
import { LEVEL_RANK, RealClock } from "./deps";
import type { Clock, LogLevel, ParseFn, StoragePort } from "./deps";
import type { ProviderAvailability, ProviderOutcome, SearchProvider } from "./provider";

export const DDG_HTML_PROVIDER_ID = "ddg-html";
export const DDG_HTML_STATE_KEY = "search/providers/v2/ddg-html/state";

/** HTML provider dependencies (injectable). */
export interface DdgHtmlDeps {
  clock: Clock;
  fetchImpl: FetchLike;
  parse: ParseFn;
  endpoint: string;
  maxBodyBytes: number;
  /** Fixed minimum between dispatch starts, across pagination and searches. */
  intervalMs: number;
  attemptTimeoutMs: number;
  cooldownMs: number;
  transientDelayMs: number;
  logLevel: LogLevel;
}

/** One atomic snapshot of the provider policy, stored under a single key. */
interface HtmlPersistedState {
  v: 1;
  nextRetryAt: number;
}

const NEVER_DISPATCHED = Number.NEGATIVE_INFINITY;

export function defaultHtmlDeps(env: AppEnv, clock: Clock = new RealClock()): DdgHtmlDeps {
  // `SEARCH_VNC` present → upstream egress uses the VPC Network binding;
  // otherwise the built-in fetch. No other fallback.
  const vpc = env.SEARCH_VNC;
  return {
    clock,
    fetchImpl: vpc !== undefined
      ? (input, init) => vpc.fetch(input, init)
      : (input, init) => fetch(input, init),
    parse: parsePage,
    endpoint: DEFAULT_ENDPOINT,
    maxBodyBytes: MAX_BODY_BYTES,
    intervalMs: PROVIDER_INTERVAL_MS,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
    cooldownMs: COOLDOWN_MS,
    transientDelayMs: TRANSIENT_DELAY_MS,
    logLevel: env.LOG_LEVEL ?? "info",
  };
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
  | { kind: "failure"; failure: UpstreamFailure };

export class DdgHtmlSearchProvider implements SearchProvider {
  readonly id = DDG_HTML_PROVIDER_ID;
  readonly #storage: StoragePort;
  #deps: DdgHtmlDeps;
  #nextRetryAt = 0;
  #lastDispatchAt = NEVER_DISPATCHED;
  #persisted: HtmlPersistedState;

  constructor(storage: StoragePort, deps: DdgHtmlDeps) {
    this.#storage = storage;
    this.#deps = deps;
    this.#persisted = this.#snapshot();
  }

  /** Loads the persisted cooldown. Idempotent. */
  async load(): Promise<void> {
    const stored = await this.#storage.get<HtmlPersistedState>(DDG_HTML_STATE_KEY);
    if (stored === undefined || stored.v !== 1) return;
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
  setDeps(overrides: Partial<DdgHtmlDeps>): void {
    this.#deps = { ...this.#deps, ...overrides };
  }

  getNextRetryAt(): number {
    return this.#nextRetryAt;
  }

  availability(now: number): ProviderAvailability {
    const remaining = this.#nextRetryAt - now;
    if (remaining > 0) return { kind: "cooling", retryAfterMs: remaining };
    return { kind: "ready" };
  }

  /**
   * Runs one complete search from the original query. Never throws: transport,
   * parser and challenge failures are mapped to `fallback` with the partial
   * results collected so far.
   */
  async search(params: SearchParams): Promise<ProviderOutcome> {
    const startedAt = this.#now();
    const pageLimit = DDG_EFFORT_PAGES[params.effort];
    const results: SearchResultItem[] = [];
    const seen = new Set<string>();
    let fields = initialFields(params);
    let pages = 0;
    let dispatches = 0;

    const finish = (outcome: ProviderOutcome): ProviderOutcome => {
      this.#logOutcome(outcome, startedAt, pages, dispatches);
      return outcome;
    };

    try {
      // Defensive: the coordinator only dispatches a ready provider, but a
      // direct caller must not reach the network during a cooldown.
      const initialRemaining = this.#nextRetryAt - this.#now();
      if (initialRemaining > 0) {
        return finish({
          kind: "fallback",
          results,
          error: makeError("RATE_LIMITED", "provider cooling down", initialRemaining),
        });
      }

      for (;;) {
        await this.#waitForPacing();

        // An admitted search can still find the cooldown active when pacing
        // time has passed. Surface it as a cooling provider rather than
        // dispatching during the cooldown.
        const remaining = this.#nextRetryAt - this.#now();
        if (remaining > 0) {
          return finish({
            kind: "fallback",
            results,
            error: makeError("RATE_LIMITED", "provider cooling down", remaining),
          });
        }

        this.#lastDispatchAt = this.#now();
        dispatches += 1;
        const outcome = await this.#dispatch(fields, params);

        switch (outcome.kind) {
          case "failure":
            return finish(this.#fallback(results, outcome.failure));
          case "challenge":
            return finish(this.#fallback(results, {
              kind: "challenge",
              code: "PROVIDER_CHALLENGE",
              message: "DuckDuckGo returned a bot challenge",
            }));
          case "no_results":
            return finish({ kind: "done", result: { status: "exhausted", results } });
          case "unparseable":
            return finish(this.#fallback(results, {
              kind: "transient",
              code: "PARSE_FAILED",
              message: "could not parse the results page",
            }));
          case "results": {
            pages += 1;
            mergeResults(outcome.page.results, seen, results);
            // Confirmed exhaustion wins even on the last allowed page; reaching
            // the effort budget with a continuation available is a normal `ok`.
            if (outcome.page.next === null) {
              return finish({ kind: "done", result: { status: "exhausted", results } });
            }
            if (pages >= pageLimit) {
              return finish({ kind: "done", result: { status: "ok", results } });
            }
            fields = outcome.page.next.fields;
            break;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finish({
        kind: "fallback",
        results,
        error: makeError("UPSTREAM_ERROR", `unexpected failure: ${message}`),
      });
    }
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  #snapshot(): HtmlPersistedState {
    return { v: 1, nextRetryAt: this.#nextRetryAt };
  }

  #sameState(left: HtmlPersistedState, right: HtmlPersistedState): boolean {
    return left.v === right.v && left.nextRetryAt === right.nextRetryAt;
  }

  /**
   * Persists the snapshot when it changed; never rejects and never blocks.
   *
   * The in-memory policy is already applied by the caller; a failed write must
   * not undo it. The Durable Object output gate still guarantees the write is
   * durable before the RPC response, and per-object storage operations are
   * ordered, so a late `#persisted` update cannot overwrite a newer one.
   */
  #persistState(): void {
    const next = this.#snapshot();
    if (this.#sameState(this.#persisted, next)) return;
    void this.#storage.put(DDG_HTML_STATE_KEY, next).then(
      () => {
        this.#persisted = next;
      },
      (error: unknown) => {
        this.#log("error", {
          event: "search_storage_error",
          provider: this.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  async #dispatch(
    fields: ReadonlyArray<readonly [string, string]>,
    params: SearchParams,
  ): Promise<DispatchOutcome> {
    const form = buildPageForm(fields, params);
    const response = await requestPage({
      endpoint: this.#deps.endpoint,
      form,
      deadlineMs: this.#deps.attemptTimeoutMs,
      fetchImpl: this.#deps.fetchImpl,
      maxBodyBytes: this.#deps.maxBodyBytes,
      schedule: (fn, ms) => this.#deps.clock.schedule(fn, ms),
    });

    if (response.kind === "failure") {
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
      // classify it deliberately so it can switch providers.
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

  /** Opens the provider cooldown and returns a `fallback` outcome. */
  #fallback(results: SearchResultItem[], failure: UpstreamFailure): ProviderOutcome {
    const cooldown = failure.kind === "challenge"
      ? this.#deps.cooldownMs
      : this.#deps.transientDelayMs;
    this.#nextRetryAt = this.#now() + cooldown;
    this.#persistState();
    const error: SearchError = makeError(failure.code, failure.message, cooldown);
    return { kind: "fallback", results, error };
  }

  async #waitForPacing(): Promise<void> {
    if (this.#lastDispatchAt === NEVER_DISPATCHED) return;
    const wait = this.#lastDispatchAt + this.#deps.intervalMs - this.#now();
    if (wait > 0) await this.#deps.clock.sleep(wait);
  }

  #logOutcome(
    outcome: ProviderOutcome,
    startedAt: number,
    pages: number,
    dispatches: number,
  ): void {
    const status = outcome.kind === "done"
      ? outcome.result.status
      : outcome.results.length > 0
        ? "interrupted"
        : "failed";
    const count = outcome.kind === "done"
      ? outcome.result.results.length
      : outcome.results.length;
    const code = outcome.kind === "fallback" ? outcome.error.code : undefined;
    const level: LogLevel = status === "failed"
      ? "error"
      : status === "interrupted"
        ? "warn"
        : "info";
    this.#log(level, {
      event: "search_provider",
      provider: this.id,
      status,
      count,
      pages,
      dispatches,
      elapsedMs: Math.max(0, this.#now() - startedAt),
      ...(code !== undefined ? { code } : {}),
    });
  }

  #log(level: LogLevel, payload: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#deps.logLevel]) return;
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else console.log(line);
  }
}

function mergeResults(
  pageResults: ParsedResult[],
  seen: Set<string>,
  out: SearchResultItem[],
): void {
  for (const result of pageResults) {
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
