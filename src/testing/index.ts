import { validateSignal } from "../validate.js";
import type {
  SensorSpec,
  SensorContext,
  CleanupFn,
  W2ASignal,
  Logger,
  SensorStore,
  AuthManager,
  MetricsReporter,
} from "../types.js";

export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  args: unknown[];
  timestamp: Date;
}

export interface HealthEntry {
  status: "ok" | "degraded" | "error";
  detail?: string;
  timestamp: Date;
}

export interface TestHarness {
  /** Start the sensor. */
  start(): Promise<void>;
  /** Stop the sensor via its cleanup function. */
  stop(): Promise<void>;
  /** Get all emitted signals. */
  emitted(): readonly W2ASignal[];
  /** Get all log entries. */
  logs(): readonly LogEntry[];
  /** Get all health status reports. */
  healthHistory(): readonly HealthEntry[];
  /** Get the latest health status. */
  health(): HealthEntry | undefined;
  /** Check if a signal passes W2A validation. */
  isValid(signal: W2ASignal): boolean;
  /** Clear all collected signals, logs, and health entries. */
  reset(): void;
}

/**
 * Create an in-memory test harness for a sensor.
 *
 * Provides a mock SensorContext that collects emitted signals, log entries,
 * and health reports for assertions.
 */
export function createTestHarness<TConfig = Record<string, unknown>>(
  spec: SensorSpec<TConfig>,
  options: {
    config: TConfig;
    store?: SensorStore;
    auth?: AuthManager;
    metrics?: MetricsReporter;
  },
): TestHarness {
  const signals: W2ASignal[] = [];
  const logEntries: LogEntry[] = [];
  const healthEntries: HealthEntry[] = [];
  let cleanup: CleanupFn | null = null;

  const createLogFn =
    (level: LogEntry["level"]) =>
    (message: string, ...args: unknown[]) => {
      logEntries.push({ level, message, args, timestamp: new Date() });
    };

  const logger: Logger = {
    info: createLogFn("info"),
    warn: createLogFn("warn"),
    error: createLogFn("error"),
    debug: createLogFn("debug"),
  };

  const ctx: SensorContext<TConfig> = {
    config: options.config,
    logger,
    emit: async (signal) => {
      signals.push(signal);
    },
    reportHealth: (status, detail) => {
      healthEntries.push({ status, detail, timestamp: new Date() });
    },
    store: options.store,
    auth: options.auth,
    metrics: options.metrics,
  };

  return {
    async start() {
      if (cleanup) throw new Error("TestHarness: already started");
      cleanup = await spec.start(ctx);
    },

    async stop() {
      if (!cleanup) throw new Error("TestHarness: not started");
      await cleanup();
      cleanup = null;
    },

    emitted: () => signals,
    logs: () => logEntries,
    healthHistory: () => healthEntries,
    health: () => healthEntries.at(-1),

    isValid(signal: W2ASignal): boolean {
      return validateSignal(signal).success;
    },

    reset() {
      signals.length = 0;
      logEntries.length = 0;
      healthEntries.length = 0;
    },
  };
}
