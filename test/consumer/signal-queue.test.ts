import { afterEach, describe, expect, it, vi } from "vitest";
import type { W2ASignal } from "../../src/types.js";
import { createSignalQueue } from "../../src/consumer/signal-queue.js";

afterEach(() => vi.useRealTimers());

function signal(id: string = "11111111-2222-4333-8444-555555555555"): W2ASignal {
  return {
    signal_id: id,
    schema_version: "w2a/0.1",
    emitted_at: 1,
    source: { sensor_id: "x", sensor_version: "1", source_type: "x", user_identity: "u", package: "x" },
    event: {
      type: "a.b.c",
      occurred_at: 1,
      summary: "A long enough summary that passes W2A validation checks",
    },
  };
}

describe("createSignalQueue", () => {
  it("flushes when maxSize is reached", async () => {
    const flushes: W2ASignal[][] = [];
    const q = createSignalQueue({
      batch: { maxSize: 2, maxWaitMs: 10_000, onFlush: async (s) => { flushes.push(s); } },
    });
    await q.push(signal("11111111-1111-4111-8111-111111111111"));
    expect(flushes.length).toBe(0);
    await q.push(signal("22222222-2222-4222-8222-222222222222"));
    expect(flushes.length).toBe(1);
    expect(flushes[0]?.length).toBe(2);
  });

  it("flushes after maxWaitMs when under maxSize", async () => {
    vi.useFakeTimers();
    const flushes: W2ASignal[][] = [];
    const q = createSignalQueue({
      batch: { maxSize: 100, maxWaitMs: 500, onFlush: async (s) => { flushes.push(s); } },
    });
    await q.push(signal());
    expect(flushes.length).toBe(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(flushes.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushes.length).toBe(1);
    expect(flushes[0]?.length).toBe(1);
  });

  it("immediate() bypass routes to onImmediate and skips the batch", async () => {
    const immediate = vi.fn();
    const flush = vi.fn();
    const q = createSignalQueue({
      immediate: (s) => s.event.type === "urgent.x.y",
      onImmediate: async (s) => { immediate(s); },
      batch: { maxSize: 10, maxWaitMs: 10_000, onFlush: async (s) => flush(s) },
    });
    await q.push({ ...signal(), event: { ...signal().event, type: "urgent.x.y" } });
    expect(immediate).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
  });

  it("non-matching immediate still enters the batch", async () => {
    const onImmediate = vi.fn();
    const flushes: W2ASignal[][] = [];
    const q = createSignalQueue({
      immediate: () => false,
      onImmediate,
      batch: { maxSize: 1, maxWaitMs: 10_000, onFlush: async (s) => { flushes.push(s); } },
    });
    await q.push(signal());
    expect(onImmediate).not.toHaveBeenCalled();
    expect(flushes.length).toBe(1);
  });

  it("flush() drains the buffer and cancels the pending timer", async () => {
    vi.useFakeTimers();
    const flushes: W2ASignal[][] = [];
    const q = createSignalQueue({
      batch: { maxSize: 100, maxWaitMs: 10_000, onFlush: async (s) => { flushes.push(s); } },
    });
    await q.push(signal("11111111-1111-4111-8111-111111111111"));
    await q.push(signal("22222222-2222-4222-8222-222222222222"));
    await q.flush();
    expect(flushes.length).toBe(1);
    expect(flushes[0]?.length).toBe(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(flushes.length).toBe(1);
  });

  it("flush() on an empty buffer is a no-op", async () => {
    const onFlush = vi.fn();
    const q = createSignalQueue({
      batch: { maxSize: 10, maxWaitMs: 1000, onFlush: async (s) => onFlush(s) },
    });
    await q.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("stop() flushes remaining signals", async () => {
    const flushes: W2ASignal[][] = [];
    const q = createSignalQueue({
      batch: { maxSize: 10, maxWaitMs: 10_000, onFlush: async (s) => { flushes.push(s); } },
    });
    await q.push(signal());
    await q.stop();
    expect(flushes.length).toBe(1);
  });
});
