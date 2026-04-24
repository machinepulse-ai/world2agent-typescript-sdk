# @world2agent/sdk — agent guide

This package is the **TypeScript SDK** that sensors and consumers import. It is *not* the protocol spec. Keep those two concepts separate when making changes.

- **Wire format & manifest** — lives at <https://github.com/machinepulse-ai/world2agent> and is intentionally language-agnostic (no `Logger`, no `Store`, no `SensorContext`, no functions). Future non-TS SDKs consume the schema directly. **Don't leak SDK ergonomics into the schema repo.**
- **This package** — TypeScript-only runtime helpers (`createSignal`, transports, `SensorContext`, test harness, poll loop). Anything purely TypeScript-shaped belongs here.

The `W2ASignal` interface in `src/types.ts` and the matching Zod schema in `src/schemas.ts` are the **one place** where the two worlds meet. If you change either, change the other in the same commit, and coordinate with every downstream sensor package that constructs signals by hand.

## Directory layout

```
src/
  index.ts            # main barrel — types + validation + sensor spec + signal construction
  types.ts            # W2ASignal, SensorSpec, SensorContext, Attachment, ConsumerAuth, …
  schemas.ts          # Zod schemas for W2ASignal + SensorSpec (re-exported via ./schemas)
  validate.ts         # validateSignal (result-based) + assertValidSignal (throws)
  errors.ts           # SignalValidationError, SignalBackpressureError
  create-signal.ts    # createSignal() — the primary construction API
  signal-builder.ts   # SignalBuilder class for conditional construction
  skill-id.ts         # packageToSkillId — npm package name → on-disk skill id
  stores/index.ts     # barrel re-exporting both store implementations
  stores/memory.ts    # MemorySensorStore (LRU)
  stores/file.ts      # FileSensorStore (JSON file, tmp+rename atomicity, optional debounce)
  consumer-auth.ts    # apiKeyAuth, customAuth
  helpers.ts          # createPollLoop (most sensors use this)
  base-sensor.ts      # class-based sensor base
  define-sensor.ts    # functional sensor factory (preferred)
  run.ts              # startSensor / run / runAll — the lifecycle glue
  transports.ts       # stdout, http, kafka, amqp, + combinators
  sensor/index.ts     # subpath barrel for sensor authors
  consumer/index.ts   # subpath barrel for signal consumers
  consumer/subscribe.ts       # WebSocket relay subscription
  consumer/signal-handler.ts  # pattern-matching dispatcher
  consumer/signal-queue.ts    # batching queue with urgency bypass
  testing/index.ts    # createTestHarness — in-memory mock SensorContext
```

Every public export has a test covering it. Tests live in `test/`, mirroring the `src/` layout (`src/transports.ts` → `test/transports.test.ts`, `src/consumer/subscribe.ts` → `test/consumer/subscribe.test.ts`). `tsconfig.json`'s `include: ["src"]` keeps tests out of the build structurally — they simply aren't visible to `tsc --build`. Don't move them back under `src/` or that guarantee goes away.

User-facing API reference lives in `docs/` (split by module: signals, sensor, state, consumer, transports, testing). Keep it in sync when you change public signatures — the tests are the floor, the docs are how humans learn the surface.

## Subpath exports are hand-maintained

`package.json` → `exports` enumerates every subpath. When you add a new top-level module intended for external consumption:

1. Add it to `exports` with both `types` and `default` pointing at the built `dist/…`.
2. Mirror it in the `sensor/` or `consumer/` barrel if it's an ergonomic helper for those audiences.

If a new symbol is only used internally, do not add a subpath — keep the surface small.

## Testing

```bash
pnpm test         # one-shot
pnpm test:watch   # watch mode
```

Conventions:

- Vitest, tests in `test/` mirroring `src/` layout. Import the code under test as `../src/…` or `../../src/…/…` depending on the subdir depth.
- Fake timers (`vi.useFakeTimers()` + `advanceTimersByTimeAsync`) for anything that calls `setInterval` / `setTimeout`. See `helpers.test.ts` and the `batch` / `signal-queue` tests.
- Stub `fetch` and `WebSocket` via `vi.stubGlobal` — the SDK uses the runtime globals directly, not an injected client. See `transports.test.ts` and `consumer/subscribe.test.ts`.
- For `FileSensorStore`, create a real temp dir with `mkdtempSync(join(tmpdir(), …))` and clean up with `rmSync(…, { recursive: true, force: true })` in `afterEach`. Tests that need `homedir()` to point at a temp dir should `vi.stubEnv("HOME", home)`.
- **Anything touching `process.on("SIGINT"…)` is out of scope for unit tests.** `run()` and `runAll()` install signal handlers and `process.exit(0)` on shutdown — test the pure core (`startSensor`) instead.

## Known behavior quirks

- **`httpTransport` fails fast on 4xx.** 4xx responses throw immediately without retrying (permanent failures). Only network errors and 5xx responses are retried, with exponential backoff. If you change this policy, update `transports.test.ts` in the same commit.
- **`createSignal` emits `source.user_identity: "unknown"` when the caller doesn't provide one.** Downstream consumers MAY rely on this string — don't change the default without a protocol version bump.
- **`FileSensorStore` is single-writer.** Don't share one state file across parallel processes; a corrupt/unreadable file is tolerated (treated as empty) and a warning is logged to stderr.
- **`packageToSkillId` must be used by every tool that writes `~/.claude/skills/<id>/`.** Drift between the id on disk and the `Use skill: <id>` directive breaks message routing silently.

## Publishing

- `pnpm publish` or `npm publish`. `prepublishOnly` already chains `clean` + `build`.
- Bump the version in `package.json`; the `schema_version` literal in `types.ts` / `schemas.ts` only moves on wire-format changes, not SDK releases.
- Downstream sensor packages depend on this SDK. Breaking changes require a coordinated bump — make sure every sensor you know about can move in lockstep before cutting the release.

## When adding a new transport

1. Drop a factory in `transports.ts` that returns a `SignalTransport`.
2. Write a test that stubs its external dep (`fetch`, a producer/channel object, etc.) and asserts the serialized payload shape.
3. If it needs env-var auto-detection, extend `autoTransport()` in `transports.ts`. It's the single source of truth — `run()` / `runAll()` call into it as their `onSignal` fallback. Keep the env-var surface small (one URL today); anything needing auth, retries, or fanout belongs in user code.
