import { randomUUID } from "node:crypto";
import type {
  W2ASignal,
  SensorSpec,
  Attachment,
  SourceEvent,
} from "./types.js";
import { assertValidSignal } from "./validate.js";

/** Generate a UUID v4 signal ID. */
export function generateSignalId(): string {
  return randomUUID();
}

export interface CreateSignalInput {
  event: {
    type: string;
    occurred_at?: number;
    summary: string;
    _meta?: Record<string, unknown>;
  };
  source_event?: SourceEvent;
  attachments?: Attachment[];
  source?: {
    user_identity: string;
  };
  _meta?: Record<string, unknown>;
}

/**
 * Create a fully-formed W2ASignal, auto-filling protocol fields.
 *
 * If `spec` is provided, source fields are filled from the sensor spec.
 * The signal is validated before returning.
 */
export function createSignal(
  spec: Pick<SensorSpec, "id" | "version" | "source_type">,
  input: CreateSignalInput,
): W2ASignal {
  const now = Date.now();

  const signal: W2ASignal = {
    signal_id: generateSignalId(),
    schema_version: "w2a/0.1",
    emitted_at: now,

    source: {
      sensor_id: spec.id,
      sensor_version: spec.version,
      source_type: spec.source_type,
      user_identity: input.source?.user_identity ?? "unknown",
      package: spec.id,
    },

    event: {
      type: input.event.type,
      occurred_at: input.event.occurred_at ?? now,
      summary: input.event.summary,
      ...(input.event._meta !== undefined ? { _meta: input.event._meta } : {}),
    },

    ...(input.source_event !== undefined ? { source_event: input.source_event } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input._meta !== undefined ? { _meta: input._meta } : {}),
  };

  assertValidSignal(signal);
  return signal;
}
