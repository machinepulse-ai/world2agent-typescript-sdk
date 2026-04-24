import { describe, expect, it, vi } from "vitest";
import { createSignal, generateSignalId } from "../src/create-signal.js";
import { SignalValidationError } from "../src/errors.js";
import { validateSignal } from "../src/validate.js";

const spec = {
  id: "@world2agent/sensor-demo",
  version: "0.1.0",
  source_type: "demo",
};

describe("generateSignalId", () => {
  it("returns a UUID v4-shaped string", () => {
    const id = generateSignalId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("is effectively unique between calls", () => {
    const a = new Set(Array.from({ length: 32 }, () => generateSignalId()));
    expect(a.size).toBe(32);
  });
});

describe("createSignal", () => {
  it("fills source fields from the sensor spec", () => {
    const s = createSignal(spec, {
      event: { type: "demo.thing.happened", summary: "A demo event happened in the demo world" },
    });
    expect(s.source.sensor_id).toBe(spec.id);
    expect(s.source.sensor_version).toBe(spec.version);
    expect(s.source.source_type).toBe(spec.source_type);
    expect(s.source.package).toBe(spec.id);
    expect(s.source.user_identity).toBe("unknown");
  });

  it("accepts an explicit user_identity", () => {
    const s = createSignal(spec, {
      event: { type: "demo.x.y", summary: "A demo event happened in the demo world" },
      source: { user_identity: "u_42" },
    });
    expect(s.source.user_identity).toBe("u_42");
  });

  it("fills emitted_at and occurred_at with Date.now() by default", () => {
    const now = 1_700_123_456_789;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const s = createSignal(spec, {
        event: { type: "t", summary: "A demo event happened in the demo world" },
      });
      expect(s.emitted_at).toBe(now);
      expect(s.event.occurred_at).toBe(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses explicit occurred_at when provided", () => {
    const explicit = 1_600_000_000_000;
    const s = createSignal(spec, {
      event: {
        type: "t",
        occurred_at: explicit,
        summary: "A demo event happened in the demo world",
      },
    });
    expect(s.event.occurred_at).toBe(explicit);
  });

  it("sets schema_version to w2a/0.1", () => {
    const s = createSignal(spec, {
      event: { type: "t", summary: "A demo event happened in the demo world" },
    });
    expect(s.schema_version).toBe("w2a/0.1");
  });

  it("omits attachments when the array is empty", () => {
    const s = createSignal(spec, {
      event: { type: "t", summary: "A demo event happened in the demo world" },
      attachments: [],
    });
    expect(s.attachments).toBeUndefined();
  });

  it("includes attachments when non-empty", () => {
    const s = createSignal(spec, {
      event: { type: "t", summary: "A demo event happened in the demo world" },
      attachments: [
        { type: "inline", mime_type: "text/plain", description: "d", data: "x" },
      ],
    });
    expect(s.attachments?.length).toBe(1);
  });

  it("includes source_event and _meta only when provided", () => {
    const minimal = createSignal(spec, {
      event: { type: "t", summary: "A demo event happened in the demo world" },
    });
    expect(minimal.source_event).toBeUndefined();
    expect(minimal._meta).toBeUndefined();

    const rich = createSignal(spec, {
      event: {
        type: "t",
        summary: "A demo event happened in the demo world",
        _meta: { tag: "v1" },
      },
      source_event: { schema: { type: "object" }, data: { k: 1 } },
      _meta: { trace: "abc" },
    });
    expect(rich.event._meta).toEqual({ tag: "v1" });
    expect(rich.source_event).toEqual({ schema: { type: "object" }, data: { k: 1 } });
    expect(rich._meta).toEqual({ trace: "abc" });
  });

  it("throws SignalValidationError if the event summary is too short", () => {
    expect(() =>
      createSignal(spec, { event: { type: "t", summary: "short" } }),
    ).toThrow(SignalValidationError);
  });

  it("produces a signal that passes validateSignal()", () => {
    const s = createSignal(spec, {
      event: { type: "t", summary: "A demo event happened in the demo world" },
    });
    expect(validateSignal(s).success).toBe(true);
  });
});
