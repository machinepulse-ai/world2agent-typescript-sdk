import type {
  SensorSpec,
  SensorContext,
  CleanupFn,
  SensorStore,
  Logger,
} from "./types.js";
import type { SignalTransport } from "./transports.js";
import { autoTransport, stdoutTransport } from "./transports.js";
import { subscribe } from "./consumer/subscribe.js";

export interface StartSensorOptions<TConfig = Record<string, unknown>> {
  /** Sensor config (credentials, etc.). Falls back to env vars matching auth field names. */
  config?: TConfig;
  /** Signal transport. Defaults to JSON stdout. Use transports from `@world2agent/sdk/transports`. */
  onSignal?: SignalTransport;
  /** State store. Auto-scoped with the sensor's id prefix. Defaults to none — `ctx.store` will be `undefined` unless supplied. */
  store?: SensorStore;
  /** Logger to use. Defaults to `console`. */
  logger?: Logger;
  /** Log every emitted signal at info level (useful in multi-sensor setups for distinguishable output). */
  logEmits?: boolean;
}

export interface RunOptions<TConfig = Record<string, unknown>> {
  /** Sensor config (credentials, etc.). Falls back to env vars matching auth field names. */
  config?: TConfig;
  /** Signal transport. Defaults to JSON stdout. Use transports from `@world2agent/sdk/transports`. */
  onSignal?: SignalTransport;
  /** Custom state store. Defaults to none — sensors get `ctx.store === undefined`. */
  store?: SensorStore;
}

export interface SensorEntry {
  spec: SensorSpec<any>;
  config?: Record<string, unknown>;
}

/** A remote relay channel to subscribe to. */
export interface RemoteEntry {
  /** Relay WebSocket URL, e.g. "wss://relay.example.com/channels/stock-alerts". */
  remote: string;
  /** API key for authenticated channels. */
  apiKey?: string;
  /** Replay signals since this timestamp (ms). */
  since?: number;
}

/** A local sensor or a remote relay subscription. */
export type RunAllEntry = SensorEntry | RemoteEntry;

export interface RunAllOptions {
  /** Shared signal transport for all sensors and remote subscriptions. Defaults to JSON stdout. */
  onSignal?: SignalTransport;
  /** Shared state store backend. Each sensor's keys are auto-prefixed. */
  store?: SensorStore;
}

/**
 * Low-level: start a single sensor and return its cleanup function.
 *
 * Does NOT install process signal handlers — that's the caller's responsibility.
 * This is the shared core used by `run()`, `runAll()`, and external lifecycle
 * managers that need to start/stop individual sensors mid-session (e.g.
 * channels that track per-sensor cleanups in a map).
 *
 * Provides a default SensorContext that:
 * - Validates config against `spec.configSchema` (if present)
 * - Auto-scopes the state store with the sensor's id prefix
 * - Wraps `onSignal` into `ctx.emit` (optionally logging each emit)
 * - Wires `ctx.reportHealth` through the logger
 */
export async function startSensor<TConfig = Record<string, unknown>>(
  spec: SensorSpec<TConfig>,
  options: StartSensorOptions<TConfig> = {} as StartSensorOptions<TConfig>,
): Promise<CleanupFn> {
  const rawConfig = (options.config as Record<string, unknown>) ?? configFromEnv(spec);

  const config: TConfig = spec.configSchema
    ? spec.configSchema.parse(rawConfig)
    : (rawConfig as TConfig);

  const logger = options.logger ?? (console as Logger);
  const onSignal = options.onSignal ?? stdoutTransport();
  const store = options.store ? scopedStore(spec.id, options.store) : undefined;
  const logEmits = options.logEmits ?? false;

  const ctx: SensorContext<TConfig> = {
    config,
    logger,
    emit: async (signal) => {
      if (logEmits) {
        logger.info(
          `emit signal: ${signal.signal_id} [${signal.event.type}] ${signal.event.summary.slice(0, 60)}`,
        );
      }
      await onSignal(signal);
    },
    reportHealth: (status, detail) => {
      const msg = detail ? `${status}: ${detail}` : status;
      if (status === "error") logger.error(`[health] ${msg}`);
      else logger.info(`[health] ${msg}`);
    },
    store,
  };

  return spec.start(ctx);
}

/**
 * Run a sensor standalone with minimal setup.
 *
 * Thin wrapper around `startSensor()` that also installs SIGINT/SIGTERM
 * handlers for graceful shutdown and prints a ready message.
 */
export async function run<TConfig = Record<string, unknown>>(
  spec: SensorSpec<TConfig>,
  options: RunOptions<TConfig> = {} as RunOptions<TConfig>,
): Promise<CleanupFn> {
  const onSignal = options.onSignal ?? autoTransport();

  const cleanup = await startSensor(spec, {
    config: options.config,
    onSignal,
    store: options.store,
    // run() keeps the original un-prefixed console logger and no per-emit log.
  });

  const shutdown = async () => {
    console.log(`\nStopping ${spec.id}...`);
    await cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`${spec.id}@${spec.version} running. Press Ctrl+C to stop.`);
  return cleanup;
}

/**
 * Run multiple sensors in a single process with unified lifecycle.
 *
 * - All sensors start concurrently
 * - Shared transport and state store (keys auto-scoped per sensor)
 * - Single SIGINT/SIGTERM handler cleans up ALL sensors
 * - Per-sensor prefixed logger for distinguishable output
 *
 * ```ts
 * import { runAll } from "@world2agent/sdk/sensor";
 * import { fanout, stdoutTransport, httpTransport } from "@world2agent/sdk/transports";
 *
 * await runAll([
 *   { spec: feishu, config: { app_id: "...", app_secret: "..." } },
 *   { spec: gcal,   config: { client_id: "..." } },
 *   { spec: webWatcher },
 * ], {
 *   onSignal: fanout([
 *     stdoutTransport(),
 *     httpTransport({ url: "https://hub.example.com/api/signals" }),
 *   ]),
 * })
 * ```
 */
function isRemoteEntry(entry: RunAllEntry): entry is RemoteEntry {
  return "remote" in entry;
}

export async function runAll(
  entries: RunAllEntry[],
  options: RunAllOptions = {},
): Promise<CleanupFn> {
  const onSignal = options.onSignal ?? autoTransport();
  const cleanups: CleanupFn[] = [];

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      if (isRemoteEntry(entry)) {
        const tag = entry.remote.replace(/^wss?:\/\//, "").split("/").pop() ?? "remote";
        const logger = prefixedLogger(tag);

        const cleanup = await subscribe(entry.remote, {
          onSignal,
          apiKey: entry.apiKey,
          since: entry.since,
          logger,
        });
        cleanups.push(cleanup);
        logger.info(`subscribed to ${entry.remote}`);
        return;
      }

      const { spec, config: explicitConfig } = entry;
      const tag = shortId(spec.id);
      const logger = prefixedLogger(tag);

      if (explicitConfig) {
        logger.debug("rawConfig keys: " + Object.keys(explicitConfig).join(", "));
        logger.debug(
          "rawConfig values present: " +
            Object.entries(explicitConfig)
              .map(([k, v]) => `${k}=${v ? "***" : "(empty)"}`)
              .join(", "),
        );
      }

      const cleanup = await startSensor(spec, {
        config: explicitConfig,
        onSignal,
        store: options.store,
        logger,
        logEmits: true,
      });
      cleanups.push(cleanup);
      logger.info(`${spec.id}@${spec.version} running`);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      const entry = entries[i]!;
      const label = isRemoteEntry(entry) ? entry.remote : entry.spec.id;
      console.error(`[${label}] failed to start:`, r.reason);
    }
  }

  const started = results.filter((r) => r.status === "fulfilled").length;
  console.log(`\n  ${started}/${entries.length} sources running. Press Ctrl+C to stop.\n`);

  const cleanupAll: CleanupFn = async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
  };

  const shutdown = async () => {
    console.log("\nStopping all sources...");
    await cleanupAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return cleanupAll;
}

// ─── internal helpers ───

function scopedStore(sensorId: string, backing: SensorStore): SensorStore {
  const prefix = `${sensorId}:`;
  return {
    get: (key: string) => backing.get(prefix + key),
    set: (key, value) => backing.set(prefix + key, value),
    delete: (key) => backing.delete(prefix + key),
  };
}

function configFromEnv(spec: SensorSpec<any>): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Read auth fields from W2A_<FIELD_NAME> env vars.
  if (spec.auth.type === "api_key") {
    for (const field of spec.auth.fields) {
      const envKey = `W2A_${field.name.toUpperCase()}`;
      const value = process.env[envKey];
      if (value) config[field.name] = value;
    }
  }

  // Read all W2A_* env vars and map to config keys.
  // e.g. W2A_CRON_JOBS → jobs, W2A_WATCH_PATHS → watch_paths
  // Values that look like JSON arrays/objects are parsed automatically.
  const prefix = "W2A_";
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !value) continue;
    const rawField = key.slice(prefix.length);
    if (rawField.startsWith("TRANSPORT_")) continue;
    const field = rawField.toLowerCase();
    if (field in config) continue; // auth fields take precedence

    const trimmed = value.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        config[field] = JSON.parse(trimmed);
        continue;
      } catch {
        // fall through to string
      }
    }
    config[field] = value;
  }

  return config;
}

/** Extract last segment of sensor id for concise log prefix. */
function shortId(id: string): string {
  const last = id.split("/").pop();
  return last ?? id;
}

/** Create a logger where every line is prefixed with `[tag]`. */
function prefixedLogger(tag: string): Logger {
  return {
    info: (msg, ...args) => console.log(`[${tag}]`, msg, ...args),
    warn: (msg, ...args) => console.warn(`[${tag}]`, msg, ...args),
    error: (msg, ...args) => console.error(`[${tag}]`, msg, ...args),
    debug: (msg, ...args) => console.debug(`[${tag}]`, msg, ...args),
  };
}
