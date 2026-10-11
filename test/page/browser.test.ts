import { describe, expect, it } from "vitest";
import { decideNavigation, renderPage } from "../../src/page/browser";
import type { CapabilityLauncher } from "../../src/browser/launcher";
import type { PageCapability } from "../../src/browser/launcher";

function page(overrides: Partial<PageCapability> = {}): PageCapability {
  const base: PageCapability = {
    async goto() {},
    async content() {
      return "<html>ok</html>";
    },
    async url() {
      return "https://example.com/final";
    },
    async evaluate(): Promise<unknown> {
      return undefined;
    },
  };
  return Object.assign(base, overrides);
}

function browser(pageLike: PageCapability, closed: { value: boolean }): CapabilityLauncher {
  return async () => ({
    async newPage() {
      return pageLike;
    },
    async close() {
      closed.value = true;
    },
  });
}

describe("decideNavigation", () => {
  it("allows an allowed chain within the redirect budget", () => {
    expect(decideNavigation({ url: "https://example.com/", redirectChain: [] }, 5)).toBe("allow");
    expect(
      decideNavigation(
        { url: "https://example.com/", redirectChain: ["https://a.example/", "https://b.example/"] },
        5,
      ),
    ).toBe("allow");
  });

  it("aborts a disallowed hop and an over-long chain", () => {
    expect(decideNavigation({ url: "http://127.0.0.1/", redirectChain: [] }, 5)).toBe("abort");
    expect(
      decideNavigation(
        { url: "https://d.example/", redirectChain: ["https://a.example/", "https://b.example/"] },
        1,
      ),
    ).toBe("abort");
  });
});

describe("renderPage", () => {
  it("returns the rendered HTML and closes the browser", async () => {
    const closed = { value: false };
    const outcome = await renderPage({
      binding: {},
      url: "https://example.com/",
      launch: browser(page(), closed),
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
        launch: browser(oversized, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "TOO_LARGE" } });
    expect(closed.value).toBe(true);
  });

  it("rejects a final URL outside the policy", async () => {
    const closed = { value: false };
    const redirected = page({
      async url() {
        return "http://127.0.0.1/";
      },
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        launch: browser(redirected, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "BLOCKED_URL" } });
  });

  it("applies the navigation policy across the whole operation lifetime", async () => {
    const closed = { value: false };
    let aborted = false;
    const intercepted = page({
      async goto(_url, options) {
        const policy = options?.policy;
        if (policy === undefined) throw new Error("expected a navigation policy");
        const decision = await policy.decide({
          url: "http://127.0.0.1/",
          redirectChain: [],
        });
        if (decision === "allow") throw new Error("should not allow the request");
        aborted = true;
        throw new Error("navigation aborted");
      },
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        launch: browser(intercepted, closed),
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });
    expect(aborted).toBe(true);
    expect(closed.value).toBe(true);
  });

  it("closes a session that resolves after the launch timeout", async () => {
    const closed = { value: false };
    const slow: CapabilityLauncher = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            async newPage(): Promise<PageCapability> {
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
        launchTimeoutMs: 15,
        launch: slow,
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(closed.value).toBe(true);
  });

  it("times out a hanging newPage and still closes", async () => {
    const closed = { value: false };
    const hanging: CapabilityLauncher = async () => ({
      newPage: () => new Promise<PageCapability>(() => {}),
      async close() {
        closed.value = true;
      },
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        launch: hanging,
        callTimeoutMs: 30,
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });
    expect(closed.value).toBe(true);
  });

  it("times out a hanging content call", async () => {
    const closed = { value: false };
    const hangingContent = page({
      content: () => new Promise<string>(() => {}),
    });
    await expect(
      renderPage({
        binding: {},
        url: "https://example.com/",
        launch: browser(hangingContent, closed),
        callTimeoutMs: 30,
      }),
    ).rejects.toMatchObject({ pageError: { code: "RENDER_FAILED" } });
    expect(closed.value).toBe(true);
  });

  it("gives up on a hanging close without blocking the result", async () => {
    let closed = false;
    const hangingClose: CapabilityLauncher = async () => ({
      async newPage() {
        return page();
      },
      close: () =>
        new Promise<void>(() => {
          // Never resolves; the bounded close must give up.
          closed = true;
        }),
    });
    const outcome = await renderPage({
      binding: {},
      url: "https://example.com/",
      launch: hangingClose,
      closeTimeoutMs: 30,
    });
    expect(outcome.html).toBe("<html>ok</html>");
    expect(closed).toBe(true);
  });
});
