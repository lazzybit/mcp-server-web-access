import { describe, expect, it } from "vitest";
import { createSessionLauncher } from "../../src/browser/session";
import type {
  BrowserSessionBroker,
  ConnectedSessionBrowser,
  SessionConnect,
  SessionContextLike,
  SessionPage,
  SessionResult,
} from "../../src/browser/session";

function page(): SessionPage {
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
    async evaluate<T>(): Promise<T> {
      throw new Error("unused");
    },
  } as unknown as SessionPage;
}

/** Records calls and replays a scripted sequence of broker results. */
class FakeBroker implements BrowserSessionBroker {
  readonly calls: Array<string | undefined> = [];
  #results: SessionResult[];

  constructor(...results: SessionResult[]) {
    this.#results = results;
  }

  async getSession(previousSessionId?: string): Promise<SessionResult> {
    this.calls.push(previousSessionId);
    return this.#results.shift() ?? { ok: false, message: "no scripted result" };
  }
}

interface BrowserSpy extends ConnectedSessionBrowser {
  closes: number;
  disconnects: number;
}

function browserSpy(context: SessionContextLike | (() => Promise<SessionContextLike>)): BrowserSpy {
  const spy: BrowserSpy = {
    closes: 0,
    disconnects: 0,
    async createBrowserContext() {
      return typeof context === "function" ? context() : context;
    },
    async disconnect() {
      spy.disconnects += 1;
    },
    async close() {
      spy.closes += 1;
    },
  } as BrowserSpy;
  return spy;
}

function contextSpy(): { context: SessionContextLike; closes: () => number } {
  let closes = 0;
  const context: SessionContextLike = {
    async newPage() {
      return page();
    },
    async close() {
      closes += 1;
    },
  };
  return { context, closes: () => closes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createSessionLauncher", () => {
  it("closes the operation's context and disconnects, never the shared browser", async () => {
    const broker = new FakeBroker({ ok: true, sessionId: "s1" });
    const { context, closes } = contextSpy();
    const browser = browserSpy(context);
    const launcher = createSessionLauncher({
      broker,
      binding: {},
      connect: async () => browser,
    });

    const operation = await launcher({});
    const created = await operation.newPage();
    expect(created).toBeDefined();
    await operation.close();

    expect(closes()).toBe(1);
    expect(browser.disconnects).toBe(1);
    expect(browser.closes).toBe(0);
  });

  it("refreshes a stale session once and reconnects to the replacement", async () => {
    const broker = new FakeBroker(
      { ok: true, sessionId: "s1" },
      { ok: true, sessionId: "s2" },
    );
    const { context } = contextSpy();
    const browser = browserSpy(context);
    const attempts: string[] = [];
    const connect: SessionConnect = async (_binding, sessionId) => {
      attempts.push(sessionId);
      if (sessionId === "s1") throw new Error("stale session");
      return browser;
    };

    const launcher = createSessionLauncher({ broker, binding: {}, connect });
    const operation = await launcher({});
    await operation.close();

    expect(attempts).toEqual(["s1", "s2"]);
    expect(broker.calls).toEqual([undefined, "s1"]);
    expect(browser.disconnects).toBe(1);
  });

  it("rethrows when the refreshed session is the same id", async () => {
    const broker = new FakeBroker(
      { ok: true, sessionId: "s1" },
      { ok: true, sessionId: "s1" },
    );
    const attempts: string[] = [];
    const connect: SessionConnect = async (_binding, sessionId) => {
      attempts.push(sessionId);
      throw new Error("stale session");
    };

    const launcher = createSessionLauncher({ broker, binding: {}, connect });
    await expect(launcher({})).rejects.toThrow("stale session");

    expect(attempts).toEqual(["s1"]);
    expect(broker.calls).toEqual([undefined, "s1"]);
  });

  it("throws when the refreshed connect fails too", async () => {
    const broker = new FakeBroker(
      { ok: true, sessionId: "s1" },
      { ok: true, sessionId: "s2" },
    );
    const attempts: string[] = [];
    const connect: SessionConnect = async (_binding, sessionId) => {
      attempts.push(sessionId);
      throw new Error(`connect ${sessionId} failed`);
    };

    const launcher = createSessionLauncher({ broker, binding: {}, connect });
    await expect(launcher({})).rejects.toThrow("connect s2 failed");
    expect(attempts).toEqual(["s1", "s2"]);
  });

  it("throws when the broker reports failure", async () => {
    const broker = new FakeBroker({ ok: false, message: "no browser available" });
    const launcher = createSessionLauncher({
      broker,
      binding: {},
      connect: async () => browserSpy(contextSpy().context),
    });

    await expect(launcher({})).rejects.toThrow("no browser available");
  });

  it("disconnects a connection that resolves after its timeout", async () => {
    const broker = new FakeBroker(
      { ok: true, sessionId: "s1" },
      { ok: true, sessionId: "s1" },
    );
    const browser = browserSpy(contextSpy().context);
    const connect: SessionConnect = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(browser), 40);
      });

    const launcher = createSessionLauncher({
      broker,
      binding: {},
      connect,
      callTimeoutMs: 10,
      closeTimeoutMs: 50,
    });
    await expect(launcher({})).rejects.toThrow();

    await sleep(80);
    expect(browser.disconnects).toBe(1);
    expect(browser.closes).toBe(0);
  });

  it("closes a context that resolves after its timeout and disconnects", async () => {
    const broker = new FakeBroker({ ok: true, sessionId: "s1" });
    const { context, closes } = contextSpy();
    const browser = browserSpy(() => new Promise((resolve) => setTimeout(() => resolve(context), 40)));

    const launcher = createSessionLauncher({
      broker,
      binding: {},
      connect: async () => browser,
      callTimeoutMs: 10,
      closeTimeoutMs: 50,
    });
    await expect(launcher({})).rejects.toThrow("browser context timed out");

    await sleep(80);
    expect(closes()).toBe(1);
    expect(browser.disconnects).toBe(1);
  });
});
