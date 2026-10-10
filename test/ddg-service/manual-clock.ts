import type { CancelTimer, Clock } from "../../src/ddg/engine";

interface Sleeper {
  at: number;
  resolve: () => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface Timer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

/** Deterministic clock: `sleep`/`schedule` only advance via `advance*`. */
export class ManualClock implements Clock {
  #now: number;
  #sleepers: Sleeper[] = [];
  #timers: Timer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const sleeper: Sleeper = {
        at: this.#now + Math.max(0, ms),
        resolve,
        signal,
        onAbort: undefined,
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#sleepers.indexOf(sleeper);
          if (index >= 0) this.#sleepers.splice(index, 1);
          resolve();
        };
        sleeper.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#sleepers.push(sleeper);
    });
  }

  schedule(fn: () => void, ms: number): CancelTimer {
    const timer: Timer = { at: this.#now + Math.max(0, ms), fn, cancelled: false };
    this.#timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Earliest pending sleeper/timer, or null when idle. */
  nextAt(): number | null {
    const times: number[] = [];
    for (const sleeper of this.#sleepers) times.push(sleeper.at);
    for (const timer of this.#timers) if (!timer.cancelled) times.push(timer.at);
    if (times.length === 0) return null;
    return Math.min(...times);
  }

  async advanceTo(at: number): Promise<void> {
    if (at > this.#now) this.#now = at;
    await this.#processDue();
  }

  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.#now + ms);
  }

  async #processDue(): Promise<void> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const dueSleeper = this.#sleepers
        .filter((sleeper) => sleeper.at <= this.#now)
        .sort((a, b) => a.at - b.at)[0];
      const dueTimer = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= this.#now)
        .sort((a, b) => a.at - b.at)[0];
      if (dueSleeper === undefined && dueTimer === undefined) return;

      if (dueTimer !== undefined && (dueSleeper === undefined || dueTimer.at <= dueSleeper.at)) {
        dueTimer.cancelled = true;
        dueTimer.fn();
      } else if (dueSleeper !== undefined) {
        const index = this.#sleepers.indexOf(dueSleeper);
        if (index >= 0) this.#sleepers.splice(index, 1);
        if (dueSleeper.onAbort !== undefined && dueSleeper.signal !== undefined) {
          dueSleeper.signal.removeEventListener("abort", dueSleeper.onAbort);
        }
        dueSleeper.resolve();
      }
      await flushMicrotasks();
    }
  }
}

export async function flushMicrotasks(rounds = 6): Promise<void> {
  // Yield to macrotasks; time only advances via the ManualClock.
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Drives the clock forward to the next scheduled event until `promise` settles. */
export async function drive<T>(
  clock: ManualClock,
  promise: Promise<T>,
  maxSteps = 200,
): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  tracked.catch(() => {});
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await flushMicrotasks();
    const next = clock.nextAt();
    if (next !== null) await clock.advanceTo(next);
    await flushMicrotasks();
  }
  return tracked;
}
