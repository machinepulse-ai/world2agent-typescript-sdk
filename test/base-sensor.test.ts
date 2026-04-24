import { describe, expect, it, vi } from "vitest";
import { BaseSensor } from "../src/base-sensor.js";
import { SignalValidationError } from "../src/errors.js";
import type {
  AuthSpec,
  CleanupFn,
  SensorContext,
  W2ASignal,
} from "../src/types.js";

class DemoSensor extends BaseSensor {
  id = "@w2a/sensor-demo";
  version = "0.1.0";
  source_type = "demo";
  auth: AuthSpec = { type: "none" };

  async start(_ctx: SensorContext): Promise<CleanupFn> {
    return () => {};
  }

  makeSignal() {
    return this.createSignal({
      event: {
        type: "demo.x.y",
        summary: "A demo event happened in the demo world with detail",
      },
    });
  }

  wrap(ctx: SensorContext): SensorContext {
    return this.wrapContext(ctx);
  }
}

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

describe("BaseSensor", () => {
  it("createSignal fills source fields from the sensor", () => {
    const signal = new DemoSensor().makeSignal();
    expect(signal.source.sensor_id).toBe("@w2a/sensor-demo");
    expect(signal.source.source_type).toBe("demo");
    expect(signal.source.package).toBe("@w2a/sensor-demo");
  });

  it("validate() accepts a well-formed spec", () => {
    expect(() => new DemoSensor().validate()).not.toThrow();
  });

  it("validate() throws when required fields are missing", () => {
    class Broken extends DemoSensor {
      override id = "";
    }
    expect(() => new Broken().validate()).toThrow();
  });

  it("wrapContext injects validation on emit", async () => {
    const upstream = vi.fn().mockResolvedValue(undefined);
    const wrapped = new DemoSensor().wrap({
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emit: upstream,
      reportHealth: vi.fn(),
    });

    await wrapped.emit(validSignal());
    expect(upstream).toHaveBeenCalledOnce();

    upstream.mockClear();
    await expect(
      wrapped.emit({ ...validSignal(), signal_id: "bad" } as W2ASignal),
    ).rejects.toThrow(SignalValidationError);
    expect(upstream).not.toHaveBeenCalled();
  });
});
