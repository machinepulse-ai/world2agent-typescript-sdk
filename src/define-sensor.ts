import { z } from "zod";
import { SensorSpecSchema } from "./schemas.js";
import { assertValidSignal } from "./validate.js";
import type {
  SensorSpec,
  SensorContext,
  CleanupFn,
  AuthSpec,
  ConsumerAuth,
} from "./types.js";

export interface DefineSensorInput<TConfig = Record<string, unknown>> {
  id: string;
  version: string;
  source_type: string;
  auth: AuthSpec;
  configSchema?: z.ZodType<TConfig, z.ZodTypeDef, any>;
  consumerAuth?: ConsumerAuth;
  start(
    this: SensorSpec<TConfig>,
    ctx: SensorContext<TConfig>,
  ): Promise<CleanupFn>;
}

/**
 * Define a sensor with compile-time type checking and runtime validation.
 *
 * - Validates the spec on definition (missing fields → immediate error)
 * - Wraps `ctx.emit()` with automatic signal validation
 * - If `configSchema` is provided, `ctx.config` is typed accordingly
 * - Returns a frozen `SensorSpec`
 */
export function defineSensor<TConfig = Record<string, unknown>>(
  input: DefineSensorInput<TConfig>,
): SensorSpec<TConfig> {
  SensorSpecSchema.parse(input);

  const spec: SensorSpec<TConfig> = {
    id: input.id,
    version: input.version,
    source_type: input.source_type,
    auth: input.auth,
    configSchema: input.configSchema,
    consumerAuth: input.consumerAuth,

    async start(ctx: SensorContext<TConfig>): Promise<CleanupFn> {
      const wrappedCtx: SensorContext<TConfig> = {
        ...ctx,
        emit: async (signal) => {
          assertValidSignal(signal);
          return ctx.emit(signal);
        },
      };

      return input.start.call(spec, wrappedCtx);
    },
  };

  return Object.freeze(spec);
}
