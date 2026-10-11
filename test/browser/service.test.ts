import { env, evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_SESSION_KEY, BrowserService } from "../../src/browser/service";
import type { BrowserSessionClient } from "../../src/browser/service";
import { BROWSER_KEEP_ALIVE_MS } from "../../src/page/constants";

interface ClientStats {
  acquires: number;
  sessionCalls: number;
  lastKeepAlive: number | null;
}

interface ClientBehaviour {
  acquire?: () => Promise<{ sessionId: string }>;
  sessions?: () => Promise<Array<{ sessionId: string }>>;
}

function makeClient(stats: ClientStats, behaviour: ClientBehaviour = {}): BrowserSessionClient {
  return {
    async acquire(_binding, options) {
      stats.acquires += 1;
      stats.lastKeepAlive = options.keep_alive;
      return behaviour.acquire !== undefined ? behaviour.acquire() : { sessionId: "acquired" };
    },
    async sessions() {
      stats.sessionCalls += 1;
      return behaviour.sessions !== undefined ? behaviour.sessions() : [];
    },
  };
}

function stats(): ClientStats {
  return { acquires: 0, sessionCalls: 0, lastKeepAlive: null };
}

let objectCounter = 0;
function freshName(): string {
  objectCounter += 1;
  return `broker-${objectCounter}`;
}

/** Writes storage before the instance is constructed, then evicts it. */
async function seed(name: string, sessionId: string): Promise<void> {
  const stub = env.BROWSER_SERVICE.getByName(name);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(BROWSER_SESSION_KEY, sessionId);
  });
  await evictAllDurableObjects();
}

describe("BrowserService", () => {
  afterEach(async () => {
    await evictAllDurableObjects();
  });

  it("performs one acquire for concurrent getSession calls", async () => {
    const stub = env.BROWSER_SERVICE.getByName(freshName());
    const clientStats = stats();
    const outcome = await runInDurableObject(stub, async (instance: BrowserService) => {
      let release: (value: { sessionId: string }) => void = () => {};
      const gate = new Promise<{ sessionId: string }>((resolve) => {
        release = resolve;
      });
      instance.setTestDeps({
        client: makeClient(clientStats, { acquire: () => gate, sessions: async () => [] }),
      });

      const first = instance.getSession();
      const second = instance.getSession();
      release({ sessionId: "acquired" });
      const [a, b] = await Promise.all([first, second]);
      return { a, b };
    });

    expect(outcome.a).toEqual({ ok: true, sessionId: "acquired" });
    expect(outcome.b).toEqual({ ok: true, sessionId: "acquired" });
    expect(clientStats.acquires).toBe(1);
    expect(clientStats.lastKeepAlive).toBe(BROWSER_KEEP_ALIVE_MS);
  });

  it("reuses a stored session that sessions() confirms alive", async () => {
    const name = freshName();
    await seed(name, "stored-1");
    const stub = env.BROWSER_SERVICE.getByName(name);
    const clientStats = stats();

    const result = await runInDurableObject(stub, async (instance: BrowserService) => {
      instance.setTestDeps({
        client: makeClient(clientStats, {
          sessions: async () => [{ sessionId: "stored-1" }],
        }),
      });
      return instance.getSession();
    });

    expect(result).toEqual({ ok: true, sessionId: "stored-1" });
    expect(clientStats.acquires).toBe(0);
    expect(clientStats.sessionCalls).toBe(1);
  });

  it("acquires and persists a replacement when sessions() confirms absence", async () => {
    const name = freshName();
    await seed(name, "stale");
    const stub = env.BROWSER_SERVICE.getByName(name);
    const clientStats = stats();

    const outcome = await runInDurableObject(stub, async (instance: BrowserService, state) => {
      instance.setTestDeps({
        client: makeClient(clientStats, {
          sessions: async () => [],
          acquire: async () => ({ sessionId: "fresh" }),
        }),
      });
      const result = await instance.getSession();
      const stored = await state.storage.get<string>(BROWSER_SESSION_KEY);
      return { result, stored };
    });

    expect(outcome.result).toEqual({ ok: true, sessionId: "fresh" });
    expect(outcome.stored).toBe("fresh");
    expect(clientStats.acquires).toBe(1);
  });

  it("returns the stored id without acquiring when the caller's id was replaced", async () => {
    const name = freshName();
    await seed(name, "current");
    const stub = env.BROWSER_SERVICE.getByName(name);
    const clientStats = stats();

    const result = await runInDurableObject(stub, async (instance: BrowserService) => {
      instance.setTestDeps({
        client: makeClient(clientStats, { sessions: async () => [{ sessionId: "current" }] }),
      });
      return instance.getSession("old");
    });

    expect(result).toEqual({ ok: true, sessionId: "current" });
    expect(clientStats.acquires).toBe(0);
    expect(clientStats.sessionCalls).toBe(0);
  });

  it("treats a failing sessions() call as possibly alive", async () => {
    const name = freshName();
    await seed(name, "stored-2");
    const stub = env.BROWSER_SERVICE.getByName(name);
    const clientStats = stats();

    const result = await runInDurableObject(stub, async (instance: BrowserService) => {
      instance.setTestDeps({
        client: makeClient(clientStats, {
          sessions: async () => {
            throw new Error("sessions unavailable");
          },
        }),
      });
      return instance.getSession();
    });

    expect(result).toEqual({ ok: true, sessionId: "stored-2" });
    expect(clientStats.acquires).toBe(0);
  });

  it("returns a structured failure when acquire throws", async () => {
    const stub = env.BROWSER_SERVICE.getByName(freshName());
    const clientStats = stats();

    const result = await runInDurableObject(stub, async (instance: BrowserService) => {
      instance.setTestDeps({
        client: makeClient(clientStats, {
          sessions: async () => [],
          acquire: async () => {
            throw new Error("backend down");
          },
        }),
      });
      return instance.getSession();
    });

    expect(result).toEqual({ ok: false, message: "backend down" });
    expect(clientStats.acquires).toBe(1);
  });
});
