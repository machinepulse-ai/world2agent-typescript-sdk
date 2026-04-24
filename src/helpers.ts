import type { CleanupFn, Logger, SensorStore } from "./types.js";
import { MemorySensorStore } from "./stores/memory.js";

export interface PollLoopOptions<T> {
  /** Items to poll for. Each item gets its own interval. */
  items: T[];
  /** Polling interval in seconds. */
  intervalSeconds: number;
  /** The poll function called for each item on every tick. */
  poll: (item: T) => Promise<void>;
  /** Optional logger for error reporting. */
  logger?: Logger;
}

/**
 * Create a poll loop that runs `poll()` for each item on a fixed interval.
 *
 * - Runs an initial poll immediately for each item
 * - Sets up setInterval for recurring polls
 * - Returns a cleanup function that clears all timers
 *
 * ```ts
 * const { cleanup } = createPollLoop({
 *   items: config.urls,
 *   intervalSeconds: config.interval_seconds,
 *   poll: async (url) => { ... },
 *   logger: ctx.logger,
 * });
 * ```
 */
/**
 * Return `ctx.store` when the runner supplied one, otherwise a fresh
 * in-memory store private to this sensor process. Use this at the top of
 * `start()` so sensor code can read/write state unconditionally instead
 * of littering it with `ctx.store?.` checks.
 *
 * Call once and reuse the result — calling twice returns different
 * instances when no store was injected.
 *
 * ```ts
 * async start(ctx) {
 *   const store = ensureStore(ctx);
 *   if (await store.get("seen:" + id)) return;
 *   await store.set("seen:" + id, "1");
 * }
 * ```
 *
 * When the runner injects a store, it's already scoped with the sensor's
 * id prefix, so keys don't collide across sensors sharing one backend.
 * The fallback is un-scoped because the sensor fully owns it.
 */
export function ensureStore(ctx: { store?: SensorStore }): SensorStore {
  return ctx.store ?? new MemorySensorStore();
}

export function createPollLoop<T>(opts: PollLoopOptions<T>): { cleanup: CleanupFn } {
  const { items, intervalSeconds, poll, logger } = opts;
  const timers: ReturnType<typeof setInterval>[] = [];

  for (const item of items) {
    // Run once immediately (fire-and-forget)
    poll(item).catch((err) => {
      logger?.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Schedule recurring polls
    const timer = setInterval(() => {
      poll(item).catch((err) => {
        logger?.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalSeconds * 1000);

    timers.push(timer);
  }

  return {
    cleanup: async () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
    },
  };
}
