import { describe, expect, it, vi } from "vitest";
import type { W2ASignal } from "../../src/types.js";
import { createSignalHandler } from "../../src/consumer/signal-handler.js";

function signal(type: string): W2ASignal {
  return {
    signal_id: "11111111-2222-4333-8444-555555555555",
    schema_version: "w2a/0.1",
    emitted_at: 1,
    source: {
      sensor_id: "x",
      sensor_version: "1",
      source_type: "x",
      user_identity: "u",
      package: "x",
    },
    event: {
      type,
      occurred_at: 1,
      summary: "A long enough summary that passes W2A validation checks",
    },
  };
}

describe("createSignalHandler", () => {
  it("dispatches to an exact-match handler", async () => {
    const h = createSignalHandler();
    const fn = vi.fn();
    h.on("messaging.message.mentioned", fn);
    await h.handle(signal("messaging.message.mentioned"));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does not dispatch to a non-matching exact handler", async () => {
    const h = createSignalHandler();
    const fn = vi.fn();
    h.on("messaging.message.mentioned", fn);
    await h.handle(signal("code.review.requested"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("entity wildcard matches children but not siblings", async () => {
    const h = createSignalHandler();
    const fn = vi.fn();
    h.on("messaging.message.*", fn);
    await h.handle(signal("messaging.message.mentioned"));
    await h.handle(signal("messaging.message.direct"));
    await h.handle(signal("messaging.reaction.added"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("domain wildcard matches everything under the prefix", async () => {
    const h = createSignalHandler();
    const fn = vi.fn();
    h.on("messaging.*", fn);
    await h.handle(signal("messaging.message.mentioned"));
    await h.handle(signal("messaging.reaction.added"));
    await h.handle(signal("code.review.requested"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("* matches everything", async () => {
    const h = createSignalHandler();
    const fn = vi.fn();
    h.on("*", fn);
    await h.handle(signal("a.b.c"));
    await h.handle(signal("x.y.z"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dispatches to ALL matching handlers, not just the first", async () => {
    const h = createSignalHandler();
    const a = vi.fn();
    const b = vi.fn();
    h.on("*", a);
    h.on("messaging.message.*", b);
    await h.handle(signal("messaging.message.mentioned"));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("awaits async handlers before returning", async () => {
    const h = createSignalHandler();
    const order: string[] = [];
    h.on("*", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("handler-done");
    });
    const p = h.handle(signal("x.y.z")).then(() => order.push("handle-resolved"));
    await p;
    expect(order).toEqual(["handler-done", "handle-resolved"]);
  });
});
