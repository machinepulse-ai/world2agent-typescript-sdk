# Concepts

Cross-cutting semantics — the guarantees, the boundaries, and who is responsible for what.

← [Back to index](./README.md)

## Contents

| Section | What it covers |
|---|---|
| [Signal lifecycle](#signal-lifecycle) | Who touches a signal on its way through the SDK |
| [Validation boundaries](#validation-boundaries) | Three places signals are checked, and who owns the check |
| [Delivery semantics](#delivery-semantics) | At-most-once, at-least-once, exactly-never |
| [Backpressure](#backpressure) | When and how downstream says "slow down" |
| [Dedup and cursor state](#dedup-and-cursor-state) | Surviving restarts without flooding or missing events |
| [Skill-id routing](#skill-id-routing) | How a channel picks the right handler from a signal |
| [Sensor vs. consumer responsibilities](#sensor-vs-consumer-responsibilities) | The contract between the two halves |
| [Versioning](#versioning) | Package semver vs. wire-format version |

---

## Signal lifecycle

```
upstream event
   │
   ▼
┌──────────────────────────┐
│ Sensor.start(ctx)        │
│   build signal           │ ← createSignal / SignalBuilder validate here
│   ctx.emit(signal)       │ ← assertValidSignal wraps this (defineSensor/startSensor)
└──────────┬───────────────┘
           ▼
        transport            ← stdout / http / kafka / fanout / batch / retry / …
           │
           ▼
        consumer             ← createSignalHandler / createSignalQueue / subscribe
           │
           ▼
      agent action
```

Each arrow is a place something can fail. The SDK's job is to make the *kinds* of failures distinguishable (validation vs. transient vs. backpressure) so you know whether to retry, give up, or pause.

---

## Validation boundaries

Signals are validated against [`W2ASignalSchema`](./signals.md#schemas-zod) at **three** points. Understanding which one catches what saves a lot of debugging.

| Boundary | What | Who calls it | On failure |
|---|---|---|---|
| **Construction** | [`createSignal`](./signals.md#createsignal), [`SignalBuilder.build()`](./signals.md#signalbuilder) | Sensor code | Throws [`SignalValidationError`](./signals.md#signalvalidationerror) synchronously — the signal object is never returned |
| **Emission** | [`ctx.emit`](./sensor.md#emit) wrapper installed by [`defineSensor`](./sensor.md#definesensor) / [`BaseSensor.wrapContext`](./sensor.md#basesensor) / [`startSensor`](./sensor.md#startsensor) | SDK runtime | Rejects the emit promise with `SignalValidationError` before the transport sees it |
| **Inbound** | [`validateSignal`](./signals.md#validatesignal--assertvalidsignal) called explicitly by the consumer | Consumer code | Result object; consumer decides what to do |

What is *not* validated:

- **In-flight payloads on the wire.** Transports serialize and ship JSON as-is. A man-in-the-middle, a flaky relay, or a misconfigured bridge can deliver something that doesn't parse. Consumers must `validateSignal` before trusting anything they receive over a network hop.
- **Reserializing a signal that was already validated.** If you persist a signal to disk and reload it, re-validate on load. `JSON.parse` of a truncated file is happy to hand you a partial object.

**Rule of thumb:** inside a single process, the SDK wrappers are enough. The moment a signal crosses a network boundary, validate on the receiving side.

---

## Delivery semantics

The SDK is deliberately minimal about delivery guarantees — it gives you building blocks, not a distributed queue.

### Sensor → transport (inside `ctx.emit`)

- **Synchronous-looking, actually async.** `ctx.emit(signal)` returns a promise that resolves when the transport has accepted the signal. What "accepted" means depends on the transport:
  - `stdoutTransport` — bytes were handed to `process.stdout.write`.
  - `httpTransport` — a 2xx response came back within the configured retry budget.
  - `kafkaTransport` / `amqpTransport` — the underlying broker client's `send` / `publish` resolved.
  - `batch` — the signal is in the buffer, **not** necessarily flushed.
- **At-most-once from the sensor's perspective.** The sensor calls `ctx.emit` once per signal. Retries, if any, happen inside the transport or wrapping combinators like [`retry()`](./transports.md#retry) — the sensor doesn't loop.
- **Failure is visible.** If `ctx.emit` rejects, the sensor knows the signal did not make it past the transport. Whether to retry depends on the error:
  - `SignalValidationError` → bug; fix code, don't retry
  - `SignalBackpressureError` → pause and retry after `retryAfterMs`
  - anything else → transient; retry with backoff, optionally via `retry()`

### Transport → consumer

This is whatever protocol you chose. Some options:

- **Stdout + pipe** — delivery is whatever the shell gives you. Fine for local dev, nothing else.
- **HTTP POST** — at-least-once if retries are enabled. Duplicates are possible when a 2xx is lost on the way back.
- **Kafka / AMQP with persistent=true** — at-least-once; broker-level guarantees apply.
- **Cloudflare DO relay** (via [`subscribe()`](./consumer.md#subscribe)) — replay via `since` param; at-least-once on reconnect.

**The SDK does not dedupe signals for you downstream.** If you care about exactly-once semantics on the consuming end, dedup on `signal_id` in a small store (Redis, DO KV, a bounded in-memory LRU).

### Inside a consumer

- [`createSignalHandler`](./consumer.md#createsignalhandler) dispatches to every matching pattern in registration order. Exceptions from handlers propagate; if you need fault isolation, wrap handlers yourself.
- [`createSignalQueue`](./consumer.md#createsignalqueue) batches non-urgent signals and can bypass urgent ones. If your process dies mid-batch, anything in `buffer` is gone — call `stop()` from shutdown.

---

## Backpressure

`SignalBackpressureError` is the SDK's signal that **the sensor should pause emission**. It carries an optional `retryAfterMs`.

**Who throws it:** transports (when they detect a 429, a full queue, a paused consumer), or consumer code that has accepted a signal but can't keep up.

**Who handles it:** the sensor, by not calling `ctx.emit` again until the backoff elapses.

Today, none of the built-in transports throw `SignalBackpressureError` on their own — they retry transient errors up to their `retries` budget and then surface the last error. If you build a consumer that *wants* the sensor to slow down, your transport wrapper needs to raise this error explicitly and the sensor's `start()` needs to handle it.

[`retry()`](./transports.md#retry) does **not** special-case backpressure. It retries both backpressure and plain transient errors with the same exponential schedule. If backpressure semantics matter in your system, handle them *outside* `retry()` — typically with a custom transport wrapper that stops retrying once it sees `SignalBackpressureError`.

---

## Dedup and cursor state

Most sensors see the same upstream item more than once — they poll, they receive webhook retries, they reconnect and replay. The SDK's answer is the [`SensorStore`](./state.md#sensorstore) interface: a scoped key-value store that you read before emitting and write after.

Two complementary patterns:

### Cursor (since-id)

Track the highest id / timestamp you've already emitted. Fetch only what's newer.

```ts
const since = Number(await ctx.store!.get("since") ?? 0);
const items = await api.list({ since });
for (const item of items) {
  await ctx.emit(createSignal(this, { event: { /* … */ } }));
}
if (items.length > 0) {
  await ctx.store!.set("since", String(items.at(-1)!.timestamp));
}
```

Pros: O(1) state; O(1) per poll. Cons: if the upstream reorders, you'll miss things that appear "older" after your cursor moved.

### Dedup set (seen-ids)

Keep a bounded set of recently-seen item ids. Skip anything you've seen.

```ts
const items = await api.list();
for (const item of items) {
  if (await ctx.store!.get(`seen:${item.id}`)) continue;
  await ctx.emit(createSignal(this, { event: { /* … */ } }));
  await ctx.store!.set(`seen:${item.id}`, "1");
}
```

Pros: safe under reordering and replay. Cons: grows unboundedly unless the store has eviction ([`MemorySensorStore`](./state.md#memorysensorstore) is LRU; [`FileSensorStore`](./state.md#filesensorstore) is not — prune manually).

### Restart durability

[`MemorySensorStore`](./state.md#memorysensorstore) is fine for dev and for sensors where a cold restart re-emitting the last few items is acceptable. Anywhere else — anywhere your consumer pays a cost per signal — use [`FileSensorStore`](./state.md#filesensorstore). Plugging one in is a one-line swap; see [recipes.md — recipe 3](./recipes.md).

### Key scoping — automatic

When the runner sets up `ctx.store`, it wraps your store so every key is automatically prefixed with `${spec.id}:`. Your sensor writes `"since"`, the backing file sees `"@world2agent/sensor-feishu:since"`. That's why a single `FileSensorStore` can back an entire [`runAll`](./sensor.md#runall) fleet without collisions — it's explicit in [sensor.md → store](./sensor.md#store).

---

## Skill-id routing

A signal carries `source.package` (the sensor's npm package name). Channels and custom bridges that route signals to an AI agent derive a **skill id** from this and inject `Use skill: <id>` into the message so the agent knows which handler to load.

The derivation is fixed and 1:1:

```
@world2agent/sensor-hackernews  →  packageToSkillId(…)  →  world2agent-sensor-hackernews
```

The on-disk SKILL.md at `~/.claude/skills/<id>/SKILL.md` **must** use the same id. If the two drift — someone hand-names a skill dir `hackernews` instead of `world2agent-sensor-hackernews` — the injected directive won't resolve, and the agent silently gets a message with no handler.

Any tool that reads or writes skill dirs MUST go through [`packageToSkillId`](./state.md#packagetoskillid). Don't hand-roll the `@`-strip-and-slash-replace.

---

## Sensor vs. consumer responsibilities

The SDK is split into two halves with a deliberately narrow contract between them.

### A sensor owns

- **What counts as an event.** Deciding that "a file changed" or "a price moved more than 5%" is worth emitting is the sensor's call.
- **Dedup against the upstream.** If the API returns the same item 100 times while you poll, the sensor filters — not the consumer.
- **The `event.summary` quality.** A vague 20-character summary passes validation but delivers no value. This is the sensor's most important output; everything else is metadata.
- **Authentication to the upstream source.** OAuth dances, API keys, token refresh — all sensor-side.
- **Poll interval, webhook endpoint, and similar tuning knobs** — exposed via `configSchema`.

### A consumer owns

- **What to do with a signal once it arrives.** Dispatch, batch, ignore, escalate.
- **Downstream retries and idempotency.** If you feed signals into an LLM and the LLM call fails, that retry lives in the consumer.
- **Authentication to the agent.** The [`ConsumerAuth`](./consumer.md#consumerauth) the sensor spec declares is verified consumer-side (typically in the transport or bridge).
- **Rate-limiting downstream calls.** If your LLM has a 60 req/min cap, batch or queue in the consumer — don't ask the sensor to slow down unless you throw `SignalBackpressureError`.

### Neither owns

- **Durable storage of the stream.** The SDK is not a queue — it has no persistence layer between sensor and consumer. If you need replay / audit / fan-out across processes, put a broker in between (Kafka, NATS, a DO relay).

---

## Versioning

Two versions that move independently:

| Version | Where | Moves when |
|---|---|---|
| Package semver (`@world2agent/sdk@latest`) | `package.json` | Any SDK change — bug fixes, new transports, refactors |
| Wire-format literal (`schema_version: "w2a/0.1"`) | `types.ts` / `schemas.ts` / every emitted signal | Only when `W2ASignal` shape changes in a way that breaks consumers |

A sensor emitting `w2a/0.1` today will still validate on any consumer that supports `w2a/0.1`, regardless of which SDK version either side is on. Don't touch the literal for SDK-only changes — see [signals.md — Versioning note](./README.md#versioning).

---

## Footer nav

- Previous: [← quickstart.md](./quickstart.md)
- Next: [sensor.md →](./sensor.md) (authoring) or [consumer.md →](./consumer.md) (consuming)
- Related: [signals.md](./signals.md) (wire format these guarantees apply to), [recipes.md](./recipes.md) (these concepts made concrete)
