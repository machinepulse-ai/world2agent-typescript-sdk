import { afterEach, describe, expect, it, vi } from "vitest";
import type { W2ASignal } from "../src/types.js";
import {
  amqpTransport,
  autoTransport,
  batch,
  fanout,
  filter,
  httpTransport,
  kafkaTransport,
  retry,
  stdoutTransport,
} from "../src/transports.js";
import { SignalValidationError } from "../src/errors.js";

function signal(overrides: Partial<W2ASignal> = {}): W2ASignal {
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
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("stdoutTransport", () => {
  it("writes compact JSON with trailing newline by default", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const t = stdoutTransport();
    await t(signal());
    expect(write).toHaveBeenCalledOnce();
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n", 0)).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ signal_id: signal().signal_id });
    // compact → no indentation tokens beyond the final newline
    expect(line.split("\n").length).toBe(2);
  });

  it("pretty-prints when opts.pretty=true", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const t = stdoutTransport({ pretty: true });
    await t(signal());
    const line = String(write.mock.calls[0]?.[0]);
    // Multi-line JSON
    expect(line.split("\n").length).toBeGreaterThan(3);
  });
});

describe("httpTransport", () => {
  it("POSTs JSON to the configured URL with merged headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = httpTransport({
      url: "https://example.com/sig",
      headers: { Authorization: "Bearer abc" },
    });
    await t(signal());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.com/sig");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer abc");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      signal_id: signal().signal_id,
    });
  });

  it("fails fast on 4xx without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = httpTransport({ url: "https://x", retries: 2, retryDelay: 0 });
    await expect(t(signal())).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on network errors (fetch rejection)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const t = httpTransport({ url: "https://x", retries: 2, retryDelay: 0 });
    await expect(t(signal())).rejects.toThrow(/network down/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries 5xx errors up to retries+1 times", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = httpTransport({ url: "https://x", retries: 2, retryDelay: 0 });
    await expect(t(signal())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns success once any attempt succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = httpTransport({ url: "https://x", retries: 3, retryDelay: 0 });
    await expect(t(signal())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fanout", () => {
  it("calls every transport exactly once", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    const c = vi.fn().mockResolvedValue(undefined);
    await fanout([a, b, c])(signal());
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });

  it("rejects when any transport rejects", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(fanout([a, b])(signal())).rejects.toThrow(/boom/);
  });
});

describe("filter", () => {
  it("invokes downstream only when predicate returns true", async () => {
    const downstream = vi.fn().mockResolvedValue(undefined);
    const t = filter((s) => s.event.type === "demo.x.y", downstream);
    await t(signal());
    await t(signal({ event: { ...signal().event, type: "other" } }));
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});

describe("batch", () => {
  it("flushes at maxSize", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const { transport } = batch({ flush, maxSize: 2, maxWaitMs: 10_000 });
    await transport(signal());
    expect(flush).not.toHaveBeenCalled();
    await transport(signal());
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("flushes after maxWaitMs", async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockResolvedValue(undefined);
    const { transport } = batch({ flush, maxSize: 10, maxWaitMs: 200 });
    await transport(signal());
    await vi.advanceTimersByTimeAsync(199);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("flush() and stop() drain remaining signals", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const b = batch({ flush, maxSize: 10, maxWaitMs: 10_000 });
    await b.transport(signal());
    await b.flush();
    expect(flush).toHaveBeenCalledOnce();
    await b.stop(); // already drained — should be no-op
    expect(flush).toHaveBeenCalledOnce();
  });
});

describe("retry", () => {
  it("retries transient errors and eventually succeeds", async () => {
    const inner = vi
      .fn<(s: W2ASignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error("tx-1"))
      .mockRejectedValueOnce(new Error("tx-2"))
      .mockResolvedValueOnce(undefined);
    const t = retry(inner, { maxRetries: 3, backoff: 0 });
    await expect(t(signal())).resolves.toBeUndefined();
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("rethrows SignalValidationError immediately without retrying", async () => {
    const inner = vi
      .fn()
      .mockRejectedValue(new SignalValidationError("bad", []));
    const t = retry(inner, { maxRetries: 5, backoff: 0 });
    await expect(t(signal())).rejects.toBeInstanceOf(SignalValidationError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const inner = vi.fn().mockRejectedValue(new Error("always"));
    const t = retry(inner, { maxRetries: 2, backoff: 0 });
    await expect(t(signal())).rejects.toThrow(/always/);
    expect(inner).toHaveBeenCalledTimes(3);
  });
});

describe("kafkaTransport", () => {
  it("uses signal_id as the default key and sets standard headers", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const t = kafkaTransport({ producer: { send }, topic: "w2a" });
    await t(signal());
    expect(send).toHaveBeenCalledOnce();
    const record = send.mock.calls[0]![0] as {
      topic: string;
      messages: Array<{ key: string; value: string; headers: Record<string, string> }>;
    };
    expect(record.topic).toBe("w2a");
    const msg = record.messages[0]!;
    expect(msg.key).toBe(signal().signal_id);
    expect(msg.headers["w2a-event-type"]).toBe(signal().event.type);
    expect(msg.headers["w2a-sensor-id"]).toBe(signal().source.sensor_id);
    expect(JSON.parse(msg.value).signal_id).toBe(signal().signal_id);
  });

  it("uses the supplied key()", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const t = kafkaTransport({
      producer: { send },
      topic: "w2a",
      key: (s) => s.source.source_type,
    });
    await t(signal());
    expect(send.mock.calls[0]![0].messages[0].key).toBe("demo");
  });
});

describe("amqpTransport", () => {
  it("publishes with routing key defaulting to event.type", () => {
    const publish = vi.fn().mockReturnValue(true);
    const t = amqpTransport({ channel: { publish }, exchange: "w2a" });
    t(signal());
    const [exchange, rk, content, options] = publish.mock.calls[0]!;
    expect(exchange).toBe("w2a");
    expect(rk).toBe("demo.x.y");
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(options.contentType).toBe("application/json");
    expect(options.persistent).toBe(true);
    expect(options.headers["w2a-event-type"]).toBe("demo.x.y");
    expect(options.headers["w2a-sensor-id"]).toBe("@w2a/sensor-demo");
  });

  it("accepts a string routingKey override", () => {
    const publish = vi.fn().mockReturnValue(true);
    amqpTransport({ channel: { publish }, exchange: "w2a", routingKey: "static.key" })(signal());
    expect(publish.mock.calls[0]![1]).toBe("static.key");
  });

  it("accepts a function routingKey", () => {
    const publish = vi.fn().mockReturnValue(true);
    amqpTransport({
      channel: { publish },
      exchange: "w2a",
      routingKey: (s) => `rk.${s.source.source_type}`,
    })(signal());
    expect(publish.mock.calls[0]![1]).toBe("rk.demo");
  });

  it("honors persistent=false", () => {
    const publish = vi.fn().mockReturnValue(true);
    amqpTransport({ channel: { publish }, exchange: "w2a", persistent: false })(signal());
    expect(publish.mock.calls[0]![3].persistent).toBe(false);
  });
});

describe("autoTransport", () => {
  it("falls back to stdout when W2A_TRANSPORT_URL is unset", async () => {
    vi.stubEnv("W2A_TRANSPORT_URL", "");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const t = autoTransport();
    await t(signal());
    expect(write).toHaveBeenCalledOnce();
  });

  it("POSTs to W2A_TRANSPORT_URL when set, with no injected auth", async () => {
    vi.stubEnv("W2A_TRANSPORT_URL", "https://hub.example.com/api");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = autoTransport();
    await t(signal());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hub.example.com/api");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});
