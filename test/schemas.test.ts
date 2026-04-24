import { describe, expect, it } from "vitest";
import { SensorSpecSchema, W2ASignalSchema, schemas } from "../src/schemas.js";
import type { W2ASignal } from "../src/types.js";

function validSignal(overrides: Partial<W2ASignal> = {}): W2ASignal {
  return {
    signal_id: "11111111-2222-4333-8444-555555555555",
    schema_version: "w2a/0.1",
    emitted_at: 1_700_000_000_000,
    source: {
      sensor_id: "@world2agent/sensor-feishu",
      sensor_version: "0.1.0",
      source_type: "feishu",
      user_identity: "u_abc",
      package: "@world2agent/sensor-feishu",
    },
    event: {
      type: "messaging.message.mentioned",
      occurred_at: 1_700_000_000_000,
      summary: "Alice mentioned Bob in #general and asked about the Q3 roadmap",
    },
    ...overrides,
  };
}

describe("W2ASignalSchema", () => {
  it("accepts a valid signal", () => {
    expect(W2ASignalSchema.safeParse(validSignal()).success).toBe(true);
  });

  it("exposes the same schema via the schemas object", () => {
    expect(schemas.W2ASignal).toBe(W2ASignalSchema);
    expect(schemas.SensorSpec).toBe(SensorSpecSchema);
  });

  it("rejects a non-UUID signal_id", () => {
    const result = W2ASignalSchema.safeParse(validSignal({ signal_id: "not-a-uuid" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["signal_id"]);
    }
  });

  it("rejects a wrong schema_version", () => {
    const bad = { ...validSignal(), schema_version: "w2a/0.2" as unknown as "w2a/0.1" };
    expect(W2ASignalSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-positive emitted_at", () => {
    expect(W2ASignalSchema.safeParse(validSignal({ emitted_at: 0 })).success).toBe(false);
    expect(W2ASignalSchema.safeParse(validSignal({ emitted_at: -1 })).success).toBe(false);
  });

  it("rejects fractional emitted_at", () => {
    expect(W2ASignalSchema.safeParse(validSignal({ emitted_at: 1.5 })).success).toBe(false);
  });

  it("requires source.package", () => {
    const broken = validSignal();
    delete (broken.source as Partial<typeof broken.source>).package;
    expect(W2ASignalSchema.safeParse(broken).success).toBe(false);
  });

  it("requires event.summary >= 20 characters", () => {
    const shortSummary = W2ASignalSchema.safeParse(
      validSignal({
        event: { ...validSignal().event, summary: "too short" },
      }),
    );
    expect(shortSummary.success).toBe(false);
  });

  it("accepts exactly 20 character summary", () => {
    const result = W2ASignalSchema.safeParse(
      validSignal({
        event: {
          ...validSignal().event,
          summary: "a".repeat(20),
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts optional source_event with schema + data", () => {
    const result = W2ASignalSchema.safeParse(
      validSignal({
        source_event: {
          schema: { type: "object" },
          data: { foo: "bar" },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts inline and reference attachments", () => {
    const result = W2ASignalSchema.safeParse(
      validSignal({
        attachments: [
          {
            type: "inline",
            mime_type: "text/plain",
            description: "hello",
            data: "hi there",
          },
          {
            type: "reference",
            mime_type: "image/png",
            description: "a screenshot",
            uri: "https://example.com/x.png",
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an attachment with empty description", () => {
    const result = W2ASignalSchema.safeParse(
      validSignal({
        attachments: [
          {
            type: "inline",
            mime_type: "text/plain",
            description: "",
            data: "x",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects attachments whose serialized size exceeds 1MB", () => {
    const big = "x".repeat(1_100_000);
    const result = W2ASignalSchema.safeParse(
      validSignal({
        attachments: [
          {
            type: "inline",
            mime_type: "text/plain",
            description: "big",
            data: big,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("SensorSpecSchema", () => {
  it("accepts a minimal spec with auth=none", () => {
    const spec = {
      id: "@world2agent/sensor-demo",
      version: "0.0.1",
      source_type: "demo",
      auth: { type: "none" },
      start: () => Promise.resolve(() => {}),
    };
    expect(SensorSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts api_key auth with fields", () => {
    const spec = {
      id: "x",
      version: "1",
      source_type: "y",
      auth: {
        type: "api_key",
        fields: [{ name: "token", label: "Token", sensitive: true }],
      },
      start: () => Promise.resolve(() => {}),
    };
    expect(SensorSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects a spec missing start()", () => {
    const spec = {
      id: "x",
      version: "1",
      source_type: "y",
      auth: { type: "none" },
    };
    expect(SensorSpecSchema.safeParse(spec).success).toBe(false);
  });
});
