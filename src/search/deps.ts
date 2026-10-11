/**
 * Shared, injectable building blocks for the search subsystem.
 *
 * Kept free of `cloudflare:workers` so providers and the coordinator also run
 * under plain Node in tests.
 */
import type { ParsedPage } from "../ddg/parse";

/** Cancellable timer. */
export interface CancelTimer {
  cancel(): void;
}

export interface Clock {
  now(): number;
  /** Sleeps up to `ms`; resolves early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  schedule(fn: () => void, ms: number): CancelTimer;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  schedule(fn: () => void, ms: number): CancelTimer {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  }
}

/**
 * Clock view that always forwards to the current source.
 *
 * The Durable Object owns one {@link Clock} for every provider and the
 * coordinator, so a test seam can swap it once and have all of them observe
 * the replacement.
 */
export class SharedClock implements Clock {
  readonly #source: () => Clock;

  constructor(source: () => Clock) {
    this.#source = source;
  }

  now(): number {
    return this.#source().now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.#source().sleep(ms, signal);
  }

  schedule(fn: () => void, ms: number): CancelTimer {
    return this.#source().schedule(fn, ms);
  }
}

/** Parser injection point. */
export type ParseFn = (
  body: Uint8Array | ReadableStream<Uint8Array>,
  status: number,
  base: string,
) => Promise<ParsedPage>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Persistence port supplied by the Durable Object. */
export interface StoragePort {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
