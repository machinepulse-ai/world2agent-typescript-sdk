import { describe, expect, it } from "vitest";
import { SignalValidationError } from "../src/errors.js";
import { SignalBuilder } from "../src/signal-builder.js";

describe("SignalBuilder", () => {
  function primed(): SignalBuilder {
    return new SignalBuilder()
      .source("@w2a/x", "0.1.0", "x", "u")
      .event("a.b.c", { summary: "A long enough summary that passes W2A validation checks" });
  }

  it("chainable methods return this", () => {
    const b = new SignalBuilder();
    expect(b.source("id", "1", "t", "u")).toBe(b);
    expect(b.event("t", { summary: "A long enough summary that passes W2A validation checks" })).toBe(b);
    expect(b.sourceEvent({ schema: {}, data: {} })).toBe(b);
    expect(b.attachment({ type: "inline", mime_type: "text/plain", description: "d", data: "x" })).toBe(b);
    expect(b.meta({ x: 1 })).toBe(b);
  });

  it("build() throws when source is missing", () => {
    const b = new SignalBuilder().event("t", {
      summary: "A long enough summary that passes W2A validation checks",
    });
    expect(() => b.build()).toThrow(/source is required/);
  });

  it("build() throws when event is missing", () => {
    const b = new SignalBuilder().source("@w2a/x", "0.1.0", "x", "u");
    expect(() => b.build()).toThrow(/event is required/);
  });

  it("defaults source.package to sensor_id when not given", () => {
    const signal = primed().build();
    expect(signal.source.package).toBe("@w2a/x");
  });

  it("honors an explicit package override", () => {
    const signal = new SignalBuilder()
      .source("@w2a/x", "0.1.0", "x", "u", "@w2a/other")
      .event("t", { summary: "A long enough summary that passes W2A validation checks" })
      .build();
    expect(signal.source.package).toBe("@w2a/other");
  });

  it("emits schema_version=w2a/0.1 and a uuid signal_id", () => {
    const s = primed().build();
    expect(s.schema_version).toBe("w2a/0.1");
    expect(s.signal_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("appends attachments across multiple calls", () => {
    const signal = primed()
      .attachment({ type: "inline", mime_type: "text/plain", description: "a", data: "1" })
      .attachment({ type: "inline", mime_type: "text/plain", description: "b", data: "2" })
      .build();
    expect(signal.attachments?.length).toBe(2);
  });

  it("omits attachments when none were added", () => {
    expect(primed().build().attachments).toBeUndefined();
  });

  it("includes sourceEvent and meta when set", () => {
    const signal = primed()
      .sourceEvent({ schema: { type: "object" }, data: { x: 1 } })
      .meta({ trace: "abc" })
      .build();
    expect(signal.source_event).toEqual({ schema: { type: "object" }, data: { x: 1 } });
    expect(signal._meta).toEqual({ trace: "abc" });
  });

  it("propagates event._meta", () => {
    const signal = new SignalBuilder()
      .source("@w2a/x", "0.1.0", "x", "u")
      .event("t", {
        summary: "A long enough summary that passes W2A validation checks",
        _meta: { tag: "v1" },
      })
      .build();
    expect(signal.event._meta).toEqual({ tag: "v1" });
  });

  it("build() throws SignalValidationError when the summary is too short", () => {
    const b = new SignalBuilder()
      .source("@w2a/x", "0.1.0", "x", "u")
      .event("t", { summary: "short" });
    expect(() => b.build()).toThrow(SignalValidationError);
  });
});
