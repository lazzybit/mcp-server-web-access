import { describe, expect, it } from "vitest";
import {
  buildPageForm,
  initialFields,
  requestPage,
} from "../../src/ddg/request";
import { ManualClock } from "./manual-clock";

describe("initialFields", () => {
  it("starts with q/b/kl", () => {
    expect(initialFields({ query: "hello", effort: "low", region: "us-en" })).toEqual([
      ["q", "hello"],
      ["b", ""],
      ["kl", "us-en"],
    ]);
  });
});

describe("buildPageForm", () => {
  it("replays hidden fields and overrides kl/l/df", () => {
    const form = buildPageForm(
      [
        ["q", "x"],
        ["s", "25"],
        ["kl", "wt-wt"],
        ["l", "uk-en"],
        ["df", "y"],
        ["vqd", "1"],
      ],
      { query: "x", effort: "low", region: "uk-en", freshness: "month" },
    );
    expect(form.get("q")).toBe("x");
    expect(form.get("s")).toBe("25");
    expect(form.get("vqd")).toBe("1");
    expect(form.get("kl")).toBe("uk-en");
    expect(form.get("df")).toBe("m");
    expect(form.has("l")).toBe(false);
    expect(form.getAll("kl")).toEqual(["uk-en"]);
  });

  it("omits df when no freshness is requested", () => {
    const form = buildPageForm([["q", "x"]], {
      query: "x",
      effort: "low",
      region: "us-en",
    });
    expect(form.has("df")).toBe(false);
  });
});

describe("requestPage", () => {
  it("returns status and bytes on success", async () => {
    const response = await requestPage({
      endpoint: "https://example.com/html/",
      form: new URLSearchParams("q=x"),
      deadlineMs: 1_000,
      fetchImpl: async () => new Response("hello", { status: 200 }),
    });
    expect(response.kind).toBe("http");
    if (response.kind !== "http") return;
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.bytes)).toBe("hello");
  });

  it("does not call fetch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const response = await requestPage({
      endpoint: "https://example.com/html/",
      form: new URLSearchParams(),
      deadlineMs: 1_000,
      signal: controller.signal,
      fetchImpl: async () => {
        called = true;
        return new Response("");
      },
    });
    expect(response).toEqual({
      kind: "failure",
      code: "ABORTED",
      message: expect.any(String),
    });
    expect(called).toBe(false);
  });

  it("caps the response body", async () => {
    const response = await requestPage({
      endpoint: "https://example.com/html/",
      form: new URLSearchParams(),
      deadlineMs: 1_000,
      maxBodyBytes: 8,
      fetchImpl: async () => new Response("0123456789"),
    });
    expect(response.kind).toBe("failure");
    if (response.kind !== "failure") return;
    expect(response.code).toBe("TOO_LARGE");
  });

  it("reports a TIMEOUT when the attempt timeout elapses", async () => {
    const clock = new ManualClock();
    const promise = requestPage({
      endpoint: "https://example.com/html/",
      form: new URLSearchParams(),
      deadlineMs: 20,
      schedule: (fn, ms) => clock.schedule(fn, ms),
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    await clock.advance(20);
    const response = await promise;
    expect(response.kind).toBe("failure");
    if (response.kind !== "failure") return;
    expect(response.code).toBe("TIMEOUT");
  });

  it("returns TIMEOUT when fetch ignores the abort", async () => {
    const clock = new ManualClock();
    const promise = requestPage({
      endpoint: "https://example.com/html/",
      form: new URLSearchParams(),
      deadlineMs: 20,
      schedule: (fn, ms) => clock.schedule(fn, ms),
      // Never settles and ignores the abort signal.
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    await clock.advance(20);
    const response = await promise;
    expect(response.kind).toBe("failure");
    if (response.kind !== "failure") return;
    expect(response.code).toBe("TIMEOUT");
  });

  it("returns TIMEOUT when the body read hangs", async () => {
    const clock = new ManualClock();
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueues or closes.
      },
    });
    const promise = requestPage({
      endpoint: "https://example.com/html/",
      form: new URLSearchParams(),
      deadlineMs: 20,
      schedule: (fn, ms) => clock.schedule(fn, ms),
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    await clock.advance(20);
    const response = await promise;
    expect(response.kind).toBe("failure");
    if (response.kind !== "failure") return;
    expect(response.code).toBe("TIMEOUT");
  });
});
