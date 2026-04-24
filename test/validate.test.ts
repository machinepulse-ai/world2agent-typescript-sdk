import { describe, expect, it } from "vitest";
import { SignalValidationError } from "../src/errors.js";
import type { W2ASignal } from "../src/types.js";
import { assertValidSignal, validateSignal } from "../src/validate.js";

function validSignal(overrides: Partial<W2ASignal> = {}): W2ASignal {
  return {
    signal_id: "11111111-2222-4333-8444-555555555555",
    schema_version: "w2a/0.1",
    emitted_at: 1_700_000_000_000,
    source: {
      sensor_id: "@world2agent/sensor-x",
      sensor_version: "0.1.0",
      source_type: "x",
      user_identity: "u",
      package: "@world2agent/sensor-x",
    },
    event: {
      type: "a.b.c",
      occurred_at: 1_700_000_000_000,
      summary: "Something meaningful and long enough to pass validation",
    },
    ...overrides,
  };
}

describe("validateSignal", () => {
  it("returns success for a valid signal", () => {
    expect(validateSignal(validSignal())).toEqual({ success: true });
  });

  it("returns issues with dotted paths for invalid signals", () => {
    const bad = { ...validSignal(), signal_id: "bad" };
    const result = validateSignal(bad);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]?.path).toBe("signal_id");
    expect(result.errors![0]?.message).toMatch(/uuid/i);
  });

  it("flattens nested paths with dots", () => {
    const bad = validSignal({
      event: {
        type: "",
        occurred_at: 1_700_000_000_000,
        summary: "Something meaningful and long enough to pass validation",
      },
    });
    const result = validateSignal(bad);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e) => e.path === "event.type")).toBe(true);
  });

  it("never throws for invalid input shapes", () => {
    expect(() => validateSignal(null)).not.toThrow();
    expect(() => validateSignal("string")).not.toThrow();
    expect(() => validateSignal({})).not.toThrow();
  });
});

describe("assertValidSignal", () => {
  it("does not throw for a valid signal", () => {
    expect(() => assertValidSignal(validSignal())).not.toThrow();
  });

  it("throws SignalValidationError with attached issues", () => {
    try {
      assertValidSignal({ ...validSignal(), signal_id: "bad" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SignalValidationError);
      const typed = err as SignalValidationError;
      expect(typed.issues.length).toBeGreaterThan(0);
      expect(typed.message).toMatch(/Invalid W2A signal/);
    }
  });
});
