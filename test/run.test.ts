import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineSensor } from "../src/define-sensor.js";
import { startSensor } from "../src/run.js";
import { MemorySensorStore } from "../src/stores/memory.js";
import type { Logger, SensorContext, W2ASignal } from "../src/types.js";

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

function silentLogger(): Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startSensor", () => {
  it("delivers signals through onSignal", async () => {
    const onSignal = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SensorContext | null = null;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        capturedCtx = ctx;
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      config: {},
      onSignal,
      logger: silentLogger(),
    });
    await capturedCtx!.emit(validSignal());
    expect(onSignal).toHaveBeenCalledOnce();
    await cleanup();
  });

  it("logs each emit when logEmits=true", async () => {
    const logger = silentLogger();
    let capturedCtx: SensorContext | null = null;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        capturedCtx = ctx;
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      config: {},
      onSignal: async () => {},
      logger,
      logEmits: true,
    });
    await capturedCtx!.emit(validSignal());
    expect(logger.info).toHaveBeenCalled();
    expect(String(logger.info.mock.calls[0]?.[0])).toMatch(/emit signal:/);
    await cleanup();
  });

  it("does not log each emit when logEmits is unset/false", async () => {
    const logger = silentLogger();
    let capturedCtx: SensorContext | null = null;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        capturedCtx = ctx;
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      config: {},
      onSignal: async () => {},
      logger,
    });
    await capturedCtx!.emit(validSignal());
    expect(logger.info).not.toHaveBeenCalled();
    await cleanup();
  });

  it("auto-scopes the store with the sensor id prefix", async () => {
    const backing = new MemorySensorStore();
    let capturedCtx: SensorContext | null = null;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        capturedCtx = ctx;
        await ctx.store!.set("cursor", "abc");
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      config: {},
      store: backing,
      logger: silentLogger(),
    });
    // key is prefixed in the backing store
    expect(await backing.get("@w2a/sensor-demo:cursor")).toBe("abc");
    // but the scoped view sees the plain key
    expect(await capturedCtx!.store!.get("cursor")).toBe("abc");

    await capturedCtx!.store!.delete("cursor");
    expect(await backing.get("@w2a/sensor-demo:cursor")).toBe(null);
    await cleanup();
  });

  it("parses config through configSchema when provided", async () => {
    const seen: Array<unknown> = [];
    const spec = defineSensor<{ interval: number }>({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      configSchema: z.object({ interval: z.coerce.number() }),
      async start(ctx) {
        seen.push(ctx.config);
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      config: { interval: "30" } as unknown as { interval: number },
      onSignal: async () => {},
      logger: silentLogger(),
    });
    expect(seen[0]).toEqual({ interval: 30 });
    await cleanup();
  });

  it("rejects when configSchema fails", async () => {
    const spec = defineSensor<{ interval: number }>({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      configSchema: z.object({ interval: z.number() }),
      async start() {
        return () => {};
      },
    });
    await expect(
      startSensor(spec, {
        config: { interval: "nope" } as unknown as { interval: number },
        onSignal: async () => {},
        logger: silentLogger(),
      }),
    ).rejects.toThrow();
  });

  it("reads api_key auth fields from W2A_<FIELD> env vars when no config is provided", async () => {
    vi.stubEnv("W2A_APP_ID", "cli_abc");
    vi.stubEnv("W2A_APP_SECRET", "sk_xyz");
    const seen: Array<unknown> = [];
    const spec = defineSensor({
      id: "@w2a/sensor-feishu",
      version: "0.1.0",
      source_type: "feishu",
      auth: {
        type: "api_key",
        fields: [
          { name: "app_id", label: "App ID", sensitive: false },
          { name: "app_secret", label: "App Secret", sensitive: true },
        ],
      },
      async start(ctx) {
        seen.push(ctx.config);
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      onSignal: async () => {},
      logger: silentLogger(),
    });
    expect(seen[0]).toMatchObject({ app_id: "cli_abc", app_secret: "sk_xyz" });
    await cleanup();
  });

  it("parses JSON-looking env vars into config values", async () => {
    vi.stubEnv("W2A_JOBS", '[{"name":"a","cron":"* * * * *"}]');
    vi.stubEnv("W2A_WATCH_PATHS", '["/tmp/a","/tmp/b"]');
    const seen: Array<Record<string, unknown>> = [];
    const spec = defineSensor({
      id: "@w2a/sensor-cron",
      version: "0.1.0",
      source_type: "cron",
      auth: { type: "none" },
      async start(ctx) {
        seen.push(ctx.config as Record<string, unknown>);
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      onSignal: async () => {},
      logger: silentLogger(),
    });
    expect(seen[0]?.jobs).toEqual([{ name: "a", cron: "* * * * *" }]);
    expect(seen[0]?.watch_paths).toEqual(["/tmp/a", "/tmp/b"]);
    await cleanup();
  });

  it("ignores W2A_TRANSPORT_* env vars when assembling config", async () => {
    vi.stubEnv("W2A_TRANSPORT_URL", "https://hub");
    vi.stubEnv("W2A_TRANSPORT_TOKEN", "tkn");
    const seen: Array<Record<string, unknown>> = [];
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        seen.push(ctx.config as Record<string, unknown>);
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      onSignal: async () => {},
      logger: silentLogger(),
    });
    expect(seen[0]).not.toHaveProperty("transport_url");
    expect(seen[0]).not.toHaveProperty("transport_token");
    await cleanup();
  });

  it("reportHealth routes error to logger.error, others to logger.info", async () => {
    const logger = silentLogger();
    let capturedCtx: SensorContext | null = null;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        capturedCtx = ctx;
        return () => {};
      },
    });
    const cleanup = await startSensor(spec, {
      config: {},
      onSignal: async () => {},
      logger,
    });
    capturedCtx!.reportHealth("ok");
    capturedCtx!.reportHealth("degraded", "slow");
    capturedCtx!.reportHealth("error", "down");

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toMatch(/error: down/);
    await cleanup();
  });

  it("returns the cleanup function from the sensor", async () => {
    const stop = vi.fn();
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start() {
        return stop;
      },
    });
    const cleanup = await startSensor(spec, {
      config: {},
      onSignal: async () => {},
      logger: silentLogger(),
    });
    await cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });
});
