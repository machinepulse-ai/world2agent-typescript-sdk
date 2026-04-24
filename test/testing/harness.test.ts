import { describe, expect, it, vi } from "vitest";
import { defineSensor } from "../../src/define-sensor.js";
import type { W2ASignal } from "../../src/types.js";
import { createTestHarness } from "../../src/testing/index.js";

function validSignal(): W2ASignal {
  return {
    signal_id: "11111111-2222-4333-8444-555555555555",
    schema_version: "w2a/0.1",
    emitted_at: 1_700_000_000_000,
    source: {
      sensor_id: "@w2a/sensor-demo",
      sensor_version: "0.1.0",
      source_type: "demo",
      user_identity: "u",
      package: "@w2a/sensor-demo",
    },
    event: {
      type: "demo.x.y",
      occurred_at: 1_700_000_000_000,
      summary: "A demo event happened in the demo world with detail",
    },
  };
}

function makeSensor() {
  return defineSensor({
    id: "@w2a/sensor-demo",
    version: "0.1.0",
    source_type: "demo",
    auth: { type: "none" },
    async start(ctx) {
      ctx.logger.info("starting");
      ctx.reportHealth("ok");
      await ctx.emit(validSignal());
      return () => {
        ctx.logger.info("stopping");
      };
    },
  });
}

describe("createTestHarness", () => {
  it("collects signals, logs, and health across a start/stop cycle", async () => {
    const h = createTestHarness(makeSensor(), { config: {} });
    await h.start();
    expect(h.emitted()).toHaveLength(1);
    expect(h.logs().some((l) => l.level === "info" && l.message === "starting")).toBe(true);
    expect(h.health()?.status).toBe("ok");
    await h.stop();
    expect(h.logs().some((l) => l.message === "stopping")).toBe(true);
  });

  it("start() twice without stop() throws", async () => {
    const h = createTestHarness(makeSensor(), { config: {} });
    await h.start();
    await expect(h.start()).rejects.toThrow(/already started/);
    await h.stop();
  });

  it("stop() before start() throws", async () => {
    const h = createTestHarness(makeSensor(), { config: {} });
    await expect(h.stop()).rejects.toThrow(/not started/);
  });

  it("isValid() delegates to W2A validation", () => {
    const h = createTestHarness(makeSensor(), { config: {} });
    expect(h.isValid(validSignal())).toBe(true);
    expect(h.isValid({ ...validSignal(), signal_id: "bad" } as W2ASignal)).toBe(false);
  });

  it("reset() clears signals, logs, and health", async () => {
    const h = createTestHarness(makeSensor(), { config: {} });
    await h.start();
    expect(h.emitted().length).toBeGreaterThan(0);
    h.reset();
    expect(h.emitted()).toHaveLength(0);
    expect(h.logs()).toHaveLength(0);
    expect(h.healthHistory()).toHaveLength(0);
    await h.stop();
  });

  it("uses the supplied store/auth/metrics", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
    const auth = { getAccessToken: vi.fn().mockResolvedValue("tok"), invalidateToken: vi.fn().mockResolvedValue(undefined) };
    const metrics = { counter: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };

    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        await ctx.store!.set("k", "v");
        await ctx.auth!.getAccessToken();
        ctx.metrics!.counter("c", 1);
        return () => {};
      },
    });

    const h = createTestHarness(spec, { config: {}, store, auth, metrics });
    await h.start();
    expect(store.set).toHaveBeenCalledWith("k", "v");
    expect(auth.getAccessToken).toHaveBeenCalled();
    expect(metrics.counter).toHaveBeenCalledWith("c", 1);
    await h.stop();
  });
});
