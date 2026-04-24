# @world2agent/sdk

Core SDK for [World2Agent](https://github.com/machinepulse-ai/world2agent) — an open protocol that connects the world to AI agents.

Use this package to build sensors (emit signals), consume signals (handle them in your agent), or plug in custom transports.

## Install

```bash
npm install @world2agent/sdk
```

## Reference

Full docs live in [`docs/`](./docs/README.md):

- [`quickstart.md`](./docs/quickstart.md) — install to running sensor in ~3 minutes.
- [`concepts.md`](./docs/concepts.md) — delivery semantics, validation boundaries, dedup strategy.
- Module reference — [`signals`](./docs/signals.md), [`sensor`](./docs/sensor.md), [`state`](./docs/state.md), [`consumer`](./docs/consumer.md), [`transports`](./docs/transports.md), [`testing`](./docs/testing.md).
- [`recipes.md`](./docs/recipes.md) — polling, webhook, durability, multi-sensor, batching.

## Entry points

| Import | What it gives you |
|---|---|
| `@world2agent/sdk` | Shared types (`W2ASignal`, `SensorSpec`, `Attachment`, `SourceEvent`, …), signal construction (`createSignal`), validation (`validateSignal`), and error classes. |
| `@world2agent/sdk/sensor` | `defineSensor`, `run`, `runAll` — author and run sensors. |
| `@world2agent/sdk/consumer` | `createSignalHandler` — type-safe dispatch by `event.type`. |
| `@world2agent/sdk/transports` | `stdoutTransport`, `httpTransport`, `fanout` — outbound delivery. |
| `@world2agent/sdk/stores` | `MemorySensorStore`, `FileSensorStore` — state backends for sensors. |
| `@world2agent/sdk/schemas` | Zod schemas for signals and sensor specs. |
| `@world2agent/sdk/testing` | Test doubles and helpers for sensor development. |
| `@world2agent/sdk/errors` | `SignalValidationError`, `SignalBackpressureError`. |
| `@world2agent/sdk/helpers` | `createPollLoop`, `ensureStore`, and friends for sensor authors. |

## Build a sensor

```ts
import { defineSensor } from "@world2agent/sdk/sensor";
import { createSignal } from "@world2agent/sdk";
import { z } from "zod";

export default defineSensor({
  id: "@world2agent/sensor-example",
  version: "0.1.0",
  source_type: "example",
  auth: { type: "api_key", fields: [{ name: "token", label: "API Token", sensitive: true }] },
  configSchema: z.object({ token: z.string() }),

  async start(ctx) {
    const timer = setInterval(async () => {
      const signal = createSignal(this, {
        event: {
          type: "example.item.created",
          summary: "Example item created by Alice in project X; urgent priority",
        },
      });
      await ctx.emit(signal);
    }, 60_000);
    return () => clearInterval(timer);
  },
});
```

## Consume signals

```ts
import { run } from "@world2agent/sdk/sensor";
import { createSignalHandler } from "@world2agent/sdk/consumer";
import example from "@world2agent/sensor-example";

const handler = createSignalHandler();
handler.on("example.item.created", async (signal) => {
  console.log(signal.event.summary);
});

await run(example, {
  config: { token: process.env.EXAMPLE_TOKEN! },
  onSignal: (s) => handler.handle(s),
});
```

## Signal shape

See the [protocol reference](https://github.com/machinepulse-ai/world2agent#signal-format) for the full `W2ASignal` schema.

## License

Apache-2.0
