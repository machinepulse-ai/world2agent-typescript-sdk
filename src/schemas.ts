import { z } from "zod";

// ─── Attachments ───

const metaSchema = z.record(z.unknown());

const inlineAttachmentSchema = z.object({
  type: z.literal("inline"),
  mime_type: z.string().min(1),
  description: z.string().min(1, "description must be non-empty"),
  data: z.string(),
  _meta: metaSchema.optional(),
});

const referenceAttachmentSchema = z.object({
  type: z.literal("reference"),
  mime_type: z.string().min(1),
  description: z.string().min(1, "description must be non-empty"),
  uri: z.string().min(1),
  _meta: metaSchema.optional(),
});

const attachmentSchema = z.discriminatedUnion("type", [
  inlineAttachmentSchema,
  referenceAttachmentSchema,
]);

// ─── Source event ───

const sourceEventSchema = z.object({
  schema: z.record(z.unknown()).refine(
    (s) => typeof s === "object" && s !== null,
    "source_event.schema must be a valid JSON Schema draft-07 object",
  ),
  data: z.record(z.unknown()),
  _meta: metaSchema.optional(),
});

// ─── Signal ───

export const W2ASignalSchema = z.object({
  signal_id: z.string().uuid("signal_id must be a valid UUID v4"),
  schema_version: z.literal("w2a/0.1"),
  emitted_at: z.number().int().positive(),

  source: z.object({
    sensor_id: z.string().min(1),
    sensor_version: z.string().min(1),
    source_type: z.string().min(1),
    user_identity: z.string().min(1),
    package: z.string().min(1, "source.package is required (npm package name of the sensor)"),
  }),

  event: z.object({
    type: z.string().min(1),
    occurred_at: z.number().int().positive(),
    summary: z.string().min(20, "summary must be >= 20 characters — a vague summary has no value"),
    _meta: metaSchema.optional(),
  }),

  source_event: sourceEventSchema.optional(),

  attachments: z
    .array(attachmentSchema)
    .refine(
      (attachments) => JSON.stringify(attachments).length <= 1_048_576,
      "attachments total size must be <= 1MB",
    )
    .optional(),

  _meta: metaSchema.optional(),
});

// ─── SensorSpec ───

const authSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("oauth2"),
    provider: z.string(),
    scopes: z.array(z.string()),
    tokenUrl: z.string(),
    authUrl: z.string(),
  }),
  z.object({
    type: z.literal("api_key"),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        sensitive: z.boolean(),
      }),
    ),
  }),
  z.object({ type: z.literal("none") }),
]);

export const SensorSpecSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  source_type: z.string().min(1),
  auth: authSpecSchema,
  configSchema: z.any().optional(),
  consumerAuth: z
    .object({
      required: z.boolean(),
      verify: z.function(),
    })
    .optional(),
  start: z.function(),
});

export const schemas = {
  W2ASignal: W2ASignalSchema,
  SensorSpec: SensorSpecSchema,
} as const;
