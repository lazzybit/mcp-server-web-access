import { env, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserService } from "../../src/browser/service";
import type {
  BrowserSessionClient,
  ReusableBrowser,
  ReusableContext,
  ReusablePage,
  ReusableRequest,
} from "../../src/browser/session";
import { BROWSER_KEEP_ALIVE_MS } from "../../src/page/constants";
import type { NavigationRequestInfo, RequestDecision } from "../../src/browser/launcher";

class FakeRequest implements ReusableRequest {
  aborted = false;
  continued = false;
  readonly settled: Promise<void>;
  #settle: () => void = () => {};

  constructor(
    readonly rawUrl: string,
    readonly navigation: boolean,
  ) {
    this.settled = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  isNavigationRequest(): boolean {
    return this.navigation;
  }

  url(): string {
    return this.rawUrl;
  }

  redirectChain(): ReusableRequest[] {
    return [];
  }

  async continue(): Promise<void> {
    this.continued = true;
    this.#settle();
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.#settle();
  }
}

class FakePage implements ReusablePage {
  readonly gotos: string[] = [];
  readonly evaluations: string[] = [];
  interceptions = 0;
  #handler: ((request: ReusableRequest) => void) | null = null;
  #lastAborted = false;

  async goto(url: string): Promise<unknown> {
    const request = new FakeRequest(url, true);
    await this.#emit(request);
    this.#lastAborted = request.aborted;
    this.gotos.push(url);
    return undefined;
  }

  async content(): Promise<string> {
    await this.#emit(new FakeRequest("https://example.com/from-content", true));
    return "<html>rendered</html>";
  }

  url(): string {
    return this.#lastAborted ? "https://example.com/aborted" : "https://example.com/final";
  }

  async setRequestInterception(): Promise<void> {
    this.interceptions += 1;
  }

  on(event: "request", handler: (request: ReusableRequest) => void): unknown {
    if (event === "request") this.#handler = handler;
    return this;
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluations.push(expression);
    return { expression };
  }

  async setUserAgent(): Promise<void> {}

  async setViewport(): Promise<void> {}

  async setExtraHTTPHeaders(): Promise<void> {}

  async #emit(request: FakeRequest): Promise<void> {
    if (this.#handler === null) return;
    this.#handler(request);
    await request.settled;
  }
}

class FakeContext implements ReusableContext {
  closes = 0;
  readonly pages: FakePage[] = [];

  async newPage(): Promise<ReusablePage> {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

class FakeBrowser implements ReusableBrowser {
  connected = true;
  disconnects = 0;
  readonly contexts: FakeContext[] = [];

  constructor(private readonly onContext: (() => void) | null = null) {}

  async createBrowserContext(): Promise<ReusableContext> {
    this.onContext?.();
    const context = new FakeContext();
    this.contexts.push(context);
    return context;
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
}

class FakeClient implements BrowserSessionClient {
  acquires = 0;
  keepAlive: number | null = null;
  readonly #browsers: FakeBrowser[];

  constructor(browsers: FakeBrowser[]) {
    this.#browsers = browsers;
  }

  async acquire(
    _binding: unknown,
    options: { keep_alive: number },
  ): Promise<{ sessionId: string }> {
    this.acquires += 1;
    this.keepAlive = options.keep_alive;
    return { sessionId: `s${this.acquires}` };
  }

  async connect(): Promise<ReusableBrowser> {
    const browser = this.#browsers.shift();
    if (browser === undefined) throw new Error("no scripted browser");
    return browser;
  }
}

let objectCounter = 0;
function freshName(): string {
  objectCounter += 1;
  return `browser-${objectCounter}`;
}

async function serviceWithClient(
  client: BrowserSessionClient,
): Promise<DurableObjectStub<BrowserService>> {
  const stub = env.BROWSER_SERVICE.getByName(freshName());
  await runInDurableObject(stub, (instance: BrowserService) => {
    instance.setTestDeps({ client });
  });
  return stub;
}

describe("BrowserService", () => {
  afterEach(async () => {
    // These tests inject a fake Browser Run client as a callback stub, which
    // keeps the object busy from the graceful eviction's point of view; abort
    // resets the instances without waiting for the callback session to drain.
    // Every test uses a fresh object name, so no state leaks between tests.
    await abortAllDurableObjects();
  });

  it("opens an isolated context and exposes the page capability", async () => {
    const browser = new FakeBrowser();
    const client = new FakeClient([browser]);
    const stub = await serviceWithClient(client);

    const context = await stub.openContext();
    const page = await context.newPage();
    await page.goto("https://example.com/");
    expect(await page.content()).toBe("<html>rendered</html>");
    expect(await page.url()).toBe("https://example.com/final");
    await page.evaluate("({ ok: true })");

    expect(client.acquires).toBe(1);
    expect(client.keepAlive).toBe(BROWSER_KEEP_ALIVE_MS);
    expect(browser.contexts).toHaveLength(1);
    expect(browser.contexts[0]?.pages).toHaveLength(1);

    await context.close();
    expect(browser.contexts[0]?.closes).toBe(1);
    // The shared connection is never closed by an operation.
    expect(browser.disconnects).toBe(0);
  });

  it("keeps applying the navigation policy after goto returns", async () => {
    const browser = new FakeBrowser();
    const stub = await serviceWithClient(new FakeClient([browser]));
    const context = await stub.openContext();
    const page = await context.newPage();

    const decided: string[] = [];
    const policy = {
      decide: (info: NavigationRequestInfo): RequestDecision => {
        decided.push(info.url);
        return "allow";
      },
    };
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", policy });
    // `content()` emits a second navigation request; the retained policy stub
    // must still decide it.
    await page.content();

    expect(decided).toEqual(["https://example.com/", "https://example.com/from-content"]);
    await context.close();
  });

  it("aborts a navigation the policy rejects", async () => {
    const browser = new FakeBrowser();
    const stub = await serviceWithClient(new FakeClient([browser]));
    const context = await stub.openContext();
    const page = await context.newPage();

    const policy = { decide: (): RequestDecision => "abort" };
    await page.goto("https://example.com/blocked", { policy });
    // The fake page maps the abort to its observed URL; the domain layer turns
    // the resulting Puppeteer navigation error into RENDER_FAILED.
    expect(await page.url()).toBe("https://example.com/aborted");
    await context.close();
  });

  it("reuses one connection across operations", async () => {
    const browser = new FakeBrowser();
    const client = new FakeClient([browser]);
    const stub = await serviceWithClient(client);

    const first = await stub.openContext();
    const second = await stub.openContext();
    expect(first).not.toBe(second);
    expect(client.acquires).toBe(1);
    expect(browser.contexts).toHaveLength(2);

    await first.close();
    await second.close();
    expect(browser.disconnects).toBe(0);
  });

  it("re-acquires a disconnected cached connection", async () => {
    const first = new FakeBrowser();
    const second = new FakeBrowser();
    const client = new FakeClient([first, second]);
    const stub = await serviceWithClient(client);

    await stub.openContext();
    first.connected = false;
    const context = await stub.openContext();

    expect(client.acquires).toBe(2);
    expect(second.contexts).toHaveLength(1);
    expect(first.disconnects).toBeGreaterThanOrEqual(1);
    await context.close();
  });

  it("recovers once when context creation proves the connection was lost", async () => {
    const broken = new FakeBrowser(() => {
      broken.connected = false;
      throw new Error("connection lost");
    });
    const healthy = new FakeBrowser();
    const client = new FakeClient([broken, healthy]);
    const stub = await serviceWithClient(client);

    const context = await stub.openContext();
    expect(client.acquires).toBe(2);
    expect(healthy.contexts).toHaveLength(1);
    expect(broken.disconnects).toBeGreaterThanOrEqual(1);
    await context.close();
  });

  it("ignores and never writes the legacy session key", async () => {
    const browser = new FakeBrowser();
    const client = new FakeClient([browser]);
    const name = freshName();
    const stub = env.BROWSER_SERVICE.getByName(name);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("browser/session/v1", "legacy");
    });
    await runInDurableObject(stub, (instance: BrowserService) => {
      instance.setTestDeps({ client });
    });

    const context = await stub.openContext();
    await context.close();

    const stored = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get<string>("browser/session/v1"),
    );
    expect(stored).toBe("legacy");
  });
});
