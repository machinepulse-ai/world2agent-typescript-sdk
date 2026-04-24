import { describe, expect, it } from "vitest";
import { SignalBackpressureError, SignalValidationError } from "../src/errors.js";

describe("SignalValidationError", () => {
  it("exposes message, name, and issues", () => {
    const issues = [{ path: "event.summary", message: "too short" }];
    const err = new SignalValidationError("Invalid", issues);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SignalValidationError");
    expect(err.message).toBe("Invalid");
    expect(err.issues).toEqual(issues);
  });

  it("is instanceof SignalValidationError across the prototype chain", () => {
    const err = new SignalValidationError("x", []);
    expect(err instanceof SignalValidationError).toBe(true);
  });
});

describe("SignalBackpressureError", () => {
  it("sets name and optional retryAfterMs", () => {
    const err = new SignalBackpressureError("overloaded", 1000);
    expect(err.name).toBe("SignalBackpressureError");
    expect(err.retryAfterMs).toBe(1000);
  });

  it("allows retryAfterMs to be undefined", () => {
    const err = new SignalBackpressureError("overloaded");
    expect(err.retryAfterMs).toBeUndefined();
  });
});
