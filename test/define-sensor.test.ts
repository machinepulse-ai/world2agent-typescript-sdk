import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineSensor } from "../src/define-sensor.js";
import { SignalValidationError } from "../src/errors.js";
import type { SensorContext, W2ASignal } from "../src/types.js";

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

function makeCtx(overrides: Partial<SensorContext> = {}): SensorContext {
  return {
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn().mockResolvedValue(undefined),
    reportHealth: vi.fn(),
    ...overrides,
  };
}

describe("defineSensor", () => {
  it("returns a frozen spec with the fields provided", () => {
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start() {
        return () => {};
      },
    });
    expect(spec.id).toBe("@w2a/sensor-demo");
    expect(spec.version).toBe("0.1.0");
    expect(spec.source_type).toBe("demo");
    expect(Object.isFrozen(spec)).toBe(true);
  });

  it("validates the spec at definition time", () => {
    expect(() =>
      defineSensor({
        // deliberately missing id
        id: "",
        version: "0.1.0",
        source_type: "demo",
        auth: { type: "none" },
        async start() {
          return () => {};
        },
      }),
    ).toThrow();
  });

  it("wraps ctx.emit with signal validation", async () => {
    const upstreamEmit = vi.fn().mockResolvedValue(undefined);
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        await ctx.emit(validSignal());
        return () => {};
      },
    });
    await spec.start(makeCtx({ emit: upstreamEmit }));
    expect(upstreamEmit).toHaveBeenCalledOnce();
  });

  it("rejects emit calls with invalid signals before they reach the transport", async () => {
    const upstreamEmit = vi.fn().mockResolvedValue(undefined);
    let raised: unknown;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start(ctx) {
        const bad = { ...validSignal(), signal_id: "not-a-uuid" };
        try {
          await ctx.emit(bad as W2ASignal);
        } catch (err) {
          raised = err;
        }
        return () => {};
      },
    });
    await spec.start(makeCtx({ emit: upstreamEmit }));
    expect(raised).toBeInstanceOf(SignalValidationError);
    expect(upstreamEmit).not.toHaveBeenCalled();
  });

  it("binds `this` inside start() to the spec", async () => {
    let seenThis: unknown;
    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      async start() {
        seenThis = this;
        return () => {};
      },
    });
    await spec.start(makeCtx());
    expect(seenThis).toBe(spec);
  });

  it("typechecks ctx.config via configSchema", () => {
    const spec = defineSensor<{ interval: number }>({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      configSchema: z.object({ interval: z.number() }),
      async start(ctx) {
        const _n: number = ctx.config.interval;
        void _n;
        return () => {};
      },
    });
    expect(spec.configSchema).toBeDefined();
  });

  it("accepts Zod schemas with `.default()` and exposes the OUTPUT type on ctx.config", () => {
    // Regression: without z.ZodType<T, ZodTypeDef, any> on configSchema, TS
    // would infer TConfig from the schema's Input type (optionals from
    // `.default()`), breaking `this` / `ctx.config` typing for the caller.
    const schema = z.object({
      count: z.coerce.number().default(10),
      name: z.string(),
    });

    const spec = defineSensor({
      id: "@w2a/sensor-demo",
      version: "0.1.0",
      source_type: "demo",
      auth: { type: "none" },
      configSchema: schema,
      async start(ctx) {
        // If the generic leaked the Input type, these assignments would fail
        // because `count` would be `number | undefined`.
        const _count: number = ctx.config.count;
        const _name: string = ctx.config.name;
        void _count;
        void _name;
        return () => {};
      },
    });
    expect(spec.configSchema).toBeDefined();
  });
});
