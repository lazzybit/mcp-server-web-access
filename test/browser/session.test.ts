import { describe, expect, it } from "vitest";
import { serializeExpression } from "../../src/browser/launcher";
import { ReusableBrowserSession } from "../../src/browser/session";
import type {
  BrowserSessionClient,
  ReusableBrowser,
  ReusableContext,
  ReusablePage,
} from "../../src/browser/session";

function page(): ReusablePage {
  return {
    async goto() {
      return undefined;
    },
    async content() {
      return "<html></html>";
    },
    url() {
      return "https://example.com/";
    },
    async setRequestInterception() {},
    on() {},
    async evaluate() {
      return undefined;
    },
  };
}

class FakeContext implements ReusableContext {
  closes = 0;

  async newPage(): Promise<ReusablePage> {
    return page();
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

class FakeBrowser implements ReusableBrowser {
  connected = true;
  disconnects = 0;
  readonly contexts: FakeContext[] = [];
  #next: () => Promise<ReusableContext>;

  constructor(next?: () => Promise<ReusableContext>) {
    this.#next = next ?? (async () => new FakeContext());
  }

  async createBrowserContext(): Promise<ReusableContext> {
    const context = (await this.#next()) as FakeContext;
    this.contexts.push(context);
    return context;
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
}

interface ClientScript {
  sessions?: string[];
  browsers?: Array<ReusableBrowser | (() => Promise<ReusableBrowser>)>;
}

class FakeClient implements BrowserSessionClient {
  acquires = 0;
  lastKeepAlive: number | null = null;
  readonly connects: string[] = [];
  readonly #sessions: string[];
  readonly #browsers: Array<ReusableBrowser | (() => Promise<ReusableBrowser>)>;

  constructor(script: ClientScript = {}) {
    this.#sessions = script.sessions ?? ["s1"];
    this.#browsers = script.browsers ?? [];
  }

  async acquire(_binding: unknown, options: { keep_alive: number }): Promise<{ sessionId: string }> {
    this.acquires += 1;
    this.lastKeepAlive = options.keep_alive;
    return { sessionId: this.#sessions.shift() ?? "s1" };
  }

  async connect(_binding: unknown, sessionId: string): Promise<ReusableBrowser> {
    this.connects.push(sessionId);
    const next = this.#browsers.shift();
    if (next === undefined) throw new Error("no scripted browser");
    return typeof next === "function" ? next() : next;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ReusableBrowserSession", () => {
  it("acquires once and reuses the connection across operations", async () => {
    const browser = new FakeBrowser();
    const client = new FakeClient({ browsers: [browser] });
    const session = new ReusableBrowserSession({ binding: {}, client, keepAliveMs: 10_000 });

    const first = await session.openContext();
    const second = await session.openContext();
    expect(first).not.toBe(second);

    expect(client.acquires).toBe(1);
    expect(client.connects).toEqual(["s1"]);
    expect(client.lastKeepAlive).toBe(10_000);
    expect(browser.contexts).toHaveLength(2);

    await first.close();
    expect(browser.contexts[0]?.closes).toBe(1);
    expect(browser.contexts[1]?.closes).toBe(0);
    // The shared connection is never disconnected by an operation.
    expect(browser.disconnects).toBe(0);
  });

  it("shares a single in-flight acquisition across concurrent callers", async () => {
    let release: (value: ReusableBrowser) => void = () => {};
    const gate = new Promise<ReusableBrowser>((resolve) => {
      release = resolve;
    });
    const browser = new FakeBrowser();
    const client = new FakeClient({ browsers: [() => gate] });
    const session = new ReusableBrowserSession({ binding: {}, client });

    const first = session.openContext();
    const second = session.openContext();
    release(browser);
    const [a, b] = await Promise.all([first, second]);

    expect(a).not.toBe(b);
    expect(client.acquires).toBe(1);
    expect(client.connects).toEqual(["s1"]);
    expect(browser.contexts).toHaveLength(2);
  });

  it("invalidates a disconnected connection and reconnects once", async () => {
    const first = new FakeBrowser();
    const second = new FakeBrowser();
    first.connected = false;
    const client = new FakeClient({ sessions: ["s1", "s2"], browsers: [first, second] });
    const session = new ReusableBrowserSession({ binding: {}, client });

    const original = await session.openContext();
    const replacement = await session.openContext();

    expect(original).not.toBe(replacement);
    expect(client.connects).toEqual(["s1", "s2"]);
    expect(first.disconnects).toBeGreaterThanOrEqual(1);
    expect(second.contexts).toHaveLength(1);
  });

  it("does not retry a failed context on a healthy connection", async () => {
    const browser = new FakeBrowser(async () => {
      throw new Error("context failed");
    });
    const client = new FakeClient({ browsers: [browser] });
    const session = new ReusableBrowserSession({ binding: {}, client });

    await expect(session.openContext()).rejects.toThrow("context failed");
    expect(client.acquires).toBe(1);
    expect(client.connects).toEqual(["s1"]);
  });

  it("recovers once when a failed context proves the connection was lost", async () => {
    const broken = new FakeBrowser(async () => {
      broken.connected = false;
      throw new Error("connection lost");
    });
    const healthy = new FakeBrowser();
    const client = new FakeClient({ sessions: ["s1", "s2"], browsers: [broken, healthy] });
    const session = new ReusableBrowserSession({ binding: {}, client });

    const context = await session.openContext();
    expect(context).toBeInstanceOf(FakeContext);
    expect(client.connects).toEqual(["s1", "s2"]);
    expect(broken.disconnects).toBeGreaterThanOrEqual(1);
  });

  it("does not recover a second time when the replacement also fails", async () => {
    const broken = new FakeBrowser(async () => {
      broken.connected = false;
      throw new Error("connection lost");
    });
    const alsoBroken = new FakeBrowser(async () => {
      throw new Error("still broken");
    });
    const client = new FakeClient({ sessions: ["s1", "s2"], browsers: [broken, alsoBroken] });
    const session = new ReusableBrowserSession({ binding: {}, client });

    await expect(session.openContext()).rejects.toThrow("still broken");
    expect(client.connects).toEqual(["s1", "s2"]);
  });

  it("closes a context that resolves after its timeout", async () => {
    const late = new FakeContext();
    const browser = new FakeBrowser(
      () => new Promise<ReusableContext>((resolve) => setTimeout(() => resolve(late), 40)),
    );
    const client = new FakeClient({ browsers: [browser] });
    const session = new ReusableBrowserSession({
      binding: {},
      client,
      callTimeoutMs: 10,
      closeTimeoutMs: 50,
    });

    await expect(session.openContext()).rejects.toThrow("browser context timed out");
    await sleep(80);
    expect(late.closes).toBe(1);
  });

  it("disconnects a connection that resolves after its timeout", async () => {
    const browser = new FakeBrowser();
    const client = new FakeClient({
      browsers: [() => new Promise<ReusableBrowser>((resolve) => setTimeout(() => resolve(browser), 40))],
    });
    const session = new ReusableBrowserSession({
      binding: {},
      client,
      callTimeoutMs: 10,
      closeTimeoutMs: 50,
    });

    await expect(session.openContext()).rejects.toThrow("browser connect timed out");
    await sleep(80);
    expect(browser.disconnects).toBe(1);
  });

  it("propagates acquisition and connect failures", async () => {
    const noAcquire = new ReusableBrowserSession({
      binding: {},
      client: {
        acquire: async () => {
          throw new Error("backend down");
        },
        connect: async () => {
          throw new Error("unused");
        },
      },
    });
    await expect(noAcquire.openContext()).rejects.toThrow("backend down");

    const noConnect = new FakeClient({ browsers: [() => Promise.reject(new Error("connect failed"))] });
    const session = new ReusableBrowserSession({ binding: {}, client: noConnect });
    await expect(session.openContext()).rejects.toThrow("connect failed");
  });

  it("does not let a stale failure discard the replacement connection", async () => {
    const first = new FakeBrowser(async () => {
      first.connected = false;
      throw new Error("connection lost");
    });
    const second = new FakeBrowser();
    const client = new FakeClient({ sessions: ["s1", "s2"], browsers: [first, second] });
    const session = new ReusableBrowserSession({ binding: {}, client });

    // The first openContext fails on `first` and recovers on `second`.
    const recovered = await session.openContext();
    expect(recovered).toBeInstanceOf(FakeContext);
    const reused = await session.openContext();
    expect(reused).not.toBe(recovered);

    expect(client.connects).toEqual(["s1", "s2"]);
    expect(second.contexts).toHaveLength(2);
    // The stale failure never invalidated the healthy replacement.
    expect(second.disconnects).toBe(0);
  });
});

describe("serializeExpression", () => {
  it("turns a self-contained function into an invocation expression", () => {
    const expression = serializeExpression(() => 41 + 1);
    expect(expression.endsWith(")()")).toBe(true);
    expect(new Function(`return ${expression}`)()).toBe(42);
  });
});
