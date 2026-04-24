import { W2ASignalSchema } from "./schemas.js";
import { SignalValidationError } from "./errors.js";
import type { W2ASignal } from "./types.js";

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ path: string; message: string }>;
}

/**
 * Validate a signal against the W2A schema.
 * Returns a result object instead of throwing.
 */
export function validateSignal(signal: unknown): ValidationResult {
  const result = W2ASignalSchema.safeParse(signal);
  if (result.success) {
    return { success: true };
  }
  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** Validate a signal and throw if invalid. */
export function assertValidSignal(signal: unknown): asserts signal is W2ASignal {
  const result = W2ASignalSchema.safeParse(signal);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    const messages = issues
      .map((i) => `  ${i.path}: ${i.message}`)
      .join("\n");
    throw new SignalValidationError(`Invalid W2A signal:\n${messages}`, issues);
  }
}
