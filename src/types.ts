import type { z } from "zod";

// ─── Signal format ───

/**
 * World2Agent signal — the unified wire format carried across sensors,
 * transports, and consumers.
 */
export interface W2ASignal {
  /** Unique identifier for deduplication and tracing. UUID v4. */
  signal_id: string;
  /** Protocol version. Currently fixed at `"w2a/0.1"`. */
  schema_version: "w2a/0.1";
  /** When the signal was emitted, UTC timestamp in milliseconds. */
  emitted_at: number;

  source: {
    /** npm package name of the sensor, e.g. `"@world2agent/sensor-feishu"`. */
    sensor_id: string;
    /** Sensor semver version. */
    sensor_version: string;
    /** Logical source identifier, e.g. `"feishu"`, `"github"`, `"cron"`. */
    source_type: string;
    /** User identity on the source platform. */
    user_identity: string;
    /**
     * npm package name of the sensor (canonical identifier).
     * Channels/bridges derive the handler skill_id from this via
     * `packageToSkillId(pkg)` and inject it into the message.
     */
    package: string;
  };

  event: {
    /** Event classification using `domain.entity.action` naming. */
    type: string;
    /** When the event actually happened, UTC timestamp in milliseconds. */
    occurred_at: number;
    /**
     * Natural-language summary — the soul of the signal.
     * Recommended pattern: `[Actor] [Action] [Object] in [Context]; [Impact]`.
     * Must be >= 20 characters.
     */
    summary: string;
    /** Implementation-specific or experimental metadata. */
    _meta?: Record<string, unknown>;
  };

  /**
   * Self-describing source-platform event data. This is the structured
   * original event emitted by the upstream system, not the normalized W2A
   * `event` summary above.
   */
  source_event?: SourceEvent;

  /**
   * Optional attachments — actual content relevant to the signal
   * (message text, file contents, diffs, images, documents).
   */
  attachments?: Attachment[];

  /** Implementation-specific or experimental metadata. */
  _meta?: Record<string, unknown>;
}

/**
 * Self-describing source-platform event data. When provided, it must include
 * both a JSON Schema (draft-07) describing the source event structure and the
 * actual source data.
 */
export interface SourceEvent {
  schema: Record<string, unknown>;
  data: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// ─── Attachments ───

export type Attachment = InlineAttachment | ReferenceAttachment;

export interface InlineAttachment {
  type: "inline";
  mime_type: string;
  description: string;
  data: string;
  _meta?: Record<string, unknown>;
}

export interface ReferenceAttachment {
  type: "reference";
  mime_type: string;
  description: string;
  uri: string;
  _meta?: Record<string, unknown>;
}

// ─── Auth ───

export type AuthSpec =
  | {
      type: "oauth2";
      provider: string;
      scopes: string[];
      tokenUrl: string;
      authUrl: string;
    }
  | {
      type: "api_key";
      fields: Array<{ name: string; label: string; sensitive: boolean }>;
    }
  | { type: "none" };

// ─── Consumer auth ───

export interface ConsumerIdentity {
  consumerId: string;
  [key: string]: unknown;
}

export interface ConsumerAuth {
  required: boolean;
  verify(credential: string): Promise<ConsumerIdentity>;
}

// ─── Sensor store ───

export interface SensorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── Auth manager ───

export interface AuthManager {
  getAccessToken(): Promise<string>;
  invalidateToken(): Promise<void>;
}

// ─── Metrics reporter ───

export interface MetricsReporter {
  counter(name: string, value: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  histogram(name: string, valueMs: number, labels?: Record<string, string>): void;
}

// ─── Sensor spec ───

export interface SensorSpec<TConfig = Record<string, unknown>> {
  /** npm package name, e.g. `"@world2agent/sensor-feishu"`. */
  id: string;
  /** Sensor semver version. */
  version: string;
  /** Logical source identifier, e.g. `"feishu"`, `"github"`. */
  source_type: string;
  /** Authentication spec declaring what credentials this sensor needs. */
  auth: AuthSpec;
  /** Optional Zod schema for typed config validation. */
  configSchema?: z.ZodType<TConfig>;
  /** Consumer-side auth. If set, transport must verify consumers. */
  consumerAuth?: ConsumerAuth;
  /** Start the sensor. Returns a cleanup function to stop it. */
  start(ctx: SensorContext<TConfig>): Promise<CleanupFn>;
}

export type CleanupFn = () => Promise<void> | void;

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface SensorContext<TConfig = Record<string, unknown>> {
  /** Sensor configuration (credentials, custom params, etc.). */
  config: TConfig;
  /** Structured logger. */
  logger: Logger;
  /**
   * Emit a signal. This is the sensor's only interface to the outside world.
   *
   * - Resolves when downstream has accepted the signal.
   * - Rejects with `SignalValidationError` if the signal is malformed (don't retry).
   * - Rejects with `SignalBackpressureError` if downstream is overloaded (pause & retry).
   * - Rejects with other errors for transient failures (retry with backoff).
   */
  emit(signal: W2ASignal): Promise<void>;
  /** Report sensor health status. */
  reportHealth(status: "ok" | "degraded" | "error", detail?: string): void;
  /** Sensor-scoped key-value store for cursors/state. Optional. */
  store?: SensorStore;
  /** OAuth/token manager. Optional. */
  auth?: AuthManager;
  /** Metrics reporting. Optional. */
  metrics?: MetricsReporter;
}
