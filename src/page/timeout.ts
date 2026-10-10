/**
 * Per-operation timeouts for the `fetch_page` pipeline.
 *
 * There is no whole-call deadline. Every potentially hanging operation gets its
 * own bounded window or race, so termination comes from bounded counts plus
 * these timeouts. {@link withTimeout} guarantees settlement even when the
 * underlying call (for example a browser RPC) ignores abort signals.
 */

/** A race-based timeout error, independent of whether abort propagates. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface OperationWindow {
  /** Aborted when the window elapses. */
  signal: AbortSignal;
  /** True when this window's timer fired. */
  timedOut(): boolean;
  /** Milliseconds left in the window (never negative). */
  remaining(): number;
  /** Releases the timer. */
  dispose(): void;
}

/**
 * A standalone time window owning an {@link AbortSignal}.
 *
 * A zero/negative window aborts immediately without scheduling a timer.
 */
export function operationWindow(ms: number): OperationWindow {
  const controller = new AbortController();
  const expiresAt = Date.now() + Math.max(0, ms);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (ms <= 0) {
    timedOut = true;
    controller.abort();
  } else {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    remaining: () => Math.max(0, expiresAt - Date.now()),
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * Rejects with {@link TimeoutError} after `ms` unless `promise` settles first.
 * The losing promise is always observed, so no unhandled rejection escapes.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0) {
    promise.catch(() => undefined);
    return Promise.reject(new TimeoutError(message));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new TimeoutError(message));
      }
    }, ms);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

/** Resolves after `ms`, or immediately if `signal` is/aborts. */
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
