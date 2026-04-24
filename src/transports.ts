import type { W2ASignal } from "./types.js";
import { SignalValidationError } from "./errors.js";

/**
 * A transport is a function that delivers a signal somewhere.
 * Plug it into `run(spec, { onSignal: transport })`.
 */
export type SignalTransport = (signal: W2ASignal) => Promise<void>;

// ─── stdout ───

export interface StdoutTransportOptions {
  /** Pretty-print JSON (default: false — one line per signal for piping). */
  pretty?: boolean;
}

/** Print each signal as JSON to stdout. */
export function stdoutTransport(opts?: StdoutTransportOptions): SignalTransport {
  const indent = opts?.pretty ? 2 : undefined;
  return async (signal) => {
    process.stdout.write(JSON.stringify(signal, null, indent) + "\n");
  };
}

// ─── HTTP webhook ───

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

/** POST each signal as JSON to an HTTP endpoint. */
export function httpTransport(opts: HttpTransportOptions): SignalTransport {
  const {
    url,
    headers = {},
    timeout = 10_000,
    retries = 2,
    retryDelay = 500,
  } = opts;

  return async (signal) => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(signal),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await sleep(retryDelay * 2 ** attempt);
        }
        continue;
      }

      if (res.ok) return;

      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }

      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < retries) {
        await sleep(retryDelay * 2 ** attempt);
      }
    }

    throw lastError;
  };
}

// ─── fanout ───

export function fanout(transports: SignalTransport[]): SignalTransport {
  return async (signal) => {
    await Promise.all(transports.map((t) => t(signal)));
  };
}

// ─── filter ───

export function filter(
  predicate: (signal: W2ASignal) => boolean,
  transport: SignalTransport,
): SignalTransport {
  return async (signal) => {
    if (predicate(signal)) {
      await transport(signal);
    }
  };
}

// ─── batch ───

export interface BatchTransportOptions {
  flush: (signals: W2ASignal[]) => Promise<void>;
  maxSize?: number;
  maxWaitMs?: number;
}

export function batch(opts: BatchTransportOptions): {
  transport: SignalTransport;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const { flush: flushFn, maxSize = 50, maxWaitMs = 5000 } = opts;
  let buffer: W2ASignal[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const flushed = buffer;
    buffer = [];
    await flushFn(flushed);
  };

  const startTimer = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      doFlush().catch(() => {});
    }, maxWaitMs);
  };

  const transport: SignalTransport = async (signal) => {
    buffer.push(signal);
    if (buffer.length >= maxSize) {
      await doFlush();
    } else {
      startTimer();
    }
  };

  return {
    transport,
    flush: doFlush,
    stop: doFlush,
  };
}

// ─── retry ───

export interface RetryTransportOptions {
  maxRetries?: number;
  backoff?: number;
}

export function retry(
  transport: SignalTransport,
  opts?: RetryTransportOptions,
): SignalTransport {
  const maxRetries = opts?.maxRetries ?? 3;
  const backoff = opts?.backoff ?? 500;

  return async (signal) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await transport(signal);
        return;
      } catch (err) {
        if (err instanceof SignalValidationError) throw err;
        lastError = err;
        if (attempt < maxRetries) {
          await sleep(backoff * 2 ** attempt);
        }
      }
    }
    throw lastError;
  };
}

// ─── Kafka ───

export interface KafkaProducerLike {
  send(record: {
    topic: string;
    messages: Array<{ key?: string; value: string; headers?: Record<string, string> }>;
  }): Promise<unknown>;
}

export interface KafkaTransportOptions {
  producer: KafkaProducerLike;
  topic: string;
  key?: (signal: W2ASignal) => string;
  headers?: Record<string, string>;
}

/**
 * Publish each signal as a JSON message to a Kafka topic.
 * The caller owns the Producer lifecycle (connect/disconnect).
 */
export function kafkaTransport(opts: KafkaTransportOptions): SignalTransport {
  const { producer, topic, key, headers } = opts;

  return async (signal) => {
    await producer.send({
      topic,
      messages: [
        {
          key: key ? key(signal) : signal.signal_id,
          value: JSON.stringify(signal),
          headers: {
            "w2a-event-type": signal.event.type,
            "w2a-sensor-id": signal.source.sensor_id,
            ...headers,
          },
        },
      ],
    });
  };
}

// ─── RabbitMQ (AMQP) ───

export interface AmqpChannelLike {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: { contentType?: string; headers?: Record<string, unknown>; persistent?: boolean },
  ): boolean;
}

export interface AmqpTransportOptions {
  channel: AmqpChannelLike;
  /** Exchange to publish to (e.g. "w2a-signals"). */
  exchange: string;
  routingKey?: string | ((signal: W2ASignal) => string);
  persistent?: boolean;
  headers?: Record<string, unknown>;
}

/** Publish each signal to a RabbitMQ exchange via AMQP. */
export function amqpTransport(opts: AmqpTransportOptions): SignalTransport {
  const {
    channel,
    exchange,
    routingKey,
    persistent = true,
    headers,
  } = opts;

  return async (signal) => {
    const rk =
      typeof routingKey === "function"
        ? routingKey(signal)
        : routingKey ?? signal.event.type;

    channel.publish(
      exchange,
      rk,
      Buffer.from(JSON.stringify(signal)),
      {
        contentType: "application/json",
        persistent,
        headers: {
          "w2a-event-type": signal.event.type,
          "w2a-sensor-id": signal.source.sensor_id,
          ...headers,
        },
      },
    );
  };
}

/**
 * Default transport for zero-code CLI usage.
 *
 * - `W2A_TRANSPORT_URL` set → POST signals to that URL via [`httpTransport`].
 * - Otherwise → [`stdoutTransport`] (compact JSON, one line per signal).
 *
 * Intentionally minimal: no auth, no retries, no multi-target fanout. Anything
 * beyond the bare URL belongs in code — compose it yourself and pass via
 * `run(spec, { onSignal: … })`.
 */
export function autoTransport(): SignalTransport {
  const url = process.env.W2A_TRANSPORT_URL;
  if (url) return httpTransport({ url });
  return stdoutTransport();
}

// ─── internal ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
