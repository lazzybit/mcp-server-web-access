/**
 * One absolute deadline plus per-stage cancellable time windows.
 *
 * The whole `fetch_page` call shares a single {@link Deadline}. Every stage
 * derives its `AbortSignal` from the remaining time so that chained stage
 * timeouts can never exceed the total.
 */
export class Deadline {
  readonly startedAt: number;
  readonly deadlineAt: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(totalMs: number, now: number = Date.now()) {
    this.startedAt = now;
    this.deadlineAt = now + totalMs;
    // Abort the shared signal when the total budget elapses.
    this.timer = setTimeout(() => this.controller.abort(), Math.max(0, totalMs));
    // Workers keep no long-lived event loop handle; clearing is best-effort.
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  /** Cancels the pending deadline timer once the run has finished. */
  dispose(): void {
    clearTimeout(this.timer);
  }

  /** Milliseconds left before the total deadline (never negative). */
  remaining(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** Signal aborted when the whole run exceeds the total deadline. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

export interface StageWindow {
  signal: AbortSignal;
  /** True when this window (not the global deadline) expired. */
  timedOut(): boolean;
  /** Releases the timer and listener. */
  dispose(): void;
}

/**
 * A stage window bounded by `min(maxMs, deadline remaining)`.
 *
 * A zero/negative window aborts immediately without scheduling a timer.
 */
export function stageWindow(deadline: Deadline, maxMs: number): StageWindow {
  const controller = new AbortController();
  let timedOut = false;

  const onGlobalAbort = (): void => controller.abort();
  if (deadline.signal.aborted) {
    controller.abort();
  } else {
    deadline.signal.addEventListener("abort", onGlobalAbort, { once: true });
  }

  const budget = Math.min(maxMs, deadline.remaining());
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (budget <= 0) {
    if (!deadline.signal.aborted) timedOut = true;
    controller.abort();
  } else {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budget);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      deadline.signal.removeEventListener("abort", onGlobalAbort);
    },
  };
}

/** Resolves after `ms`, or `null` if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
