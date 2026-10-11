/**
 * Durable Object side of the browser capability.
 *
 * `BrowserService.openContext()` returns a {@link ContextTarget}; the caller
 * drives the operation through the returned RPC targets. Puppeteer objects
 * never leave the Durable Object: `goto` returns plain data, `url()` is
 * asynchronous, and `evaluate` takes an expression string.
 *
 * Request interception is installed once, on the first `goto` that carries a
 * policy, and stays active for the page's lifetime (navigation, settling wait
 * and `content()`). Non-navigation requests are continued locally; navigation
 * requests are decided by the caller-owned policy callback, whose stub is
 * retained with `dup()` and disposed when the context closes. The URL policy
 * itself stays in the caller (`src/page/browser.ts`).
 *
 * This module imports `cloudflare:workers` and is therefore Durable-Object
 * only; it must never be imported by the Node-only test project.
 */
import { RpcTarget } from "cloudflare:workers";
import { BROWSER_CALL_TIMEOUT_MS } from "../page/constants";
import { withTimeout } from "../page/timeout";
import type {
  NavigationRequestInfo,
  PageGotoOptions,
  RequestDecision,
  RequestPolicy,
} from "./launcher";
import type { ReusableContext, ReusablePage, ReusableRequest } from "./session";

/** A policy callback received over RPC: a function stub with memory helpers. */
interface RetainedDecision {
  (info: NavigationRequestInfo): RequestDecision | Promise<RequestDecision>;
  dup(): RetainedDecision;
  [Symbol.dispose](): void;
}

/** One page inside an operation's incognito context. */
export class PageTarget extends RpcTarget {
  readonly #page: ReusablePage;
  readonly #callTimeoutMs: number;
  #decide: RetainedDecision | null = null;

  constructor(page: ReusablePage, callTimeoutMs: number = BROWSER_CALL_TIMEOUT_MS) {
    super();
    this.#page = page;
    this.#callTimeoutMs = callTimeoutMs;
  }

  /** Navigates once; installs interception when a policy is provided. */
  async goto(url: string, options?: PageGotoOptions): Promise<void> {
    if (options?.policy !== undefined && this.#decide === null) {
      await this.#installPolicy(options.policy.decide);
    }
    const gotoOptions: { waitUntil?: string; timeout?: number } = {};
    if (options?.waitUntil !== undefined) gotoOptions.waitUntil = options.waitUntil;
    if (options?.timeout !== undefined) gotoOptions.timeout = options.timeout;
    await this.#page.goto(url, gotoOptions);
  }

  async content(): Promise<string> {
    return this.#page.content();
  }

  async url(): Promise<string> {
    return this.#page.url();
  }

  /** Evaluates a serialized in-page expression and returns its value. */
  async evaluate(expression: string): Promise<unknown> {
    return this.#page.evaluate(expression);
  }

  async setUserAgent(value: string): Promise<void> {
    if (typeof this.#page.setUserAgent === "function") {
      await this.#page.setUserAgent(value);
    }
  }

  async setViewport(viewport: { readonly width: number; readonly height: number }): Promise<void> {
    if (typeof this.#page.setViewport === "function") {
      await this.#page.setViewport(viewport);
    }
  }

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    if (typeof this.#page.setExtraHTTPHeaders === "function") {
      await this.#page.setExtraHTTPHeaders(headers);
    }
  }

  /** Releases the retained policy stub; safe to call repeatedly. */
  [Symbol.dispose](): void {
    const decide = this.#decide;
    this.#decide = null;
    if (decide !== null) decide[Symbol.dispose]();
  }

  async #installPolicy(decideFn: RequestPolicy["decide"]): Promise<void> {
    const decide = decideFn as unknown as RetainedDecision;
    // The parameter stub is disposed when `goto` returns; retain a duplicate
    // so interception survives the settling wait and `content()`.
    this.#decide = typeof decide.dup === "function" ? decide.dup() : decide;
    await this.#page.setRequestInterception(true);
    this.#page.on("request", (request) => {
      void this.#handleRequest(request);
    });
  }

  async #handleRequest(request: ReusableRequest): Promise<void> {
    if (!request.isNavigationRequest()) {
      await request.continue().catch(() => undefined);
      return;
    }
    const info: NavigationRequestInfo = {
      url: request.url(),
      redirectChain: request.redirectChain().map((entry) => entry.url()),
    };
    const decide = this.#decide;
    let decision: RequestDecision = "abort";
    if (decide !== null) {
      try {
        decision = await withTimeout(
          Promise.resolve(decide(info)),
          this.#callTimeoutMs,
          "request policy timed out",
        );
      } catch {
        // A failed or slow policy fails closed, like a disallowed URL.
        decision = "abort";
      }
    }
    if (decision === "allow") {
      await request.continue().catch(() => undefined);
    } else {
      await request.abort().catch(() => undefined);
    }
  }
}

/** One operation's incognito context; owns the pages created through it. */
export class ContextTarget extends RpcTarget {
  readonly #context: ReusableContext;
  readonly #callTimeoutMs: number;
  readonly #pages = new Set<PageTarget>();
  #closed = false;

  constructor(context: ReusableContext, callTimeoutMs: number = BROWSER_CALL_TIMEOUT_MS) {
    super();
    this.#context = context;
    this.#callTimeoutMs = callTimeoutMs;
  }

  async newPage(): Promise<PageTarget> {
    if (this.#closed) throw new Error("browser context is closed");
    const page = await this.#context.newPage();
    const target = new PageTarget(page, this.#callTimeoutMs);
    this.#pages.add(target);
    return target;
  }

  /** Closes the incognito context and every page it owns. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const target of this.#pages) target[Symbol.dispose]();
    this.#pages.clear();
    await this.#context.close();
  }

  [Symbol.dispose](): void {
    void this.close().catch(() => undefined);
  }
}
