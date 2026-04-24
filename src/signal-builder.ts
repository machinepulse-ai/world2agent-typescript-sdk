import type { W2ASignal, Attachment, SourceEvent } from "./types.js";
import { generateSignalId } from "./create-signal.js";
import { assertValidSignal } from "./validate.js";

/**
 * Chainable builder for constructing W2ASignal objects.
 *
 * Useful when you need conditional logic during construction.
 * For simple cases, prefer `createSignal()`.
 */
export class SignalBuilder {
  private _source?: W2ASignal["source"];
  private _event?: W2ASignal["event"];
  private _sourceEvent?: SourceEvent;
  private _attachments: Attachment[] = [];
  private _meta?: Record<string, unknown>;

  source(
    sensorId: string,
    sensorVersion: string,
    sourceType: string,
    userIdentity: string,
    pkg?: string,
  ): this {
    this._source = {
      sensor_id: sensorId,
      sensor_version: sensorVersion,
      source_type: sourceType,
      user_identity: userIdentity,
      package: pkg ?? sensorId,
    };
    return this;
  }

  event(
    type: string,
    opts: {
      summary: string;
      occurred_at?: number;
      _meta?: Record<string, unknown>;
    },
  ): this {
    this._event = {
      type,
      occurred_at: opts.occurred_at ?? Date.now(),
      summary: opts.summary,
      ...(opts._meta !== undefined ? { _meta: opts._meta } : {}),
    };
    return this;
  }

  sourceEvent(sourceEvent: SourceEvent): this {
    this._sourceEvent = sourceEvent;
    return this;
  }

  attachment(item: Attachment): this {
    this._attachments.push(item);
    return this;
  }

  meta(meta: Record<string, unknown>): this {
    this._meta = meta;
    return this;
  }

  /** Build and validate the signal. Throws if any required field is missing. */
  build(): W2ASignal {
    if (!this._source) throw new Error("SignalBuilder: source is required");
    if (!this._event) throw new Error("SignalBuilder: event is required");
    const signal: W2ASignal = {
      signal_id: generateSignalId(),
      schema_version: "w2a/0.1",
      emitted_at: Date.now(),
      source: this._source,
      event: this._event,
      ...(this._sourceEvent !== undefined ? { source_event: this._sourceEvent } : {}),
      ...(this._attachments.length > 0 ? { attachments: this._attachments } : {}),
      ...(this._meta !== undefined ? { _meta: this._meta } : {}),
    };

    assertValidSignal(signal);
    return signal;
  }
}
