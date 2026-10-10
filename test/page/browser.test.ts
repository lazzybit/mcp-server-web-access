import { describe, expect, it } from "vitest";
import { renderPage } from "../../src/page/browser";
import type { BrowserLauncher, PageLike, RequestLike } from "../../src/page/browser";
import { Deadline } from "../../src/page/deadline";

function page(overrides: Partial<PageLike>): PageLike {
  return {
    async goto() {},
    async content() {
      return "<html>ok</html>";
    },
    url() {
      return "https://example.com/final";
    },
    async setRequestInterception() {},
    on() {},
    ...overrides,
  };
}

function browser(pageLike: PageLike, closed: { value: boolean }): BrowserLauncher {
  return async () => ({
    async newPage() {
      return pageLike;
    },
    async close() {
      closed.value = true;
    },
  });
}

describe("renderPage", () => {
  it("returns the rendered HTML and closes the browser", async () => {
    const closed = { value: false };
    const outcome = await renderPage({
      binding: {},
      url: "https://example.com/",
      deadline: new Deadline(5_000),
      launch: browser(page({}), closed),
    });
    expect(outcome).toEqual({ html: "<html>ok</html>", finalUrl: "https://example.com/final" });
    expect(closed.value).toBe(true);
  });

  it("closes the browser when navigation fails", async () => {
    const closed = { value: false };
    const failing = page({
      async goto() {
        throw new Error("navigation failed");
      },
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        deadline: new Deadline(5_000),
        launch: browser(failing, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });
    expect(closed.value).toBe(true);
  });

  it("rejects oversized rendered HTML and still closes", async () => {
    const closed = { value: false };
    const oversized = page({
      async content() {
        return "a".repeat(2 * 1024 * 1024 + 1);
      },
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        deadline: new Deadline(5_000),
        launch: browser(oversized, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "TOO_LARGE" } });
    expect(closed.value).toBe(true);
  });

  it("rejects a final URL outside the policy", async () => {
    const closed = { value: false };
    const redirected = page({
      url() {
        return "http://127.0.0.1/";
      },
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        deadline: new Deadline(5_000),
        launch: browser(redirected, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "BLOCKED_URL" } });
  });

  it("aborts a disallowed navigation request", async () => {
    let aborted = false;
    let handler: ((request: RequestLike) => void) | null = null;
    const intercepted = page({
      async goto() {
        handler?.({
          isNavigationRequest: () => true,
          url: () => "http://127.0.0.1/",
          redirectChain: () => [],
          continue: async () => {
            throw new Error("should not continue");
          },
          abort: async () => {
            aborted = true;
          },
        });
        throw new Error("navigation aborted");
      },
      on(_event, callback) {
        handler = callback;
      },
    });
    const closed = { value: false };
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        deadline: new Deadline(5_000),
        launch: browser(intercepted, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });
    expect(aborted).toBe(true);
  });

  it("closes a session that resolves after the launch deadline", async () => {
    const closed = { value: false };
    const slow: BrowserLauncher = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            async newPage(): Promise<PageLike> {
              throw new Error("unused");
            },
            async close() {
              closed.value = true;
            },
          });
        }, 60);
      });

    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        deadline: new Deadline(15),
        launch: slow,
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(closed.value).toBe(true);
  });
});
