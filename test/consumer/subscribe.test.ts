import { afterEach, describe, expect, it, vi } from "vitest";
import type { W2ASignal } from "../../src/types.js";
import { subscribe } from "../../src/consumer/subscribe.js";

type EventName = "open" | "message" | "close" | "error";

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = 0;
  private listeners = new Map<EventName, Array<(ev: unknown) => void>>();
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(name: EventName, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", {});
  }

  fire(name: EventName, ev: unknown): void {
    (this.listeners.get(name) ?? []).forEach((fn) => fn(ev));
  }

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open", {});
  }

  triggerMessage(data: string): void {
    this.fire("message", { data });
  }

  triggerError(): void {
    this.fire("error", new Error("socket error"));
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function validSignalJSON() {
  const s: W2ASignal = {
    signal_id: "11111111-2222-4333-8444-555555555555",
    schema_version: "w2a/0.1",
    emitted_at: 1_700_000_000_000,
    source: { sensor_id: "x", sensor_version: "1", source_type: "x", user_identity: "u", package: "x" },
    event: { type: "a.b.c", occurred_at: 1, summary: "A long enough summary that passes W2A validation checks" },
  };
  return JSON.stringify(s);
}

afterEach(() => {
  MockWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subscribe", () => {
  it("converts http(s):// to ws(s):// and appends /subscribe", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const promise = subscribe("https://relay.example.com/channels/xyz", {
      logger: silentLogger(),
    });
    // simulate open before awaiting the returned promise
    await Promise.resolve();
    MockWebSocket.instances[0]!.triggerOpen();
    const cleanup = await promise;

    expect(MockWebSocket.instances[0]!.url).toBe(
      "wss://relay.example.com/channels/xyz/subscribe",
    );
    await cleanup();
  });

  it("sets since and token query params when provided", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const p = subscribe("wss://relay.example.com/channels/xyz", {
      since: 1234,
      apiKey: "sk-abc",
      logger: silentLogger(),
    });
    await Promise.resolve();
    MockWebSocket.instances[0]!.triggerOpen();
    const cleanup = await p;

    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.searchParams.get("since")).toBe("1234");
    expect(url.searchParams.get("token")).toBe("sk-abc");
    await cleanup();
  });

  it("deduplicates an existing /subscribe suffix", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const p = subscribe("wss://relay.example.com/subscribe", {
      logger: silentLogger(),
    });
    await Promise.resolve();
    MockWebSocket.instances[0]!.triggerOpen();
    const cleanup = await p;

    expect(MockWebSocket.instances[0]!.url).toBe(
      "wss://relay.example.com/subscribe",
    );
    await cleanup();
  });

  it("parses incoming messages and forwards them to onSignal", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const onSignal = vi.fn().mockResolvedValue(undefined);

    const p = subscribe("wss://r/x", { onSignal, logger: silentLogger() });
    await Promise.resolve();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    const cleanup = await p;

    ws.triggerMessage(validSignalJSON());
    await new Promise((r) => setImmediate(r));
    expect(onSignal).toHaveBeenCalledOnce();
    expect((onSignal.mock.calls[0]![0] as W2ASignal).signal_id).toBe(
      "11111111-2222-4333-8444-555555555555",
    );

    await cleanup();
  });

  it("logs (does not throw) when a message is unparseable", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const logger = silentLogger();

    const p = subscribe("wss://r/x", { logger });
    await Promise.resolve();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    const cleanup = await p;

    ws.triggerMessage("{not json");
    await new Promise((r) => setImmediate(r));
    expect(logger.error).toHaveBeenCalled();
    await cleanup();
  });

  it("rejects the initial connect promise on error before open", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const p = subscribe("wss://r/x", {
      logger: silentLogger(),
      reconnect: false,
    });
    await Promise.resolve();
    MockWebSocket.instances[0]!.triggerError();
    await expect(p).rejects.toThrow(/Failed to connect/);
  });

  it("cleanup function closes the socket and stops reconnection", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const logger = silentLogger();

    const p = subscribe("wss://r/x", { logger, reconnect: true, reconnectDelay: 1 });
    await Promise.resolve();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    const cleanup = await p;

    await cleanup();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    // wait past the reconnect delay — no new socket should be created
    await new Promise((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
