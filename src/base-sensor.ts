import type { z } from "zod";
import { SensorSpecSchema } from "./schemas.js";
import { assertValidSignal } from "./validate.js";
import { createSignal, type CreateSignalInput } from "./create-signal.js";
import type {
  SensorSpec,
  SensorContext,
  CleanupFn,
  AuthSpec,
  ConsumerAuth,
  W2ASignal,
} from "./types.js";

/**
 * Abstract base class for sensors that need internal state or lifecycle hooks.
 *
 * For simple sensors, prefer `defineSensor()`.
 */
export abstract class BaseSensor<TConfig = Record<string, unknown>>
  implements SensorSpec<TConfig>
{
  abstract id: string;
  abstract version: string;
  abstract source_type: string;
  abstract auth: AuthSpec;
  configSchema?: z.ZodType<TConfig, z.ZodTypeDef, any>;
  consumerAuth?: ConsumerAuth;

  abstract start(ctx: SensorContext<TConfig>): Promise<CleanupFn>;

  /** Create a signal with source fields auto-filled from this sensor. */
  protected createSignal(input: CreateSignalInput): W2ASignal {
    return createSignal(this, input);
  }

  /** Validate this sensor spec. Throws if invalid. */
  validate(): void {
    SensorSpecSchema.parse(this);
  }

  /** Wrap a SensorContext to inject signal validation on emit. */
  protected wrapContext(
    ctx: SensorContext<TConfig>,
  ): SensorContext<TConfig> {
    return {
      ...ctx,
      emit: async (signal) => {
        assertValidSignal(signal);
        return ctx.emit(signal);
      },
    };
  }
}
