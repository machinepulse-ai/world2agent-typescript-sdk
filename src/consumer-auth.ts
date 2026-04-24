import type { ConsumerAuth, ConsumerIdentity } from "./types.js";

/**
 * Static API key authentication.
 *
 * Maps API keys to consumer IDs.
 * Simplest strategy — good for personal use or small teams.
 *
 * @example
 * ```ts
 * apiKeyAuth({ "sk-abc123": "agent-1", "sk-def456": "agent-2" })
 * ```
 */
export function apiKeyAuth(
  keys: Record<string, string>,
): ConsumerAuth {
  const map = new Map(Object.entries(keys));
  return {
    required: true,
    async verify(credential) {
      const consumerId = map.get(credential);
      if (!consumerId) throw new Error("Invalid API key");
      return { consumerId };
    },
  };
}

/**
 * Custom authentication with a user-provided verify function.
 *
 * Use this to integrate with any auth system (license server, OAuth, etc.).
 *
 * @example
 * ```ts
 * customAuth(async (token) => {
 *   const res = await fetch("https://api.mycompany.com/verify", {
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 *   if (!res.ok) throw new Error("Unauthorized");
 *   const data = await res.json();
 *   return { consumerId: data.customerId };
 * })
 * ```
 */
export function customAuth(
  verifyFn: (credential: string) => Promise<ConsumerIdentity>,
): ConsumerAuth {
  return { required: true, verify: verifyFn };
}
