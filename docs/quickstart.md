# Quickstart

~3 minutes from install to a running sensor printing signals to stdout.

← [Back to index](./README.md)

## 1 · Install

```bash
pnpm add @world2agent/sdk zod
# or: npm install @world2agent/sdk zod
```

Needs Node ≥ 20. `zod` is a peer dependency used for config schemas — you can omit it if you don't use `configSchema`.

## 2 · Write a sensor

```ts
// my-sensor.ts
import { defineSensor } from "@world2agent/sdk/sensor";
import { createSignal } from "@world2agent/sdk";

export default defineSensor({
  id: "@example/hello-sensor",
  version: "0.1.0",
  source_type: "hello",
  auth: { type: "none" },

  async start(ctx) {
    const timer = setInterval(() => {
      ctx.emit(createSignal(this, {
        event: {
          type: "hello.tick.emitted",
          summary: "Hello sensor emitted a tick; just keeping the channel alive",
        },
      }));
    }, 2_000);

    return () => clearInterval(timer);
  },
});
```

What this is doing:

- `defineSensor` validates the spec at load time — missing fields fail immediately.
- `ctx.emit` is wrapped by the SDK with `assertValidSignal`, so if you build a malformed signal it throws `SignalValidationError` and never leaves the sensor.
- `createSignal(this, …)` auto-fills `signal_id`, `schema_version`, `emitted_at`, and the `source.*` fields from the sensor spec. You only supply what's unique to each signal.
- The cleanup function the SDK gets back is how `Ctrl+C` stops you without leaking a timer.

## 3 · Run it

```ts
// run.ts
import { run } from "@world2agent/sdk/sensor";
import sensor from "./my-sensor.js";

await run(sensor);
```

```bash
tsx run.ts
```

You'll see:

```
@example/hello-sensor@0.1.0 running. Press Ctrl+C to stop.
{
  "signal_id": "…uuid…",
  "schema_version": "w2a/0.1",
  "emitted_at": 1730000000000,
  "source": { "sensor_id": "@example/hello-sensor", "sensor_version": "0.1.0", … },
  "event": { "type": "hello.tick.emitted", "occurred_at": 1730000000000, "summary": "Hello sensor emitted a tick; just keeping the channel alive" }
}
```

One JSON object per line by default — pipe it into `jq`, a file, or any line-oriented tool.

## 4 · Point it somewhere

If `W2A_TRANSPORT_URL` is set, `run()` POSTs each signal to that URL. Otherwise it writes to stdout.

```bash
# POST each signal as JSON to an unauthenticated hub:
W2A_TRANSPORT_URL=https://hub.example.com/api/signals tsx run.ts
```

That's the full env-var surface — one URL, no auth, no retries. For auth headers, retries, batching, multi-target fanout, or any non-HTTP transport (Kafka, AMQP, …), pass `onSignal` explicitly; see [transports.md](./transports.md).

---

## What's next?

| Goal | Read |
|---|---|
| Understand what the SDK guarantees and doesn't (delivery semantics, validation, backpressure) | [concepts.md](./concepts.md) |
| Full sensor authoring surface (`defineSensor`, `BaseSensor`, `runAll`, env-var config) | [sensor.md](./sensor.md) |
| Real patterns — polling with dedup, webhooks, cross-restart state, multi-sensor, batching | [recipes.md](./recipes.md) |
| Unit-test your sensor | [testing.md](./testing.md) |

## Footer nav

- Next: [concepts.md →](./concepts.md)
- Jump to: [Back to index](./README.md)
