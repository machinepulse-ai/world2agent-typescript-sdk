import type { CleanupFn, W2ASignal, Logger } from "../types.js";
import type { SignalTransport } from "../transports.js";

export interface SubscribeOptions {
  /** Signal handler — same interface as run()'s onSignal. */
  onSignal?: SignalTransport;
  /** API key for authenticated channels. */
  apiKey?: string;
  /** Replay signals since this timestamp (ms). If not set, server decides (typically latest 50). */
  since?: number;
  /** Auto-reconnect on disconnect (default: true). */
  reconnect?: boolean;
  /** Reconnect delay in ms (default: 5000). */
  reconnectDelay?: number;
  /** Logger (default: console). */
  logger?: Logger;
}

/**
 * Subscribe to a remote relay channel via WebSocket.
 *
 * Returns the same `CleanupFn` as `run()` — making relay transparent.
 * Signals arrive through `onSignal`, identical to local sensor consumption.
 *
 * ```ts
 * import { subscribe } from "@world2agent/sdk/consumer";
 *
 * const cleanup = await subscribe("wss://relay.example.com/channels/stock-alerts", {
 *   onSignal: (signal) => handler.handle(signal),
 * });
 * ```
 */
export async function subscribe(
  url: string,
  options: SubscribeOptions = {},
): Promise<CleanupFn> {
  const {
    onSignal = defaultOnSignal,
    apiKey,
    since,
    reconnect = true,
    reconnectDelay = 5000,
    logger = console,
  } = options;

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function buildUrl(): string {
    const wsUrl = url
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    const base = wsUrl.replace(/\/subscribe$/, "");
    const connectUrl = new URL(`${base}/subscribe`);

    if (since != null) {
      connectUrl.searchParams.set("since", String(since));
    }
    if (apiKey) {
      connectUrl.searchParams.set("token", apiKey);
    }
    return connectUrl.toString();
  }

  function connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (stopped) return resolve();

      const connectUrl = buildUrl();
      ws = new WebSocket(connectUrl);

      let opened = false;

      ws.addEventListener("open", () => {
        opened = true;
        logger.info(`[subscribe] Connected to ${url}`);
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30_000);
        resolve();
      });

      ws.addEventListener("message", (event) => {
        try {
          const signal: W2ASignal = JSON.parse(
            typeof event.data === "string" ? event.data : String(event.data),
          );
          onSignal(signal).catch((err) => {
            logger.error("[subscribe] onSignal error:", err);
          });
        } catch (err) {
          logger.error("[subscribe] Failed to parse signal:", err);
        }
      });

      ws.addEventListener("close", () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (stopped) return;
        logger.warn(`[subscribe] Disconnected from ${url}`);
        if (reconnect) {
          logger.info(`[subscribe] Reconnecting in ${reconnectDelay}ms...`);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch((err) => {
              logger.error("[subscribe] Reconnect failed:", err);
            });
          }, reconnectDelay);
        }
      });

      ws.addEventListener("error", (err) => {
        if (!opened) {
          reject(new Error(`[subscribe] Failed to connect to ${url}`));
        } else {
          logger.error("[subscribe] WebSocket error:", err);
        }
      });
    });
  }

  await connect();

  return async () => {
    stopped = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    logger.info(`[subscribe] Unsubscribed from ${url}`);
  };
}

function defaultOnSignal(signal: W2ASignal): Promise<void> {
  process.stdout.write(JSON.stringify(signal, null, 2) + "\n");
  return Promise.resolve();
}
