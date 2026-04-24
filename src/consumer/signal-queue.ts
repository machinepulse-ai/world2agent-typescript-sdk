import type { W2ASignal } from "../types.js";

export interface SignalQueueOptions {
  /** Determine if a signal should bypass the queue and be handled immediately. */
  immediate?: (signal: W2ASignal) => boolean;

  /** Batch configuration for non-immediate signals. */
  batch: {
    maxSize: number;
    maxWaitMs: number;
    onFlush: (signals: W2ASignal[]) => void | Promise<void>;
  };

  /** Handler for immediate signals. Required if `immediate` is set. */
  onImmediate?: (signal: W2ASignal) => void | Promise<void>;
}

export interface SignalQueue {
  /** Push a signal into the queue. */
  push(signal: W2ASignal): Promise<void>;
  /** Flush any pending batched signals immediately. */
  flush(): Promise<void>;
  /** Stop the queue and flush remaining signals. */
  stop(): Promise<void>;
}

/**
 * Create an async signal queue with urgency bypass and batching.
 *
 * - Signals matching `immediate()` are handled right away
 * - Other signals are batched and flushed when `maxSize` or `maxWaitMs` is reached
 * - Critical/high urgency signals typically bypass batching
 */
export function createSignalQueue(options: SignalQueueOptions): SignalQueue {
  const { immediate, batch, onImmediate } = options;
  const buffer: W2ASignal[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const signals = buffer.splice(0);
    await batch.onFlush(signals);
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, batch.maxWaitMs);
  }

  return {
    async push(signal) {
      if (immediate?.(signal) && onImmediate) {
        await onImmediate(signal);
        return;
      }

      buffer.push(signal);
      if (buffer.length >= batch.maxSize) {
        await flush();
      } else {
        scheduleFlush();
      }
    },

    flush,

    async stop() {
      await flush();
    },
  };
}
