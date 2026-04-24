# Sensor authoring & lifecycle

A sensor is a module that watches an upstream system and calls `ctx.emit(signal)` when something happens. The SDK gives you the scaffolding: a spec format, a lifecycle runner, and a wrapped `emit` that validates every signal on the way out.

← [Back to index](./README.md)

```ts
import {
  defineSensor,
  BaseSensor,
  run,
  runAll,
  startSensor,
} from "@world2agent/sdk/sensor";

import type {
  SensorSpec,
  SensorContext,
  CleanupFn,
  AuthSpec,
  ConsumerAuth,
  Logger,
  AuthManager,
  MetricsReporter,
} from "@world2agent/sdk";
```

## Contents

| Section | Purpose |
|---|---|
| [Sensor lifecycle in one paragraph](#sensor-lifecycle-in-one-paragraph) | The mental model |
| [defineSensor](#definesensor) | Functional sensor factory (preferred) |
| [BaseSensor](#basesensor) | Class-based alternative for stateful sensors |
| [SensorSpec](#sensorspec) | The frozen spec object |
| [SensorContext](#sensorcontext) | What `start()` receives |
| [AuthSpec](#authspec) | Declaring what credentials your sensor needs |
| [startSensor](#startsensor) | Low-level lifecycle entry point |
| [run](#run) | Single-sensor standalone runner |
| [runAll](#runall) | Multi-sensor runner with shared transport/store |
| [Config resolution from env vars](#config-resolution-from-env-vars) | How `W2A_*` variables become `ctx.config` |

---

## Sensor lifecycle in one paragraph

You declare a sensor as a `SensorSpec` via [`defineSensor`](#definesensor) or a subclass of [`BaseSensor`](#basesensor). You run it with [`startSensor`](#startsensor), [`run`](#run), or [`runAll`](#runall). The runner validates config against `configSchema`, builds a [`SensorContext`](#sensorcontext), and calls `spec.start(ctx)`. Your `start()` sets up listeners/timers/subscriptions, emits signals through `ctx.emit(...)`, and returns a [`CleanupFn`](#sensorcontext) the runner calls on shutdown.

`ctx.emit` is wrapped with [`assertValidSignal`](./signals.md#validatesignal--assertvalidsignal) by the runner, so broken signals never reach the transport.

---

## defineSensor

```ts
function defineSensor<TConfig = Record<string, unknown>>(
  input: DefineSensorInput<TConfig>,
): SensorSpec<TConfig>;

interface DefineSensorInput<TConfig> {
  id: string;                               // npm package name
  version: string;
  source_type: string;
  auth: AuthSpec;
  configSchema?: z.ZodType<TConfig>;
  consumerAuth?: ConsumerAuth;
  start(
    this: SensorSpec<TConfig>,              // `this` is bound to the spec
    ctx: SensorContext<TConfig>,
  ): Promise<CleanupFn>;
}
```

Preferred sensor factory. Validates the spec **at definition time** (missing fields fail immediately, not on first run), wraps `ctx.emit` with signal validation, and returns a **frozen** `SensorSpec`.

```ts
import { defineSensor } from "@world2agent/sdk/sensor";
import { createSignal } from "@world2agent/sdk";
import { z } from "zod";

export default defineSensor({
  id: "@world2agent/sensor-example",
  version: "0.1.0",
  source_type: "example",
  auth: {
    type: "api_key",
    fields: [{ name: "token", label: "API Token", sensitive: true }],
  },
  configSchema: z.object({ token: z.string() }),

  async start(ctx) {
    const timer = setInterval(async () => {
      await ctx.emit(createSignal(this, {
        event: {
          type: "example.item.created",
          summary: "Example item created by Alice in project X; urgent priority",
        },
      }));
    }, 60_000);
    return () => clearInterval(timer);
  },
});
```

### `this` binding inside start()

Inside `start(ctx)`, `this` is the `SensorSpec` — which is exactly the shape [`createSignal`](./signals.md#createsignal) needs for its first argument. So `createSignal(this, …)` just works without wiring up any sensor metadata by hand.

---

## BaseSensor

```ts
abstract class BaseSensor<TConfig = Record<string, unknown>>
  implements SensorSpec<TConfig>
{
  abstract id: string;
  abstract version: string;
  abstract source_type: string;
  abstract auth: AuthSpec;
  configSchema?: z.ZodType<TConfig>;
  consumerAuth?: ConsumerAuth;

  abstract start(ctx: SensorContext<TConfig>): Promise<CleanupFn>;

  protected createSignal(input: CreateSignalInput): W2ASignal;
  protected wrapContext(ctx: SensorContext<TConfig>): SensorContext<TConfig>;
  validate(): void;
}
```

Class-based alternative. Use when the sensor has non-trivial internal state that benefits from being a class (fields, helper methods, inheritance). For simple cases, [`defineSensor`](#definesensor) is shorter.

- `this.createSignal(input)` — like [`createSignal(this, input)`](./signals.md#createsignal) but with `this` pre-bound.
- `this.wrapContext(ctx)` — returns a new context whose `emit` is wrapped with [`assertValidSignal`](./signals.md#validatesignal--assertvalidsignal). Call it from your own `start()` if you don't go through [`startSensor`](#startsensor) / [`run`](#run), which already wrap for you.
- `this.validate()` — runs `SensorSpecSchema.parse(this)`. Handy in unit tests.

```ts
import { BaseSensor } from "@world2agent/sdk/sensor";

class CronSensor extends BaseSensor<{ jobs: Array<{ cron: string }> }> {
  id = "@world2agent/sensor-cron";
  version = "0.1.0";
  source_type = "cron";
  auth = { type: "none" } as const;

  async start(ctx: SensorContext<{ jobs: Array<{ cron: string }> }>) {
    const cleanups = ctx.config.jobs.map((job) => scheduleCron(job.cron, () => {
      ctx.emit(this.createSignal({
        event: {
          type: "cron.job.fired",
          summary: `Cron job ${job.cron} fired at ${new Date().toISOString()}`,
        },
      }));
    }));
    return async () => cleanups.forEach((fn) => fn());
  }
}
```

---

## SensorSpec

```ts
interface SensorSpec<TConfig = Record<string, unknown>> {
  id: string;
  version: string;
  source_type: string;
  auth: AuthSpec;
  configSchema?: z.ZodType<TConfig>;
  consumerAuth?: ConsumerAuth;
  start(ctx: SensorContext<TConfig>): Promise<CleanupFn>;
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Non-empty. npm package name (e.g. `"@world2agent/sensor-feishu"`). Also used as the key prefix for `ctx.store` and as the source of the channel skill id via [`packageToSkillId`](./state.md#packagetoskillid). |
| `version` | `string` | yes | Non-empty. Sensor semver. Emitted as `source.sensor_version` on every signal. |
| `source_type` | `string` | yes | Non-empty. Logical upstream identifier — `"feishu"`, `"github"`, `"cron"`. Consumers pattern-match on it. |
| `auth` | [`AuthSpec`](#authspec) | yes | Declares what credentials the sensor needs. Drives env-var lookup for config (see [Config resolution from env vars](#config-resolution-from-env-vars)) and what the installer asks the user. |
| `configSchema` | `z.ZodType<TConfig>` | no | If set, [`startSensor`](#startsensor) runs `configSchema.parse(rawConfig)` before constructing the context. Zod coercion applies (`z.coerce.number()` etc.). |
| `consumerAuth` | [`ConsumerAuth`](./consumer.md#consumerauth) | no | If set, transports/bridges forwarding this sensor's signals MUST verify consumers against this strategy. |
| `start` | `(ctx) => Promise<CleanupFn>` | yes | Sets up listeners, timers, subscriptions; emits via `ctx.emit`. Returns a cleanup function that stops everything. Called once per lifecycle. |

The return type of [`defineSensor`](#definesensor) and the implementation shape of [`BaseSensor`](#basesensor). A sensor package's default export is a `SensorSpec`.

---

## SensorContext

What your `start()` receives.

```ts
interface SensorContext<TConfig = Record<string, unknown>> {
  config: TConfig;
  logger: Logger;
  emit(signal: W2ASignal): Promise<void>;
  reportHealth(status: "ok" | "degraded" | "error", detail?: string): void;
  store?: SensorStore;
  auth?: AuthManager;
  metrics?: MetricsReporter;
}

type CleanupFn = () => Promise<void> | void;

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
```

### Fields

| Field | Type | Supplied by runner? | Description |
|---|---|---|---|
| `config` | `TConfig` | yes, always | Result of `configSchema.parse(rawConfig)` when a schema is set; otherwise the raw input. See [Config resolution from env vars](#config-resolution-from-env-vars). |
| `logger` | `Logger` | yes, always | Defaults to `console`. In [`runAll`](#runall) each sensor gets a prefixed logger keyed on a short form of `spec.id`. |
| `emit` | `(W2ASignal) => Promise<void>` | yes, always | Wrapped with [`assertValidSignal`](./signals.md#validatesignal--assertvalidsignal) by the runner. Resolves when the transport has accepted the signal. See rejection semantics below. |
| `reportHealth` | `(status, detail?) => void` | yes, always | Records a health event. Default wiring routes `"error"` → `logger.error`, others → `logger.info`. |
| `store` | [`SensorStore`](./state.md#sensorstore) | optional | **Auto-scoped** with `${spec.id}:` prefix. Use for cursors and dedup state — see [concepts.md — Dedup and cursor state](./concepts.md#dedup-and-cursor-state). Absent if no runner passes one. |
| `auth` | `AuthManager` | optional | OAuth token manager with `getAccessToken()` / `invalidateToken()`. Built-in runners do not set this; a custom runner can. |
| `metrics` | `MetricsReporter` | optional | `counter` / `gauge` / `histogram`. Built-in runners do not set this; a custom runner can. |

### `emit`

Validates the signal against [`W2ASignalSchema`](./signals.md#schemas-zod) before handing it to the transport. Rejection semantics:

- `SignalValidationError` — the signal is malformed. **Don't retry.** Fix the code.
- `SignalBackpressureError` — downstream is overloaded. Pause and retry after `retryAfterMs`.
- Any other error — transient. Retry with backoff.

### `reportHealth`

Wired through the logger by default ([`startSensor`](#startsensor) routes `"error"` to `logger.error`, others to `logger.info`). Custom runners can attach their own handlers — e.g. a health dashboard.

### `store`

Optional — `undefined` unless the runner was given a `store` in [`StartSensorOptions`](#startsensor) / [`RunOptions`](#run) / [`RunAllOptions`](#runall). When provided, it's a [`SensorStore`](./state.md#sensorstore) auto-scoped with the sensor's id as a prefix, so two sensors with the same key names don't collide.

If your sensor needs state, call [`ensureStore(ctx)`](./state.md#ensurestore) at the top of `start()` to get a guaranteed non-null store — it falls back to an in-memory instance when the runner didn't supply one. That way sensor code doesn't care whether the consumer opted into persistence.

### `auth` / `metrics`

Optional injection points for OAuth token managers and metrics reporters. The built-in runners don't set these; custom runners can.

---

## AuthSpec

Declares what credentials your sensor needs, so the installer can prompt the user and the runner can resolve env vars.

```ts
type AuthSpec =
  | { type: "none" }
  | {
      type: "api_key";
      fields: Array<{ name: string; label: string; sensitive: boolean }>;
    }
  | {
      type: "oauth2";
      provider: string;
      scopes: string[];
      tokenUrl: string;
      authUrl: string;
    };
```

### Variants

#### `{ type: "none" }`

No credentials required. Use for sensors that read public data (RSS, public stock tickers, cron) or receive webhooks with a shared secret passed in `configSchema`.

#### `{ type: "api_key", fields: [...] }`

| Field | Type | Description |
|---|---|---|
| `fields[].name` | `string` | Becomes the config key (e.g. `app_id`) **and** the `W2A_<NAME>` env var read by [config resolution](#config-resolution-from-env-vars). |
| `fields[].label` | `string` | Human-readable prompt shown by the installer. |
| `fields[].sensitive` | `boolean` | `true` — installer masks the input and never prints the value in logs. |

#### `{ type: "oauth2", provider, scopes, tokenUrl, authUrl }`

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | Identifier — `"google"`, `"feishu"`, `"github"`. Consumed by the installer / bridge. |
| `scopes` | `string[]` | OAuth scopes to request. |
| `tokenUrl` | `string` | OAuth token endpoint. |
| `authUrl` | `string` | OAuth authorize endpoint. |

**Declarative only.** The SDK does not run the OAuth dance — that lives in the channel / installer / a sensor-specific flow. The resulting access token is surfaced to `start()` via `ctx.auth` (if the runner provides an `AuthManager`) or as plain config.

---

## startSensor

```ts
function startSensor<TConfig>(
  spec: SensorSpec<TConfig>,
  options?: StartSensorOptions<TConfig>,
): Promise<CleanupFn>;

interface StartSensorOptions<TConfig> {
  config?: TConfig;           // falls back to env vars
  onSignal?: SignalTransport; // default: JSON to stdout
  store?: SensorStore;        // default: none — ctx.store is undefined unless supplied (auto-scoped when provided)
  logger?: Logger;            // default: console
  logEmits?: boolean;         // default: false
}
```

Low-level lifecycle entry. **Does not install process signal handlers** — the caller owns shutdown. This is the shared core that [`run`](#run), [`runAll`](#runall), and custom lifecycle managers (e.g. channels that track per-sensor cleanups in a map so they can stop/restart individual sensors mid-session) all build on.

Responsibilities:

- If `spec.configSchema` is set, parses `config` through it (throws Zod errors on failure).
- Auto-scopes `store` with `${spec.id}:` so sensor keys can't collide.
- Wraps `onSignal` into a `ctx.emit` that logs per-signal when `logEmits=true`.
- Wires `ctx.reportHealth` through the logger.
- Returns whatever `CleanupFn` the sensor returns.

```ts
const cleanup = await startSensor(mySensor, {
  config: { token: process.env.MY_TOKEN! },
  onSignal: myTransport,
  logger: prefixedLogger("my-sensor"),
});
// …later:
await cleanup();
```

---

## run

```ts
function run<TConfig>(
  spec: SensorSpec<TConfig>,
  options?: RunOptions<TConfig>,
): Promise<CleanupFn>;

interface RunOptions<TConfig> {
  config?: TConfig;
  onSignal?: SignalTransport;
  store?: SensorStore;
}
```

Thin wrapper around [`startSensor`](#startsensor) that also:

- Installs SIGINT/SIGTERM handlers for graceful shutdown + `process.exit(0)`.
- Defaults `onSignal` via [`autoTransport()`](./transports.md#autotransport-and-w2a_transport_url) — `W2A_TRANSPORT_URL` picks HTTP, unset picks stdout.
- Prints `${spec.id}@${spec.version} running. Press Ctrl+C to stop.`

For a sensor entrypoint in its own bin script, `run()` is what you call.

---

## runAll

```ts
function runAll(
  entries: RunAllEntry[],
  options?: RunAllOptions,
): Promise<CleanupFn>;

type RunAllEntry = SensorEntry | RemoteEntry;

interface SensorEntry {
  spec: SensorSpec<any>;
  config?: Record<string, unknown>;
}

interface RemoteEntry {
  remote: string;   // wss:// URL of a relay channel
  apiKey?: string;
  since?: number;   // replay from this ms timestamp
}

interface RunAllOptions {
  onSignal?: SignalTransport;
  store?: SensorStore;
}
```

Runs multiple sensors in one process, plus subscribes to remote relay channels, with a shared transport/store. Key behaviors:

- Everything starts concurrently (`Promise.allSettled`).
- Per-sensor prefixed logger so output from `feishu` vs `gcal` is distinguishable.
- Shared `store` is passed through to each sensor — [`startSensor`](#startsensor) auto-prefixes keys per sensor id, so one `FileSensorStore` backs them all without collisions.
- A single SIGINT/SIGTERM handler cleans up every sensor in parallel.
- Failed sensors don't bring the others down — failures are logged, successful sensors keep running.
- Remote entries are routed through [`subscribe`](./consumer.md#subscribe).

```ts
import { runAll } from "@world2agent/sdk/sensor";
import { fanout, httpTransport, stdoutTransport } from "@world2agent/sdk/transports";
import feishu from "@world2agent/sensor-feishu";
import gcal from "@world2agent/sensor-gcal";
import webWatcher from "@world2agent/sensor-web-watcher";

await runAll([
  { spec: feishu,     config: { app_id: "...", app_secret: "..." } },
  { spec: gcal,       config: { client_id: "..." } },
  { spec: webWatcher },
  { remote: "wss://relay.example.com/channels/stock-alerts", apiKey: "sk-abc" },
], {
  onSignal: fanout([
    stdoutTransport(),
    httpTransport({ url: "https://hub.example.com/api/signals" }),
  ]),
});
```

---

## Config resolution from env vars

When [`startSensor`](#startsensor) / [`run`](#run) is called without an explicit `config`, the SDK assembles one from the environment.

**Rules, in order**

1. If `spec.auth.type === "api_key"`, each `field.name` is looked up as `W2A_<NAME_UPPERCASED>` and set on the config.
2. Every other `W2A_*` env var (except those starting with `W2A_TRANSPORT_`, which are reserved for transport config) becomes a lowercased config key. `W2A_CRON_JOBS` → `jobs` keyed from `CRON_JOBS`? No — it's a flat lowercase: `W2A_JOBS` → `jobs`.
3. If a value looks like JSON (starts with `[` or `{` and ends accordingly), it's parsed; otherwise it stays a string.
4. Auth fields win over generic `W2A_*` vars with the same derived name.

Reserved prefix: **`W2A_TRANSPORT_*`** never lands in config. Those are reserved for [`autoTransport`](./transports.md#autotransport-and-w2a_transport_url).

```bash
# For a sensor with auth.fields = [{ name: "app_id", ... }, { name: "app_secret", ... }]
W2A_APP_ID=cli_abc
W2A_APP_SECRET=sk_xyz

# Generic config:
W2A_JOBS='[{"name":"a","cron":"* * * * *"}]'   # parsed to an array
W2A_POLL_INTERVAL=60                            # stays a string

# Transport (not exposed to sensor config):
W2A_TRANSPORT_URL=https://hub.example.com/api/signals
```

If you pass `config` explicitly, **env vars are ignored** — it's one or the other.

---

## Footer nav

- Previous: [← signals.md](./signals.md)
- Next: [state.md →](./state.md)
- Related: [transports.md](./transports.md) (where `ctx.emit` goes), [testing.md](./testing.md) (how to unit-test your sensor)
