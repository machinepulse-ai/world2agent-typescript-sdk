# Signals

The `W2ASignal` is the wire format that flows from sensors to consumers.

← [Back to index](./README.md)

```ts
import {
  type W2ASignal,
  type Attachment,
  type InlineAttachment,
  type ReferenceAttachment,
  type SourceEvent,
  createSignal,
  generateSignalId,
  SignalBuilder,
  validateSignal,
  assertValidSignal,
  SignalValidationError,
  SignalBackpressureError,
} from "@world2agent/sdk";

// Or, if you only need the Zod schemas:
import { W2ASignalSchema, SensorSpecSchema, schemas } from "@world2agent/sdk/schemas";
```

## Contents

| Section | Purpose |
|---|---|
| [W2ASignal](#w2asignal) | The wire format — fields, required invariants |
| [Attachments](#attachments) | `InlineAttachment` vs `ReferenceAttachment` |
| [SourceEvent](#sourceevent) | Self-describing upstream payload |
| [createSignal](#createsignal) | Primary construction API |
| [SignalBuilder](#signalbuilder) | Chainable alternative for conditional construction |
| [generateSignalId](#generatesignalid) | UUID v4 factory |
| [validateSignal / assertValidSignal](#validatesignal--assertvalidsignal) | Runtime validation |
| [Schemas (Zod)](#schemas-zod) | Raw Zod schemas for custom pipelines |
| [Errors](#errors) | `SignalValidationError`, `SignalBackpressureError` |

---

## W2ASignal

```ts
interface W2ASignal {
  signal_id: string;                // UUID v4, unique per signal
  schema_version: "w2a/0.1";        // protocol version literal
  emitted_at: number;               // ms since epoch, when the sensor produced this

  source: {
    sensor_id: string;              // npm package name, e.g. "@world2agent/sensor-feishu"
    sensor_version: string;         // sensor semver
    source_type: string;            // logical source, e.g. "feishu", "github", "cron"
    user_identity: string;          // user on the source platform
    package: string;                // same as sensor_id — channels use this to derive the skill id
  };

  event: {
    type: string;                   // "domain.entity.action" taxonomy
    occurred_at: number;            // ms since epoch, when the event happened upstream
    summary: string;                // natural language, ≥ 20 chars — "[Actor] [Action] [Object] in [Context]; [Impact]"
    _meta?: Record<string, unknown>;
  };

  source_event?: SourceEvent;       // raw upstream payload + JSON Schema
  attachments?: Attachment[];       // ≤ 1MB total, serialized
  _meta?: Record<string, unknown>;
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `signal_id` | `string` | yes | UUID v4. Unique per signal; used for dedup, tracing, relay replay. |
| `schema_version` | `"w2a/0.1"` | yes | Exact literal. Change only on wire-format breaking changes. |
| `emitted_at` | `number` | yes | Ms since epoch. Positive integer, not a float, not seconds. |
| `source.sensor_id` | `string` | yes | Non-empty. npm package name, e.g. `"@world2agent/sensor-feishu"`. |
| `source.sensor_version` | `string` | yes | Non-empty. Sensor semver. |
| `source.source_type` | `string` | yes | Non-empty. Logical source, e.g. `"feishu"`, `"github"`, `"cron"`. |
| `source.user_identity` | `string` | yes | Non-empty. Identity on the source platform. Defaults to `"unknown"` if not supplied to [`createSignal`](#createsignal). |
| `source.package` | `string` | yes | Non-empty. Same as `sensor_id` by convention — channels derive the skill id from it. |
| `event.type` | `string` | yes | Non-empty. `"domain.entity.action"` taxonomy (see [concepts.md](./concepts.md)). |
| `event.occurred_at` | `number` | yes | Ms since epoch, positive integer. When the upstream event happened. |
| `event.summary` | `string` | yes | **≥ 20 characters.** Pattern: `[Actor] [Action] [Object] in [Context]; [Impact]`. Short/vague summaries fail validation. |
| `event._meta` | `Record<string, unknown>` | no | Implementation-specific metadata under `event`. |
| `source_event` | [`SourceEvent`](#sourceevent) | no | Raw upstream payload + JSON Schema describing it. |
| `attachments` | `Attachment[]` | no | Serialized size ≤ 1 MB total. Each item's `description` must be non-empty. |
| `_meta` | `Record<string, unknown>` | no | Top-level metadata (tracing, experimentation). |

If any of these invariants fails, [`assertValidSignal`](#validatesignal--assertvalidsignal) throws [`SignalValidationError`](#errors). The sensor lifecycle ([`defineSensor`](./sensor.md#definesensor), [`BaseSensor`](./sensor.md#basesensor), [`startSensor`](./sensor.md#startsensor)) wraps every `ctx.emit()` with this check, so broken signals never leave a sensor.

---

## Attachments

Attachments carry the concrete content behind a signal — message text, file contents, diffs, images, documents.

```ts
type Attachment = InlineAttachment | ReferenceAttachment;

interface InlineAttachment {
  type: "inline";
  mime_type: string;
  description: string;
  data: string;
  _meta?: Record<string, unknown>;
}

interface ReferenceAttachment {
  type: "reference";
  mime_type: string;
  description: string;
  uri: string;
  _meta?: Record<string, unknown>;
}
```

### Fields — common to both variants

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"inline" \| "reference"` | yes | Discriminator. Drives the rest of the shape. |
| `mime_type` | `string` | yes | Non-empty. RFC 6838 mime type, e.g. `"text/plain"`, `"image/png"`, `"application/json"`. |
| `description` | `string` | yes | Non-empty. A human-readable caption — tells the consumer (or agent) what they're looking at before opening it. |
| `_meta` | `Record<string, unknown>` | no | Implementation-specific metadata. |

### `InlineAttachment` extra field

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | `string` | yes | The content itself — UTF-8 for text, base64 for binary. Counts against the 1 MB budget after `JSON.stringify`. |

### `ReferenceAttachment` extra field

| Field | Type | Required | Description |
|---|---|---|---|
| `uri` | `string` | yes | Non-empty. URL or URI the consumer can fetch. Authentication and lifetime are the sensor's problem — document expectations in `description` or `_meta`. |

**When to use which**

- **Inline** — content is small (< 100 KB), already in hand, and expensive or impossible to refetch. Chat messages, computed diffs, truncated log excerpts.
- **Reference** — content is large or authoritative at the source. Uploaded files, images in Drive, commits on GitHub.

The 1 MB cap is on the serialized `attachments` array (all items summed, after `JSON.stringify`). Inline base64 blobs burn through it fast — prefer `reference` for anything image-sized or larger.

---

## SourceEvent

Self-describing upstream event data.

```ts
interface SourceEvent {
  schema: Record<string, unknown>;  // JSON Schema draft-07 describing `data`
  data: Record<string, unknown>;    // the raw upstream payload
  _meta?: Record<string, unknown>;
}
```

This is the original event emitted by the upstream system, unchanged. It's not the W2A `event` summary — that's a normalized, agent-friendly view. Consumers that know the upstream format can pull from `source_event.data` for full fidelity; everything else reads `event.summary`.

---

## createSignal

```ts
function createSignal(
  spec: Pick<SensorSpec, "id" | "version" | "source_type">,
  input: CreateSignalInput,
): W2ASignal;

interface CreateSignalInput {
  event: {
    type: string;
    occurred_at?: number;   // defaults to Date.now()
    summary: string;
    _meta?: Record<string, unknown>;
  };
  source_event?: SourceEvent;
  attachments?: Attachment[];
  source?: { user_identity: string };
  _meta?: Record<string, unknown>;
}
```

Primary signal construction API. Auto-fills:

- `signal_id` via [`generateSignalId()`](#generatesignalid)
- `schema_version: "w2a/0.1"`
- `emitted_at` via `Date.now()`
- `source.sensor_id` / `sensor_version` / `source_type` / `package` from `spec`
- `source.user_identity` defaults to `"unknown"` unless you pass `input.source.user_identity`
- `event.occurred_at` defaults to `Date.now()` unless you pass it
- Empty `attachments` arrays are dropped from the output (not serialized as `[]`)

Returns a fully-validated `W2ASignal`. If validation fails (e.g. summary too short), it throws [`SignalValidationError`](#errors) — you never get a broken signal back.

```ts
const signal = createSignal(this, {
  event: {
    type: "messaging.message.mentioned",
    summary: "Alice mentioned Bob in #general and asked about the Q3 roadmap",
  },
  source: { user_identity: "u_bob" },
});
```

Inside a sensor's `start()`, `this` is the `SensorSpec` (see [sensor.md](./sensor.md#this-binding-inside-start)), so `createSignal(this, …)` is the idiomatic form.

---

## SignalBuilder

Chainable alternative. Use it when fields are added conditionally; otherwise prefer [`createSignal`](#createsignal).

```ts
class SignalBuilder {
  source(
    sensorId: string,
    sensorVersion: string,
    sourceType: string,
    userIdentity: string,
    pkg?: string,       // defaults to sensorId
  ): this;
  event(
    type: string,
    opts: { summary: string; occurred_at?: number; _meta?: Record<string, unknown> },
  ): this;
  sourceEvent(sourceEvent: SourceEvent): this;
  attachment(item: Attachment): this;   // append, can be called multiple times
  meta(meta: Record<string, unknown>): this;
  build(): W2ASignal;                   // throws if source/event not set; validates
}
```

```ts
import { SignalBuilder } from "@world2agent/sdk";

const b = new SignalBuilder()
  .source("@world2agent/sensor-feishu", "0.1.0", "feishu", "u_bob")
  .event("messaging.message.mentioned", {
    summary: "Alice mentioned Bob in #general and asked about the Q3 roadmap",
  });

if (includeDiff) {
  b.attachment({
    type: "inline",
    mime_type: "text/x-diff",
    description: "code diff attached to the message",
    data: diffText,
  });
}

const signal = b.build();
```

`build()` throws plain `Error("SignalBuilder: source is required")` / `"event is required"` if those methods weren't called, then runs the same validation as `createSignal`.

---

## generateSignalId

```ts
function generateSignalId(): string;
```

UUID v4 factory backed by `node:crypto`'s `randomUUID()`. You rarely need to call this directly — both `createSignal` and `SignalBuilder.build()` do.

---

## validateSignal / assertValidSignal

```ts
function validateSignal(signal: unknown): ValidationResult;
function assertValidSignal(signal: unknown): asserts signal is W2ASignal;

interface ValidationResult {
  success: boolean;
  errors?: Array<{ path: string; message: string }>;
}
```

Two flavors of the same check against [`W2ASignalSchema`](#schemas-zod):

- `validateSignal` — returns a result object. Use when you want to log / aggregate errors without a try/catch.
- `assertValidSignal` — throws [`SignalValidationError`](#errors) with all issues attached. Use on hot paths where an invalid signal is a bug, not data.

```ts
const result = validateSignal(maybeSignal);
if (!result.success) {
  for (const { path, message } of result.errors!) {
    console.error(`  ${path}: ${message}`);
  }
}

// vs
assertValidSignal(maybeSignal);     // throws SignalValidationError on failure
// from here on, `maybeSignal` is narrowed to W2ASignal
```

The sensor lifecycle wraps `ctx.emit` with `assertValidSignal` automatically, so in most sensor code you don't call either of these by hand.

---

## Schemas (Zod)

```ts
import { W2ASignalSchema, SensorSpecSchema, schemas } from "@world2agent/sdk/schemas";
```

Exposes the raw Zod schemas used internally. `schemas` is a convenience object with both:

```ts
const schemas = {
  W2ASignal: W2ASignalSchema,
  SensorSpec: SensorSpecSchema,
} as const;
```

Use these when you need to plug validation into something non-standard — a custom relay, an OpenAPI pipeline, a contract test. For everyday sensor work, [`validateSignal`](#validatesignal--assertvalidsignal) is the right API.

---

## Errors

```ts
import { SignalValidationError, SignalBackpressureError } from "@world2agent/sdk/errors";
```

### SignalValidationError

```ts
class SignalValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
}
```

Thrown by `assertValidSignal`, `createSignal`, `SignalBuilder.build()`, and the wrapped `ctx.emit()` that `defineSensor` / `BaseSensor` / `startSensor` install.

**Not retryable.** If you catch this, the sensor or downstream code is buggy — the signal shape violates the protocol. Fix the code, don't retry.

`issues` carries every individual Zod failure so you can pin-point what's wrong.

### SignalBackpressureError

```ts
class SignalBackpressureError extends Error {
  readonly retryAfterMs?: number;
}
```

Thrown by transports or consumers when the downstream is temporarily overloaded. The sensor should **pause emission** and try again after `retryAfterMs` (if set) or an exponential backoff of its own.

The SDK does not throw this itself — transports are expected to raise it when they detect 429s, full queues, etc. [`retry()`](./transports.md#retry) does not special-case it; it retries alongside every other non-validation error.

---

## Footer nav

- Next: [sensor.md →](./sensor.md)
- Related: [transports.md](./transports.md) (where signals go), [testing.md](./testing.md) (asserting on emitted signals)
