import type { W2ASignal } from "../types.js";

export type SignalHandlerFn = (signal: W2ASignal) => void | Promise<void>;

export interface SignalHandler {
  /**
   * Register a handler for a signal event type pattern.
   *
   * Supports glob-style matching:
   * - "messaging.message.mentioned" → exact match
   * - "messaging.message.*" → matches any action under messaging.message
   * - "messaging.*" → matches any entity+action under messaging
   * - "*" → matches everything (fallback)
   */
  on(pattern: string, handler: SignalHandlerFn): void;

  /** Dispatch a signal to matching handlers. */
  handle(signal: W2ASignal): Promise<void>;
}

/**
 * Create a pattern-matching signal dispatcher.
 *
 * Handlers are matched in registration order. A signal is dispatched
 * to ALL matching handlers (not just the first match).
 */
export function createSignalHandler(): SignalHandler {
  const handlers: Array<{ pattern: string; fn: SignalHandlerFn }> = [];

  return {
    on(pattern, fn) {
      handlers.push({ pattern, fn });
    },

    async handle(signal) {
      const eventType = signal.event.type;
      for (const { pattern, fn } of handlers) {
        if (matchPattern(pattern, eventType)) {
          await fn(signal);
        }
      }
    },
  };
}

function matchPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;

  // Glob: "messaging.message.*" matches "messaging.message.mentioned"
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + ".") || eventType === prefix;
  }

  // Glob: "messaging.*" matches "messaging.message.mentioned"
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix);
  }

  return false;
}
