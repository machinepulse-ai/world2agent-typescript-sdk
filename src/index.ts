// ─── Types ───
export type {
  W2ASignal,
  SourceEvent,
  Attachment,
  InlineAttachment,
  ReferenceAttachment,
  AuthSpec,
  SensorSpec,
  SensorContext,
  SensorStore,
  CleanupFn,
  Logger,
  ConsumerAuth,
  ConsumerIdentity,
  AuthManager,
  MetricsReporter,
} from "./types.js";

// ─── Errors ───
export { SignalValidationError, SignalBackpressureError } from "./errors.js";

// ─── Sensor store ───
export { MemorySensorStore, FileSensorStore } from "./stores/index.js";
export type { FileSensorStoreOptions } from "./stores/index.js";
export { ensureStore } from "./helpers.js";

// ─── Sensor lifecycle (low-level) ───
export { startSensor } from "./run.js";
export type { StartSensorOptions } from "./run.js";

// ─── Consumer auth strategies ───
export { apiKeyAuth, customAuth } from "./consumer-auth.js";

// ─── Signal construction ───
export { createSignal, generateSignalId } from "./create-signal.js";
export type { CreateSignalInput } from "./create-signal.js";
export { SignalBuilder } from "./signal-builder.js";

// ─── Transports ───
export type { SignalTransport } from "./transports.js";

// ─── Validation ───
export { validateSignal, assertValidSignal } from "./validate.js";
export { schemas, W2ASignalSchema, SensorSpecSchema } from "./schemas.js";

// ─── Skill routing ───
export { packageToSkillId } from "./skill-id.js";
