import { describe, expect, it } from "vitest";
import { MemorySensorStore } from "../../src/stores/memory.js";

describe("MemorySensorStore", () => {
  it("set → get round-trips a value", async () => {
    const s = new MemorySensorStore();
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
  });

  it("get returns null for missing keys", async () => {
    const s = new MemorySensorStore();
    expect(await s.get("missing")).toBe(null);
  });

  it("delete removes the key", async () => {
    const s = new MemorySensorStore();
    await s.set("k", "v");
    await s.delete("k");
    expect(await s.get("k")).toBe(null);
  });

  it("evicts the least-recently-used entry when over capacity", async () => {
    const s = new MemorySensorStore(3);
    await s.set("a", "1");
    await s.set("b", "2");
    await s.set("c", "3");
    await s.get("a"); // touch a → b becomes LRU
    await s.set("d", "4"); // should evict b
    expect(await s.get("a")).toBe("1");
    expect(await s.get("b")).toBe(null);
    expect(await s.get("c")).toBe("3");
    expect(await s.get("d")).toBe("4");
  });

  it("set on an existing key refreshes LRU position", async () => {
    const s = new MemorySensorStore(2);
    await s.set("a", "1");
    await s.set("b", "2");
    await s.set("a", "1-new"); // refreshes a
    await s.set("c", "3"); // evicts b
    expect(await s.get("a")).toBe("1-new");
    expect(await s.get("b")).toBe(null);
    expect(await s.get("c")).toBe("3");
  });
});
