# Recipes

Self-contained scenarios with full code. Each recipe is tagged `[Sensor]`, `[Consumer]`, or `[Both]` — skip the ones that don't match what you're building.

← [Back to index](./README.md)

## Contents

| # | Recipe | Audience |
|---|---|---|
| 1 | [Polling sensor with dedup](#1-polling-sensor-with-dedup) | `[Sensor]` |
| 2 | [Webhook-driven sensor](#2-webhook-driven-sensor) | `[Sensor]` |
| 3 | [Cross-restart durability with FileSensorStore](#3-cross-restart-durability-with-filesensorstore) | `[Sensor]` |
| 4 | [Multi-sensor `runAll` with fanout transport and remote relay](#4-multi-sensor-runall-with-fanout-transport-and-remote-relay) | `[Both]` |
| 5 | [Batching consumer with urgency bypass](#5-batching-consumer-with-urgency-bypass) | `[Consumer]` |

---

## 1. Polling sensor with dedup

**`[Sensor]`** — poll an API every *N* seconds, emit only items you haven't already emitted.

```ts
import { defineSensor, ensureStore } from "@world2agent/sdk/sensor";
import { createSignal } from "@world2agent/sdk";
import { createPollLoop } from "@world2agent/sdk/helpers";
import { z } from "zod";

interface Item {
  id: string;
  title: string;
  author: string;
  score: number;
}

async function fetchTopItems(): Promise<Item[]> {
  const res = await fetch("https://api.example.com/top");
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

export default defineSensor({
  id: "@example/sensor-top-items",
  version: "0.1.0",
  source_type: "example",
  auth: { type: "none" },
  configSchema: z.object({
    interval_seconds: z.number().int().positive().default(60),
    min_score: z.number().int().nonnegative().default(0),
  }),

  async start(ctx) {
    const store = ensureStore(ctx);

    const { cleanup } = createPollLoop({
      items: [null],                              // single poll target — the API itself
      intervalSeconds: ctx.config.interval_seconds,
      logger: ctx.logger,
      poll: async () => {
        const items = await fetchTopItems();
        for (const item of items) {
          if (item.score < ctx.config.min_score) continue;

          // Dedup: skip items we've already emitted
          const key = `seen:${item.id}`;
          if (await store.get(key)) continue;

          await ctx.emit(createSignal(this, {
            event: {
              type: "example.item.created",
              summary: `${item.author} posted "${item.title}" (score ${item.score})`,
            },
          }));

          await store.set(key, "1");
        }
      },
    });

    return cleanup;
  },
});
```

**Key points**

- [`createPollLoop`](./state.md#createpollloop) runs the poll immediately, then on `intervalSeconds` ticks. Errors go to `logger.error`; the loop keeps running.
- [`ensureStore(ctx)`](./state.md#ensurestore) returns `ctx.store` if the runner supplied one, otherwise a fresh process-local `MemorySensorStore` — sensor code stays the same either way.
- The dedup set grows unboundedly. For high-cardinality streams, pair with [`MemorySensorStore`](./state.md#memorysensorstore)'s LRU — but be aware that LRU eviction means an old item can re-emit if it's seen after being evicted. For restart-durable sensors, see [recipe 3](#3-cross-restart-durability-with-filesensorstore).
- When the runner does pass a store, it's auto-scoped with `${spec.id}:` — your `seen:abc123` lands as `@example/sensor-top-items:seen:abc123` in the backing store, so one `FileSensorStore` can back many sensors safely.

---

## 2. Webhook-driven sensor

**`[Sensor]`** — run an HTTP server, turn each incoming webhook into a signal.

```ts
import { defineSensor } from "@world2agent/sdk/sensor";
import { createSignal } from "@world2agent/sdk";
import { createServer } from "node:http";
import { z } from "zod";

export default defineSensor({
  id: "@example/sensor-webhook",
  version: "0.1.0",
  source_type: "example-webhook",
  auth: {
    type: "api_key",
    fields: [
      { name: "webhook_secret", label: "Webhook Secret", sensitive: true },
    ],
  },
  configSchema: z.object({
    webhook_secret: z.string().min(1),
    listen_port: z.number().int().positive().default(8787),
  }),

  async start(ctx) {
    const { webhook_secret, listen_port } = ctx.config;

    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/hook") {
        res.writeHead(404).end();
        return;
      }
      if (req.headers["x-webhook-secret"] !== webhook_secret) {
        res.writeHead(401).end();
        return;
      }

      try {
        const body = await readJsonBody(req);
        await ctx.emit(createSignal(this, {
          event: {
            type: "example.webhook.received",
            summary: `Webhook received from ${body.sender ?? "unknown"}: ${body.title ?? "(no title)"}`,
          },
          source_event: {
            schema: { type: "object" },
            data: body,
          },
        }));
        res.writeHead(204).end();
      } catch (err) {
        ctx.logger.error("webhook handler failed", err);
        res.writeHead(500).end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen_port, () => {
        ctx.logger.info(`listening on :${listen_port}`);
        resolve();
      });
    });

    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  },
});

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}
```

**Key points**

- Webhook validation (HMAC, IP allowlist, etc.) is the sensor's job — the SDK doesn't know about your upstream's auth scheme.
- If the upstream retries a delivery (non-2xx from your server), you'll get the same event twice. Dedup on `body.id` with `ctx.store` exactly like [recipe 1](#1-polling-sensor-with-dedup), or make the downstream idempotent.
- For long-lived signals, stash the full webhook body in `source_event.data` — consumers that understand the upstream format can read it directly.

---

## 3. Cross-restart durability with FileSensorStore

**`[Sensor]`** — keep dedup state alive across process restarts.

The change from [recipe 1](#1-polling-sensor-with-dedup) is a **one-line swap** at the runner — the sensor code doesn't change.

```ts
// run.ts
import { run } from "@world2agent/sdk/sensor";
import { FileSensorStore } from "@world2agent/sdk";
import topItems from "./my-sensor.js";

await run(topItems, {
  config: { interval_seconds: 60, min_score: 50 },
  store: new FileSensorStore({
    // Default: ~/.world2agent/state.json
    // Override if you want per-project state:
    path: `${process.env.HOME}/.my-agent/state.json`,
  }),
});
```

What you just did:

- Every `store.set("seen:abc", "1")` now writes through to disk (tmp-file + rename) before returning — `ensureStore(ctx)` hands back the scoped `FileSensorStore` the runner injected.
- On the next restart, the sensor re-hydrates its dedup set from disk — no re-flood.

**Gotchas**

- **Don't share one file across parallel sessions.** Two processes writing the same path will race. Either give each process its own `path`, or use a store backend with proper concurrency (Redis, DO KV) — see [state.md — FileSensorStore concurrency](./state.md#concurrency).
- **High-write sensors:** set `writeDebounceMs: 500` to coalesce writes, and **call `flush()` from your shutdown handler** or you'll lose the last few writes on a hard crash.

```ts
const store = new FileSensorStore({ writeDebounceMs: 500 });

process.on("SIGINT", async () => {
  await store.flush();
  process.exit(0);
});
```

- **Corrupt file:** the store logs a warning and starts empty rather than crashing — a flood of re-seen items is the trade-off. See [state.md — Corruption tolerance](./state.md#corruption-tolerance).

---

## 4. Multi-sensor `runAll` with fanout transport and remote relay

**`[Both]`** — one process runs several local sensors **and** subscribes to a remote relay channel; signals fan out to both stdout and an HTTP hub.

```ts
// orchestrator.ts
import { runAll } from "@world2agent/sdk/sensor";
import {
  fanout,
  httpTransport,
  stdoutTransport,
  retry,
} from "@world2agent/sdk/transports";
import { FileSensorStore } from "@world2agent/sdk";

import feishu from "@world2agent/sensor-feishu";
import gcal from "@world2agent/sensor-gcal";
import webWatcher from "@world2agent/sensor-web-watcher";

const transport = fanout([
  stdoutTransport(),                             // for local tailing
  retry(                                         // retry HTTP 3× with backoff
    httpTransport({
      url: "https://hub.example.com/api/signals",
      headers: { Authorization: `Bearer ${process.env.HUB_TOKEN}` },
    }),
    { maxRetries: 3, backoff: 1000 },
  ),
]);

const store = new FileSensorStore({
  path: `${process.env.HOME}/.my-agent/state.json`,
});

await runAll([
  { spec: feishu, config: {
      app_id: process.env.FEISHU_APP_ID!,
      app_secret: process.env.FEISHU_APP_SECRET!,
    }},
  { spec: gcal,   config: { client_id: process.env.GCAL_CLIENT_ID! } },
  { spec: webWatcher },

  // Remote relay — signals from another team's sensor farm
  { remote: "wss://relay.example.com/channels/stock-alerts",
    apiKey: process.env.RELAY_TOKEN,
    since:  Date.now() - 24 * 60 * 60 * 1000 },   // replay last 24h on startup
], {
  onSignal: transport,
  store,
});
```

**Key points**

- [`runAll`](./sensor.md#runall) treats local `{ spec }` entries and remote `{ remote }` entries uniformly — the resulting `CleanupFn` covers both.
- The shared `store` is auto-scoped per-sensor id by `startSensor`, so `feishu`'s `cursor` and `gcal`'s `cursor` never collide.
- [`fanout`](./transports.md#fanout) is `Promise.all` — if any branch rejects, the whole emit rejects. Wrap fragile branches in [`retry`](./transports.md#retry) (as shown) or [`filter`](./transports.md#filter) them away.
- One SIGINT cleans up every sensor + every relay subscription + the shared store in parallel. See [sensor.md — `runAll`](./sensor.md#runall).

---

## 5. Batching consumer with urgency bypass

**`[Consumer]`** — feed most signals to an LLM in batches (to save tokens), but route alerts / mentions to a separate immediate-response path.

```ts
// consumer.ts
import { createSignalHandler, createSignalQueue } from "@world2agent/sdk/consumer";
import type { W2ASignal } from "@world2agent/sdk";

async function askAgentNow(signal: W2ASignal) {
  // call Claude with one signal — used for urgent cases
  // await claude.messages.create({ messages: [...] });
}

async function askAgentWithContext(signals: W2ASignal[]) {
  // call Claude with a batch — save tokens when nothing is urgent
  // await claude.messages.create({ messages: [...] });
}

const isUrgent = (s: W2ASignal): boolean =>
  s.event.type.startsWith("alert.") ||
  s.event.type === "messaging.message.mentioned";

const queue = createSignalQueue({
  immediate: isUrgent,
  onImmediate: askAgentNow,
  batch: {
    maxSize: 20,
    maxWaitMs: 30_000,
    onFlush: askAgentWithContext,
  },
});

// Drain on shutdown — anything still buffered is lost otherwise
process.on("SIGINT", async () => {
  await queue.stop();
  process.exit(0);
});

// Pair with a pattern-matching handler if you also want type-dispatch:
const handler = createSignalHandler();
handler.on("code.pipeline.failed", async (s) => { /* page oncall */ });
handler.on("*", (s) => queue.push(s));

// Feed from your transport (local sensor) or subscribe() (remote relay):
export async function onSignal(signal: W2ASignal) {
  await handler.handle(signal);
}
```

**Key points**

- [`createSignalQueue`](./consumer.md#createsignalqueue) routes urgent signals to `onImmediate` and batches everything else. The `immediate` predicate runs on every push, so keep it cheap.
- The handler + queue compose: the handler dispatches first (by event type), and any handler can decide to push to the queue instead of acting directly.
- `maxWaitMs` is measured from the first pending signal, not sliding — a burst of signals flushes together even if they kept arriving.
- **Don't forget `stop()`.** On clean shutdown the queue flushes; on `kill -9` it doesn't. If your signals are expensive-but-replayable, that's fine. If they're not, persist before batching.

---

## Footer nav

- Previous: [← testing.md](./testing.md) (one path) or [← transports.md](./transports.md)
- Jump: [Back to index](./README.md)
- Related: [concepts.md — Delivery semantics](./concepts.md#delivery-semantics), [concepts.md — Dedup and cursor state](./concepts.md#dedup-and-cursor-state)
