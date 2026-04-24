import { afterEach, describe, expect, it, vi } from "vitest";
import { createPollLoop, ensureStore } from "../src/helpers.js";
import type { SensorStore } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPollLoop", () => {
  it("polls each item once immediately", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const { cleanup } = createPollLoop({
      items: ["a", "b", "c"],
      intervalSeconds: 60,
      poll,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(poll.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    await cleanup();
  });

  it("polls on the configured interval", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const { cleanup } = createPollLoop({
      items: ["a"],
      intervalSeconds: 10,
      poll,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(3);
    await cleanup();
  });

  it("cleanup stops further polls", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const { cleanup } = createPollLoop({
      items: ["a"],
      intervalSeconds: 5,
      poll,
    });
    await vi.advanceTimersByTimeAsync(0);
    await cleanup();
    const countAfterCleanup = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll.mock.calls.length).toBe(countAfterCleanup);
  });

  it("routes async poll errors to the logger", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const poll = vi.fn().mockRejectedValue(new Error("boom"));
    const { cleanup } = createPollLoop({
      items: ["x"],
      intervalSeconds: 30,
      poll,
      logger,
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalled();
    expect(String(logger.error.mock.calls[0]?.[0])).toMatch(/boom/);
    await cleanup();
  });

  it("an empty items array is a no-op", async () => {
    vi.useFakeTimers();
    const poll = vi.fn();
    const { cleanup } = createPollLoop({
      items: [],
      intervalSeconds: 30,
      poll,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();
    await cleanup();
  });
});

describe("ensureStore", () => {
  it("returns ctx.store when the runner supplied one", () => {
    const injected: SensorStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    };
    expect(ensureStore({ store: injected })).toBe(injected);
  });

  it("returns a functional fallback when ctx.store is undefined", async () => {
    const store = ensureStore({});
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
    await store.delete("k");
    expect(await store.get("k")).toBe(null);
  });

  it("returns a fresh fallback on each call when no store is injected", () => {
    const a = ensureStore({});
    const b = ensureStore({});
    expect(a).not.toBe(b);
  });
});
