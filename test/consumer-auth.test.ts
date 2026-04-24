import { describe, expect, it } from "vitest";
import { apiKeyAuth, customAuth } from "../src/consumer-auth.js";

describe("apiKeyAuth", () => {
  it("maps known keys to consumer ids", async () => {
    const auth = apiKeyAuth({ "sk-a": "agent-1", "sk-b": "agent-2" });
    expect(auth.required).toBe(true);
    expect(await auth.verify("sk-a")).toEqual({ consumerId: "agent-1" });
    expect(await auth.verify("sk-b")).toEqual({ consumerId: "agent-2" });
  });

  it("rejects unknown keys", async () => {
    const auth = apiKeyAuth({ "sk-a": "agent-1" });
    await expect(auth.verify("sk-unknown")).rejects.toThrow(/Invalid API key/);
  });

  it("empty credential is rejected", async () => {
    const auth = apiKeyAuth({ "sk-a": "agent-1" });
    await expect(auth.verify("")).rejects.toThrow(/Invalid API key/);
  });
});

describe("customAuth", () => {
  it("wraps a verify function and marks required=true", async () => {
    const auth = customAuth(async (c) => ({ consumerId: `c:${c}` }));
    expect(auth.required).toBe(true);
    expect(await auth.verify("hello")).toEqual({ consumerId: "c:hello" });
  });

  it("propagates errors from the user function", async () => {
    const auth = customAuth(async () => {
      throw new Error("nope");
    });
    await expect(auth.verify("x")).rejects.toThrow(/nope/);
  });
});
