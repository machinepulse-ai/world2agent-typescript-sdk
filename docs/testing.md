# Testing sensors

`createTestHarness` is the SDK's in-memory mock `SensorContext`. It lets you unit-test a sensor without spinning up a real transport, filesystem, OAuth flow, or process lifecycle.

← [Back to index](./README.md)

```ts
import { createTestHarness, type TestHarness, type LogEntry, type HealthEntry } from "@world2agent/sdk/testing";
```

## Contents

| Section | Purpose |
|---|---|
| [createTestHarness](#createtestharness) | Factory |
| [TestHarness API](#testharness-api) | Start/stop, inspect emitted signals/logs/health |
| [Recommended patterns](#recommended-patterns) | Fake timers, stubbing fetch, fixtures |
| [Limits](#limits) | What the harness doesn't simulate |

---

## createTestHarness

```ts
function createTestHarness<TConfig = Record<string, unknown>>(
  spec: SensorSpec<TConfig>,
  options: {
    config: TConfig;
    store?: SensorStore;
    auth?: AuthManager;
    metrics?: MetricsReporter;
  },
): TestHarness;
```

Build a harness around an existing `SensorSpec`. The harness provides a mock `SensorContext` whose:

- `emit(signal)` pushes to an in-memory array.
- `logger.{info,warn,error,debug}` push to an in-memory log array.
- `reportHealth(status, detail)` pushes to a health array.
- `store` defaults to a fresh [`MemorySensorStore`](./state.md#memorysensorstore); override to plug in a [`FileSensorStore`](./state.md#filesensorstore) or a stubbed store for dedup tests.
- `auth` / `metrics` are pass-through — whatever you provide is what the sensor sees.

**The harness does not wrap `emit` with validation.** That wrapping happens in [`defineSensor`](./sensor.md#definesensor) / [`BaseSensor`](./sensor.md#basesensor). So if you call `createTestHarness(defineSensor({...}))`, invalid signals will still throw. If you hand-build a `SensorSpec` for tests, validation is on you.

---

## TestHarness API

```ts
interface TestHarness {
  start(): Promise<void>;
  stop(): Promise<void>;

  emitted(): readonly W2ASignal[];
  logs(): readonly LogEntry[];
  healthHistory(): readonly HealthEntry[];
  health(): HealthEntry | undefined;   // latest, or undefined

  isValid(signal: W2ASignal): boolean;
  reset(): void;
}

interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  args: unknown[];
  timestamp: Date;
}

interface HealthEntry {
  status: "ok" | "degraded" | "error";
  detail?: string;
  timestamp: Date;
}
```

- `start()` — calls `spec.start(ctx)`. Throws `"TestHarness: already started"` if called twice without a `stop()` in between.
- `stop()` — calls the cleanup returned by `start()`. Throws `"TestHarness: not started"` if called before `start()`.
- `emitted()` / `logs()` / `healthHistory()` — live views onto the mock context's collected state. The arrays are updated as the sensor runs; calling these after `await` resolves gives you everything observed up to that point.
- `health()` — convenience for `healthHistory().at(-1)`.
- `isValid(signal)` — passes the signal through [`validateSignal`](./signals.md#validatesignal--assertvalidsignal). Handy for asserting that test-constructed signals are well-formed before asserting equality on other fields.
- `reset()` — clears emitted signals, logs, and health. Does **not** stop the sensor; use between phases of a long test.

---

## Recommended patterns

### Fake timers for poll-based sensors

Most sensors use [`createPollLoop`](./state.md#createpollloop), which schedules `setInterval`s. Drive them with `vi.useFakeTimers()`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@world2agent/sdk/testing";
import mySensor from "./index.js";

describe("my sensor", () => {
  it("emits one signal per tick", async () => {
    vi.useFakeTimers();
    const h = createTestHarness(mySensor, {
      config: { interval_seconds: 60, /* ... */ },
    });

    await h.start();
    await vi.advanceTimersByTimeAsync(0);       // let the immediate tick flush
    expect(h.emitted()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);  // one more tick
    expect(h.emitted()).toHaveLength(2);

    await h.stop();
    vi.useRealTimers();
  });
});
```

### Stubbing fetch

Sensors that hit upstream APIs use the global `fetch`. Stub it with `vi.stubGlobal`:

```ts
vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ items: [...] }), { status: 200 }),
));
```

Reset between tests with `vi.unstubAllGlobals()` in `afterEach`.

### Asserting on signal shape

Prefer `toMatchObject` over `toEqual` for signals — it lets you assert on the fields that matter without being thrown off by `signal_id`, `emitted_at`, etc.

```ts
expect(h.emitted()[0]).toMatchObject({
  source: { source_type: "example" },
  event: {
    type: "example.item.created",
    summary: expect.stringContaining("Alice"),
  },
});
```

To pin a deterministic `signal_id` / timestamp, use `vi.setSystemTime` and `vi.spyOn(crypto, "randomUUID")` — but usually the shape match is enough.

### Plugging in a real `FileSensorStore`

When you want to test dedup across restarts, hand the harness a `FileSensorStore` pointed at a temp dir:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSensorStore } from "@world2agent/sdk";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sensor-test-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const h = createTestHarness(mySensor, {
  config: { /* ... */ },
  store: new FileSensorStore({ path: join(tmp, "state.json") }),
});
```

To simulate a restart, `stop()` the harness and build a fresh one over the **same path**.

---

## Limits

The harness stops at the sensor boundary. It doesn't simulate:

- **Transports.** `ctx.emit` just appends to an array. If you care about end-to-end delivery, test your transport separately with mocked upstreams.
- **Process lifecycle.** `run()` / `runAll()` install SIGINT handlers and call `process.exit(0)`; those aren't unit-testable and the harness side-steps them.
- **`configSchema` parsing.** `startSensor` runs `spec.configSchema?.parse(config)` before building `ctx`. The harness skips that — it passes `options.config` through as-is. If you want to test schema coercion, call `spec.configSchema!.parse(rawConfig)` explicitly first.
- **Scoped store prefix.** The harness exposes `options.store` directly. In production, [`startSensor`](./sensor.md#startsensor) wraps it with a `${sensor.id}:` prefix. If your sensor assumes scoped keys, either replicate the prefix in your test store or accept that the test exercises the pre-scoped interface.

For integration-level testing (real transport, real scoped store), run the sensor under [`startSensor`](./sensor.md#startsensor) and provide fakes at the `onSignal` / `store` layer instead.

---

## Footer nav

- Previous: [← transports.md](./transports.md)
- Related: [sensor.md](./sensor.md) (the spec under test), [state.md — `createPollLoop`](./state.md#createpollloop) (the timer you'll fake out)
