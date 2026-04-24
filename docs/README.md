# World2Agent SDK reference

`@world2agent/sdk` is the TypeScript SDK for building sensors (things that emit signals), consuming signals in your agent, and plugging in custom transports.

## Install

```bash
npm install @world2agent/sdk
# or
pnpm add @world2agent/sdk
```

Engines: Node ≥ 20.

## Reading path

| You are… | Start here |
|---|---|
| New — just want to see a signal fire | [quickstart.md](./quickstart.md) — install → minimal sensor → stdout in ~3 minutes |
| About to build something real | [concepts.md](./concepts.md) — delivery semantics, validation boundaries, dedup strategy, sensor/consumer split |
| Looking up a specific API | The module pages below |
| Copy-pasting a pattern | [recipes.md](./recipes.md) — polling / webhook / durability / multi-sensor / batching |

## Reference by task

| If you want to… | Open |
|---|---|
| Understand the wire format, build a `W2ASignal`, or validate one | [signals.md](./signals.md) |
| Write a sensor (`defineSensor` / `BaseSensor`) and run it | [sensor.md](./sensor.md) |
| Persist cursors or dedup state across restarts | [state.md](./state.md) |
| Consume signals (dispatch by event type, batch, relay subscribe) | [consumer.md](./consumer.md) |
| Deliver signals somewhere (HTTP, Kafka, AMQP, stdout, …) | [transports.md](./transports.md) |
| Unit-test a sensor | [testing.md](./testing.md) |

## Subpath exports

The SDK is a package with multiple entry points. Import the narrowest one you need — it keeps bundle size down and makes intent obvious.

| Import path | Content | Page |
|---|---|---|
| `@world2agent/sdk` | Core types, `createSignal`, `SignalBuilder`, `validateSignal`, errors, `MemorySensorStore`, `FileSensorStore`, `ensureStore`, `apiKeyAuth`, `customAuth`, `startSensor`, `packageToSkillId` | [signals.md](./signals.md), [sensor.md](./sensor.md) |
| `@world2agent/sdk/sensor` | `defineSensor`, `BaseSensor`, `run`, `runAll`, `startSensor`, `MemorySensorStore`, `FileSensorStore`, `ensureStore`, `createPollLoop` | [sensor.md](./sensor.md) |
| `@world2agent/sdk/consumer` | `createSignalHandler`, `createSignalQueue`, `subscribe`, `run`, `runAll`, `startSensor`, `FileSensorStore` | [consumer.md](./consumer.md) |
| `@world2agent/sdk/transports` | `SignalTransport`, all transport factories | [transports.md](./transports.md) |
| `@world2agent/sdk/stores` | `MemorySensorStore`, `FileSensorStore` | [state.md](./state.md) |
| `@world2agent/sdk/schemas` | Zod schemas (`W2ASignalSchema`, `SensorSpecSchema`, `schemas`) | [signals.md](./signals.md#schemas-zod) |
| `@world2agent/sdk/errors` | `SignalValidationError`, `SignalBackpressureError` | [signals.md](./signals.md#errors) |
| `@world2agent/sdk/helpers` | `createPollLoop`, `ensureStore` | [state.md](./state.md#createpollloop) |
| `@world2agent/sdk/testing` | `createTestHarness` | [testing.md](./testing.md) |

`@world2agent/sdk/sensor` and `@world2agent/sdk/consumer` overlap on `run` / `runAll` / `startSensor` / `FileSensorStore` on purpose — import from the side you think like.

## Related docs

- [../README.md](../README.md) — package README with install + quick start.

## Versioning

- Package version in `package.json` — moves with any SDK release (including bug fixes).
- `schema_version: "w2a/0.1"` literal in the `W2ASignal` type — only moves on **wire format** changes that break consumers. Don't touch this for SDK-only changes.
