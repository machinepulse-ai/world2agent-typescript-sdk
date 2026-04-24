# Consuming signals

A consumer is whatever runs on the agent side and turns inbound `W2ASignal`s into action — dispatch, batching, relay subscription. The SDK supplies the primitives; you compose them.

← [Back to index](./README.md)

```ts
import {
  createSignalHandler,
  type SignalHandler,
  type SignalHandlerFn,
  createSignalQueue,
  type SignalQueue,
  type SignalQueueOptions,
  subscribe,
  type SubscribeOptions,
} from "@world2agent/sdk/consumer";

import { apiKeyAuth, customAuth } from "@world2agent/sdk";
import type { ConsumerAuth, ConsumerIdentity } from "@world2agent/sdk";
```

## Contents

| Section | Purpose |
|---|---|
| [createSignalHandler](#createsignalhandler) | Pattern-match signals by `event.type` |
| [createSignalQueue](#createsignalqueue) | Batch non-urgent signals, bypass urgent ones |
| [subscribe](#subscribe) | Connect to a remote relay channel (WebSocket) |
| [ConsumerAuth](#consumerauth) | Sensor-declared auth for incoming consumer connections |
| [apiKeyAuth](#apikeyauth) | Static API-key → consumer-id map |
| [customAuth](#customauth) | Bring-your-own verify function |

---

## createSignalHandler

```ts
function createSignalHandler(): SignalHandler;

interface SignalHandler {
  on(pattern: string, handler: SignalHandlerFn): void;
  handle(signal: W2ASignal): Promise<void>;
}

type SignalHandlerFn = (signal: W2ASignal) => void | Promise<void>;
```

Pattern-matching dispatcher for `signal.event.type`. Handlers are registered with an optional glob and invoked in **registration order**. A signal goes to **every** matching handler (not just the first).

### Pattern grammar

| Pattern | Matches |
|---|---|
| `"messaging.message.mentioned"` | Exact match |
| `"messaging.message.*"` | Any action under `messaging.message` (and the bare prefix itself) |
| `"messaging.*"` | Any entity+action under `messaging` |
| `"*"` | Everything (fallback) |

```ts
import { createSignalHandler } from "@world2agent/sdk/consumer";

const handler = createSignalHandler();

handler.on("messaging.message.mentioned", async (signal) => {
  notify(signal.event.summary);
});
handler.on("code.*", async (signal) => {
  pipeToEngineer(signal);
});
handler.on("*", (signal) => {
  console.log("[trace]", signal.event.type, signal.signal_id);
});

await handler.handle(incomingSignal);
```

`handle()` awaits every matching async handler sequentially, in registration order. If you need parallel fan-out, wrap your handlers in `Promise.all` yourself.

Exceptions propagate to the caller — `handle()` does not swallow them.

---

## createSignalQueue

```ts
function createSignalQueue(options: SignalQueueOptions): SignalQueue;

interface SignalQueueOptions {
  immediate?: (signal: W2ASignal) => boolean;
  batch: {
    maxSize: number;
    maxWaitMs: number;
    onFlush: (signals: W2ASignal[]) => void | Promise<void>;
  };
  onImmediate?: (signal: W2ASignal) => void | Promise<void>;
}

interface SignalQueue {
  push(signal: W2ASignal): Promise<void>;
  flush(): Promise<void>;
  stop(): Promise<void>;
}
```

Async queue with **urgency bypass** and **time-or-size batching**. Typical use: feed an agent LLM in batches to save tokens, but route critical alerts (on-call paging, deadlines) to a separate immediate-response path.

### Dispatch rules

1. If `immediate?.(signal)` returns true **and** `onImmediate` is set, the signal is handed to `onImmediate` and skips the batch.
2. Otherwise it joins the buffer.
3. When `buffer.length >= batch.maxSize`, the buffer is flushed via `batch.onFlush`.
4. Otherwise a single timer is set for `batch.maxWaitMs`; on fire, the buffer is flushed.

`flush()` drains the buffer now and cancels the pending timer. `stop()` is `flush()` (plus a semantic signal that you don't intend to push more).

### When does a signal with matching `immediate` but no `onImmediate` get batched?

Yes — if `onImmediate` is missing, the `immediate` check is effectively skipped and the signal goes into the batch. Set `onImmediate` whenever you set `immediate`.

```ts
import { createSignalQueue } from "@world2agent/sdk/consumer";

const queue = createSignalQueue({
  immediate: (s) =>
    s.event.type.startsWith("alert.") ||
    s.event.type === "messaging.message.mentioned",
  onImmediate: async (s) => askAgentNow(s),
  batch: {
    maxSize: 20,
    maxWaitMs: 30_000,
    onFlush: async (signals) => askAgentWithContext(signals),
  },
});

// Feed it from your transport / handler / subscribe():
await queue.push(incomingSignal);
```

Pair with [`createSignalHandler`](#createsignalhandler) when the batched handler needs to dispatch by event type after flushing.

---

## subscribe

```ts
function subscribe(
  url: string,
  options?: SubscribeOptions,
): Promise<CleanupFn>;

interface SubscribeOptions {
  onSignal?: SignalTransport;    // default: JSON to stdout
  apiKey?: string;               // becomes ?token=…
  since?: number;                // ms timestamp, replay from
  reconnect?: boolean;           // default: true
  reconnectDelay?: number;       // default: 5000 ms
  logger?: Logger;               // default: console
}
```

Connect to a World2Agent relay channel over WebSocket. The resulting `CleanupFn` is interchangeable with the one returned by [`run`](./sensor.md#run) / [`startSensor`](./sensor.md#startsensor) — which is why [`runAll`](./sensor.md#runall) can treat local sensors and remote channels uniformly.

### URL handling

- `http://` / `https://` are upgraded to `ws://` / `wss://`.
- `/subscribe` is appended — unless the URL already ends with it.
- `since` → `?since=<ms>` search param.
- `apiKey` → `?token=<apiKey>` search param.

### Liveness & reconnect

- A ping (`{"type":"ping"}`) is sent every 30 s while the socket is open.
- On close, the subscriber waits `reconnectDelay` ms and reconnects unless `reconnect: false` or the caller has called the returned cleanup.
- Parse failures on incoming messages are logged and skipped — the connection is **not** dropped.

### Example

```ts
import { subscribe } from "@world2agent/sdk/consumer";

const cleanup = await subscribe("wss://relay.example.com/channels/stock-alerts", {
  apiKey: process.env.RELAY_TOKEN,
  since: Date.now() - 24 * 60 * 60 * 1000,
  onSignal: (signal) => handler.handle(signal),
});

process.on("SIGINT", () => cleanup());
```

The server side of this protocol is a separate relay implementation (see the relay's own docs); this function only documents the client.

---

## ConsumerAuth

```ts
interface ConsumerAuth {
  required: boolean;
  verify(credential: string): Promise<ConsumerIdentity>;
}

interface ConsumerIdentity {
  consumerId: string;
  [key: string]: unknown;
}
```

A sensor can declare `consumerAuth` on its `SensorSpec`. When a transport / relay forwards signals to downstream consumers, it's expected to verify each connecting consumer against this strategy.

Two built-in strategies, below. For anything else, use [`customAuth`](#customauth).

### apiKeyAuth

```ts
function apiKeyAuth(keys: Record<string, string>): ConsumerAuth;
```

Static API-key → consumer-id map. Simplest option — good for personal setups and small teams where you rotate keys out-of-band.

```ts
import { apiKeyAuth } from "@world2agent/sdk";

const auth = apiKeyAuth({
  "sk-alice-abc": "agent-alice",
  "sk-bob-def":   "agent-bob",
});

await auth.verify("sk-alice-abc");
// → { consumerId: "agent-alice" }

await auth.verify("sk-unknown");
// throws Error("Invalid API key")
```

`required: true`. An empty credential throws.

### customAuth

```ts
function customAuth(
  verifyFn: (credential: string) => Promise<ConsumerIdentity>,
): ConsumerAuth;
```

Wrap any async verification function (license server, OAuth introspect, JWT verify, Redis lookup) into a `ConsumerAuth`.

```ts
import { customAuth } from "@world2agent/sdk";

const auth = customAuth(async (token) => {
  const res = await fetch("https://api.mycompany.com/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Unauthorized");
  const data = await res.json();
  return { consumerId: data.customerId, plan: data.plan };
});
```

Errors thrown inside `verifyFn` propagate through `auth.verify()` as-is. `required` is hard-coded to `true`.

---

## Footer nav

- Previous: [← state.md](./state.md)
- Next: [transports.md →](./transports.md)
- Related: [signals.md — `W2ASignal`](./signals.md#w2asignal) (what you receive), [sensor.md — `consumerAuth` on `SensorSpec`](./sensor.md#sensorspec)
