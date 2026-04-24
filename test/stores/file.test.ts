import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSensorStore } from "../../src/stores/file.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "w2a-file-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("FileSensorStore (write-through, default)", () => {
  it("writes to disk on set", async () => {
    const path = join(tmp, "nested", "state.json");
    const store = new FileSensorStore({ path });
    await store.set("k", "v");
    const raw = readFileSync(path, "utf-8");
    expect(JSON.parse(raw)).toEqual({ k: "v" });
  });

  it("persists across instances", async () => {
    const path = join(tmp, "state.json");
    const a = new FileSensorStore({ path });
    await a.set("k", "v");

    const b = new FileSensorStore({ path });
    expect(await b.get("k")).toBe("v");
  });

  it("delete rewrites the file without the key", async () => {
    const path = join(tmp, "state.json");
    const store = new FileSensorStore({ path });
    await store.set("a", "1");
    await store.set("b", "2");
    await store.delete("a");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ b: "2" });
  });

  it("tolerates a corrupt file by starting empty", async () => {
    const path = join(tmp, "state.json");
    writeFileSync(path, "{not json", "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new FileSensorStore({ path });
    expect(await store.get("anything")).toBe(null);
    await store.set("k", "v"); // should succeed despite corrupt starting state
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ k: "v" });
    errSpy.mockRestore();
  });

  it("ignores non-object JSON payloads", async () => {
    const path = join(tmp, "state.json");
    writeFileSync(path, "[1,2,3]", "utf-8");
    const store = new FileSensorStore({ path });
    expect(await store.get("k")).toBe(null);
  });
});

describe("FileSensorStore (debounced)", () => {
  it("coalesces writes within the debounce window", async () => {
    vi.useFakeTimers();
    const path = join(tmp, "state.json");
    const store = new FileSensorStore({ path, writeDebounceMs: 100 });

    await store.set("a", "1");
    await store.set("b", "2");
    await store.set("c", "3");

    // Before the debounce fires, nothing has hit disk yet.
    let onDisk: Record<string, string> = {};
    try {
      onDisk = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      onDisk = {};
    }
    expect(onDisk).toEqual({});

    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("flush() writes pending changes immediately", async () => {
    vi.useFakeTimers();
    const path = join(tmp, "state.json");
    const store = new FileSensorStore({ path, writeDebounceMs: 10_000 });
    await store.set("k", "v");
    await store.flush();
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ k: "v" });
  });
});
