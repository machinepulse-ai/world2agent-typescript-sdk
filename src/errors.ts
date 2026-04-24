/**
 * Thrown when a signal fails schema validation.
 * Not retryable — the connector code needs to be fixed.
 */
export class SignalValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "SignalValidationError";
    this.issues = issues;
  }
}

/**
 * Thrown by the transport / consumer when downstream is overloaded.
 * The connector should pause emission and retry after `retryAfterMs`.
 */
export class SignalBackpressureError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "SignalBackpressureError";
    this.retryAfterMs = retryAfterMs;
  }
}
