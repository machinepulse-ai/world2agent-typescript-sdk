# Transports

Delivery mechanisms for signals. A **transport** is any async function that takes a `W2ASignal` and delivers it somewhere — to stdout, to HTTP, to Kafka, to a fanout of all of the above.

← [Back to index](./README.md)

```ts
import {
  type SignalTransport,
  stdoutTransport,
  httpTransport,
  kafkaTransport,
  amqpTransport,
  fanout,
  filter,
  batch,
  retry,
  autoTransport,
} from "@world2agent/sdk/transports";
```

## Contents

| Section | Purpose |
|---|---|
| [The `SignalTransport` type](#the-signaltransport-type) | The one-liner contract |
| [stdoutTransport](#stdouttransport) | JSON to stdout |
| [httpTransport](#httptransport) | POST to a webhook |
| [kafkaTransport](#kafkatransport) | Publish to a Kafka topic |
| [amqpTransport](#amqptransport) | Publish to a RabbitMQ exchange |
| [fanout](#fanout) | Deliver to several transports in parallel |
| [filter](#filter) | Drop signals that don't match a predicate |
| [batch](#batch) | Coalesce into size/time-based batches |
| [retry](#retry) | Wrap any transport with exponential backoff |
| [autoTransport & `W2A_TRANSPORT_URL`](#autotransport-and-w2a_transport_url) | Env-driven default for `run` / `runAll` |

---

## The `SignalTransport` type

```ts
type SignalTransport = (signal: W2ASignal) => Promise<void>;
```

Anything with this signature is a transport. Most of the factories below return one; you can also write your own inline:

```ts
const myTransport: SignalTransport = async (signal) => {
  await db.signals.insert(signal);
};
```

Transports should:

- Resolve when the signal is safely handed off.
- Reject with [`SignalBackpressureError`](./signals.md#signalbackpressureerror) when downstream is overloaded.
- Reject with any other error for transient failures — callers (and wrappers like [`retry`](#retry)) decide whether to retry.

---

## stdoutTransport

```ts
function stdoutTransport(opts?: StdoutTransportOptions): SignalTransport;

interface StdoutTransportOptions {
  pretty?: boolean;   // default: false — single-line JSON per signal
}
```

Serializes each signal to JSON and writes it to `process.stdout` with a trailing `\n`. This is the default used by [`run`](./sensor.md#run) and [`runAll`](./sensor.md#runall) when `onSignal` isn't specified and no `W2A_TRANSPORT_URL` is set.

- `pretty: false` (default) — one line per signal. Safe for piping (`| jq`, `| grep`).
- `pretty: true` — indented JSON. Human-friendly; breaks line-oriented pipelines.

---

## httpTransport

```ts
function httpTransport(opts: HttpTransportOptions): SignalTransport;

interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;      // default: 10_000 ms (AbortSignal)
  retries?: number;      // default: 2
  retryDelay?: number;   // default: 500 ms (exponential backoff)
}
```

`POST <url>` with `Content-Type: application/json` and the signal as body. 4xx responses throw immediately (permanent failure — retrying a wrong request doesn't help). Network errors and 5xx responses retry up to `retries` times with `retryDelay * 2^attempt` backoff, then rethrow.

```ts
import { httpTransport } from "@world2agent/sdk/transports";

const transport = httpTransport({
  url: "https://hub.example.com/api/signals",
  headers: { Authorization: "Bearer " + process.env.HUB_TOKEN },
  retries: 3,
});
```

---

## kafkaTransport

```ts
function kafkaTransport(opts: KafkaTransportOptions): SignalTransport;

interface KafkaTransportOptions {
  producer: KafkaProducerLike;
  topic: string;
  key?: (signal: W2ASignal) => string;
  headers?: Record<string, string>;
}

interface KafkaProducerLike {
  send(record: {
    topic: string;
    messages: Array<{ key?: string; value: string; headers?: Record<string, string> }>;
  }): Promise<unknown>;
}
```

Publish each signal as a JSON message to a Kafka topic. The caller owns the Producer lifecycle (connect/disconnect) — the transport just calls `.send()`.

- Key defaults to `signal.signal_id`. Override with `key(signal)` to partition on e.g. `source.source_type`.
- Standard headers `w2a-event-type` and `w2a-sensor-id` are always set; `headers` passed to the factory are merged on top.

The `KafkaProducerLike` shape is narrower than KafkaJS's `Producer` type on purpose — any library that implements `send(record)` works (KafkaJS, node-rdkafka wrappers, test fakes).

```ts
import { Kafka } from "kafkajs";
import { kafkaTransport } from "@world2agent/sdk/transports";

const kafka = new Kafka({ brokers: ["localhost:9092"] });
const producer = kafka.producer();
await producer.connect();

const transport = kafkaTransport({
  producer,
  topic: "w2a-signals",
  key: (s) => s.source.source_type,
});
```

---

## amqpTransport

```ts
function amqpTransport(opts: AmqpTransportOptions): SignalTransport;

interface AmqpTransportOptions {
  channel: AmqpChannelLike;
  exchange: string;
  routingKey?: string | ((signal: W2ASignal) => string);
  persistent?: boolean;       // default: true
  headers?: Record<string, unknown>;
}

interface AmqpChannelLike {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: {
      contentType?: string;
      headers?: Record<string, unknown>;
      persistent?: boolean;
    },
  ): boolean;
}
```

Publish each signal to a RabbitMQ exchange over AMQP. As with [`kafkaTransport`](#kafkatransport), the caller owns the channel lifecycle.

- `routingKey` default is `signal.event.type`. Pass a string for a static key, or a function for per-signal derivation.
- `persistent: true` tells RabbitMQ to persist the message (survives broker restart).
- Standard headers `w2a-event-type` and `w2a-sensor-id` are always set; `headers` are merged on top.
- `contentType` is always `application/json`.

---

## fanout

```ts
function fanout(transports: SignalTransport[]): SignalTransport;
```

Deliver to every transport **in parallel** (`Promise.all`). Rejects if any underlying transport rejects — losing partial progress is visible, not hidden.

```ts
import { fanout, stdoutTransport, httpTransport } from "@world2agent/sdk/transports";

const transport = fanout([
  stdoutTransport(),
  httpTransport({ url: "https://hub.example.com/api/signals" }),
]);
```

Pair with [`retry`](#retry) on each branch if you want per-branch isolation.

---

## filter

```ts
function filter(
  predicate: (signal: W2ASignal) => boolean,
  transport: SignalTransport,
): SignalTransport;
```

Drop signals that don't satisfy `predicate`; forward the rest. The predicate is synchronous.

```ts
import { filter, httpTransport } from "@world2agent/sdk/transports";

const alertsOnly = filter(
  (s) => s.event.type.startsWith("alert."),
  httpTransport({ url: "https://pager.example.com/api" }),
);
```

---

## batch

```ts
function batch(opts: BatchTransportOptions): {
  transport: SignalTransport;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

interface BatchTransportOptions {
  flush: (signals: W2ASignal[]) => Promise<void>;
  maxSize?: number;        // default: 50
  maxWaitMs?: number;      // default: 5000
}
```

Buffer signals and flush in groups. Flushes fire when the buffer reaches `maxSize`, or `maxWaitMs` has elapsed since the **first** pending signal.

```ts
import { batch } from "@world2agent/sdk/transports";

const { transport, stop } = batch({
  flush: async (signals) => {
    await db.bulkInsert(signals);
  },
  maxSize: 100,
  maxWaitMs: 10_000,
});

// at shutdown:
await stop();
```

`flush()` and `stop()` both drain the buffer now and cancel the pending timer. They're idempotent. `stop()` is distinct from `flush()` only semantically — it signals "I'm done"; there's no internal state change beyond draining.

Don't forget to call `stop()` (or `flush()`) on shutdown, or you'll lose signals that were waiting on the timer.

---

## retry

```ts
function retry(
  transport: SignalTransport,
  opts?: RetryTransportOptions,
): SignalTransport;

interface RetryTransportOptions {
  maxRetries?: number;   // default: 3
  backoff?: number;      // default: 500 ms (exponential)
}
```

Wrap any transport with retries and exponential backoff (`backoff * 2^attempt`). [`SignalValidationError`](./signals.md#signalvalidationerror) is **not** retried — it's a code bug, no amount of waiting fixes it. Everything else (including [`SignalBackpressureError`](./signals.md#signalbackpressureerror) and plain `Error`) is retried up to `maxRetries` additional attempts.

```ts
import { retry, httpTransport } from "@world2agent/sdk/transports";

const transport = retry(
  httpTransport({ url: "https://hub.example.com/api/signals" }),
  { maxRetries: 5, backoff: 1000 },
);
```

Stacking `retry` over a transport that already retries internally (like [`httpTransport`](#httptransport)) multiplies attempts — usually unnecessary. Pick one level to own retries.

---

## autoTransport and `W2A_TRANSPORT_URL`

```ts
function autoTransport(): SignalTransport;
```

The default used by [`run`](./sensor.md#run) and [`runAll`](./sensor.md#runall) when the caller doesn't pass `onSignal`. Intentionally minimal — exactly one knob:

| Env var | Effect |
|---|---|
| `W2A_TRANSPORT_URL` | Set → POST signals to that URL via [`httpTransport`](#httptransport). Unset → fall back to [`stdoutTransport()`](#stdouttransport). |

This covers the zero-code case (`W2A_TRANSPORT_URL=… npx <sensor-bin>`) for unauthenticated or network-gated endpoints. Auth, retries, timeouts, custom headers, multi-target fanout — anything beyond the bare URL — belongs in code, not env vars:

```ts
await run(spec, {
  onSignal: fanout([
    stdoutTransport(),
    retry(httpTransport({
      url: process.env.HUB_URL!,
      headers: { Authorization: `Bearer ${process.env.HUB_TOKEN}` },
      retries: 5,
    })),
  ]),
});
```

`W2A_TRANSPORT_*` is a **reserved prefix** — [`startSensor`'s config resolution](./sensor.md#config-resolution-from-env-vars) skips anything under it so transport env vars don't leak into sensor config.

---

## Footer nav

- Previous: [← consumer.md](./consumer.md)
- Next: [testing.md →](./testing.md)
- Related: [signals.md](./signals.md) (the wire format each transport carries), [sensor.md](./sensor.md#runall) (how `runAll` plugs a shared transport into many sensors)
