# State & polling utilities

Runtime utilities a sensor's `start()` routinely reaches for: a scoped key/value store for cursors and dedup sets, a fixed-interval poll helper, and the one-line rule that maps an npm package name to a channel skill id.

← [Back to index](./README.md)

```ts
import {
  MemorySensorStore,
  FileSensorStore,
  type FileSensorStoreOptions,
  ensureStore,
  packageToSkillId,
  type SensorStore,
} from "@world2agent/sdk";

import { createPollLoop } from "@world2agent/sdk/helpers";
```

## Contents

| Section | Purpose |
|---|---|
| [SensorStore interface](#sensorstore) | The contract a store must satisfy |
| [MemorySensorStore](#memorysensorstore) | In-memory LRU; ephemeral |
| [FileSensorStore](#filesensorstore) | JSON file; survives restarts |
| [ensureStore](#ensurestore) | Fall back to an in-memory store when the runner didn't supply one |
| [createPollLoop](#createpollloop) | Fixed-interval polling with immediate first tick |
| [packageToSkillId](#packagetoskillid) | npm package → skill-id convention |

---

## SensorStore

```ts
interface SensorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### Methods

| Method | Returns | Description |
|---|---|---|
| `get(key)` | `Promise<string \| null>` | `null` for missing keys (distinguishable from an empty-string value). |
| `set(key, value)` | `Promise<void>` | Resolves once the write is durable by the backend's definition (in-memory for `MemorySensorStore`, on-disk for write-through `FileSensorStore`, buffered if debounced). |
| `delete(key)` | `Promise<void>` | Idempotent — deleting a missing key does not throw. |

The minimum contract a store must satisfy. When a store is passed to [`startSensor` / `run` / `runAll`](./sensor.md#startsensor), the runner wraps it so every key is automatically prefixed with `${sensor.id}:` before it hits the backing store. Sensor code reads/writes plain keys like `"cursor"`; the backing store sees `"@world2agent/sensor-feishu:cursor"`.

That scoping is why one `FileSensorStore` can safely serve many sensors in a [`runAll`](./sensor.md#runall) setup.

**Typical uses in a sensor**

- Cursor / since-id for incremental polling.
- Dedup set of recent item ids ("have I emitted this already?").
- Last-known-state snapshot for diffing.

Values are strings — serialize JSON yourself if you need structure.

---

## MemorySensorStore

```ts
class MemorySensorStore implements SensorStore {
  constructor(maxEntries?: number /* default: 1024 */);
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Process-local LRU. Evicts the least-recently-used key when `maxEntries` is exceeded. Touching a key with `get` or re-`set` refreshes its position.

**Use when**

- You're developing or testing.
- The sensor can tolerate a cold start re-emitting items it already saw.

**Don't use when**

- Restart-proof dedup matters. Use [`FileSensorStore`](#filesensorstore) instead — otherwise you'll flood consumers with previously-seen items every time the sensor process restarts.

```ts
import { MemorySensorStore } from "@world2agent/sdk";
const store = new MemorySensorStore(4096);
```

---

## FileSensorStore

```ts
class FileSensorStore implements SensorStore {
  constructor(options?: FileSensorStoreOptions);
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  flush(): Promise<void>;
}

interface FileSensorStoreOptions {
  path?: string;
  writeDebounceMs?: number;
}
```

### Constructor options

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `~/.world2agent/state.json` | JSON file backing this store. Parent directory is created on first write. |
| `writeDebounceMs` | `number` | `0` | `0` = write-through (`set`/`delete` returns after disk write). `>0` = coalesce writes within the window into one file rewrite; **call `flush()` on shutdown** to avoid losing buffered writes. |

### Extra method

| Method | Returns | Description |
|---|---|---|
| `flush()` | `Promise<void>` | Force any pending debounced write to happen immediately. No-op when `writeDebounceMs === 0` or buffer is clean. |

JSON-file-backed store. The whole store is serialized to a single file; on first access it hydrates into an in-memory mirror, subsequent reads are in-memory, writes update the mirror and atomically rewrite the file via tmp + `rename`.

### Debounce

- `writeDebounceMs: 0` (default) — **write-through**. Every `set` / `delete` returns only after the file has been updated. Safest; noisiest.
- `writeDebounceMs > 0` — writes are coalesced. Subsequent `set`s within the window all land in one file rewrite. **Call `flush()` from your shutdown handler** to avoid losing the last few writes on a hard crash.

### Concurrency

Single-writer. Two processes writing the same file can overwrite each other's changes — **don't share one file across parallel processes.** Either give each process its own `path`, or use a different backend.

### Corruption tolerance

If the file is missing, unreadable, or malformed JSON, the store starts empty and logs a warning to `console.error`. A corrupt file never prevents a sensor from starting — a flood of previously-seen items is the expected (and surfaced) consequence.

```ts
import { runAll } from "@world2agent/sdk/sensor";
import { FileSensorStore } from "@world2agent/sdk";

await runAll(entries, {
  store: new FileSensorStore({
    path: `${process.env.HOME}/.my-agent/state.json`,
    writeDebounceMs: 500,
  }),
});
```

---

## ensureStore

```ts
function ensureStore(ctx: { store?: SensorStore }): SensorStore;
```

Return `ctx.store` when the [runner](./sensor.md#startsensor) supplied one, otherwise a fresh process-local [`MemorySensorStore`](#memorysensorstore). Call once at the top of `start()` and reuse the result — calling it twice returns different instances when no store was injected.

Use this so sensor code can read and write state unconditionally, instead of sprinkling `ctx.store?.` checks or `!` non-null assertions (which lie — by default `ctx.store` is `undefined`).

```ts
import { defineSensor, ensureStore } from "@world2agent/sdk/sensor";

export default defineSensor({
  // ...
  async start(ctx) {
    const store = ensureStore(ctx);
    if (await store.get("seen:" + id)) return;
    await store.set("seen:" + id, "1");
  },
});
```

**Semantics**

- When the runner injected a store, it's already auto-scoped with the sensor's id prefix — sharing one backing `FileSensorStore` across many sensors is safe.
- The fallback is un-scoped because the sensor owns it entirely; no one else writes to it.
- The fallback is ephemeral — if you need restart-proof dedup, the *consumer* has to pass a `FileSensorStore` (or other persistent backend) at `run` / `runAll` time. Sensor code doesn't change.

---

## createPollLoop

```ts
function createPollLoop<T>(opts: PollLoopOptions<T>): { cleanup: CleanupFn };

interface PollLoopOptions<T> {
  items: T[];
  intervalSeconds: number;
  poll: (item: T) => Promise<void>;
  logger?: Logger;
}
```

Fixed-interval polling helper used by most sensors. For each item:

1. Runs `poll(item)` **immediately** (fire-and-forget; errors go to `logger.error`).
2. Schedules a `setInterval(intervalSeconds * 1000)` that calls `poll(item)` on every tick.

Returns a `cleanup` that clears all timers. `cleanup` is idempotent.

```ts
import { createPollLoop } from "@world2agent/sdk/helpers";
import { defineSensor } from "@world2agent/sdk/sensor";

export default defineSensor<{ urls: string[]; interval_seconds: number }>({
  id: "@world2agent/sensor-web-watcher",
  version: "0.1.0",
  source_type: "web",
  auth: { type: "none" },

  async start(ctx) {
    const { cleanup } = createPollLoop({
      items: ctx.config.urls,
      intervalSeconds: ctx.config.interval_seconds,
      poll: async (url) => {
        // fetch, compare to stored hash in ctx.store, emit if changed
      },
      logger: ctx.logger,
    });
    return cleanup;
  },
});
```

**Semantics**

- Items are polled **concurrently** on the same tick — each has its own `setInterval`, all scheduled from `start()`. If you need serial polling, roll your own loop.
- Poll errors are swallowed and logged. They never cancel the loop. If you want to stop on error, handle it inside `poll`.
- `items: []` is a no-op — the returned `cleanup` is still valid.

---

## packageToSkillId

```ts
function packageToSkillId(pkg: string): string;
```

Deterministic 1-to-1 mapping from an npm package name to a filesystem- and skill-router-safe skill identifier.

**Rule:** strip leading `@`, replace every `/` with `-`.

```ts
packageToSkillId("@world2agent/sensor-hackernews");
// → "world2agent-sensor-hackernews"

packageToSkillId("my-sensor");
// → "my-sensor" (unscoped packages pass through)

packageToSkillId("@scope/pkg/sub");
// → "scope-pkg-sub" (every slash, not just the first)
```

**Why this exists**

Channels and bridges derive the handler skill id from the signal's `source.package` via this function and inject `Use skill: <id>` into the message. Any tool that writes SKILL.md files to `~/.claude/skills/<id>/` **must** use this same function, or the on-disk path and the injected directive drift and messages silently fail to route.

Treat this as the single source of truth for the convention — don't hand-roll the replacement.

---

## Footer nav

- Previous: [← sensor.md](./sensor.md)
- Next: [consumer.md →](./consumer.md)
- Related: [sensor.md — `SensorContext.store`](./sensor.md#store) (how a store gets plumbed to your sensor)
