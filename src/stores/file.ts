import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SensorStore } from "../types.js";

export interface FileSensorStoreOptions {
  /**
   * Path to the JSON state file. Defaults to `~/.world2agent/state.json`.
   * The parent directory is created on first write if it doesn't exist.
   */
  path?: string;
  /**
   * Coalesce writes within this window (ms). Default is 0, i.e. write-through:
   * every `set`/`delete` returns only after the file has been updated.
   *
   * Non-zero values reduce write amplification for sensors that update many
   * keys in rapid succession, at the cost of potentially losing the last few
   * writes on a hard crash. If you enable debouncing, call `flush()` from
   * your process shutdown handler.
   */
  writeDebounceMs?: number;
}

/**
 * File-backed `SensorStore`. Persists across process restarts, so sensor
 * dedup state (and sync tokens, page snapshots, etc.) survive restarts —
 * no more signal floods when sensors re-see items they already emitted
 * before.
 *
 * The whole store serializes to a single JSON file. On first access the
 * store hydrates from disk; subsequent reads hit an in-memory mirror.
 * Writes update the mirror and atomically rewrite the file (tmp + rename).
 *
 * Concurrency: two processes writing the same file may overwrite each
 * other's changes — don't share one file across parallel processes. A
 * corrupt or unreadable file is tolerated (treated as empty) rather than
 * crashing the sensor at startup.
 */
export class FileSensorStore implements SensorStore {
  private readonly path: string;
  private readonly writeDebounceMs: number;
  private readonly map = new Map<string, string>();
  private loaded = false;
  private dirty = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(options: FileSensorStoreOptions = {}) {
    this.path = options.path ?? join(homedir(), ".world2agent", "state.json");
    this.writeDebounceMs = options.writeDebounceMs ?? 0;
  }

  private hydrate(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!existsSync(this.path)) return;

    try {
      const raw = readFileSync(this.path, "utf-8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch (err) {
      // A corrupt state file shouldn't prevent sensors from starting —
      // they'll just behave as if nothing is in the dedup set (same as a
      // fresh install). Log so the user knows why they might see a flood.
      console.error(`[FileSensorStore] Failed to read ${this.path} (starting empty):`, err);
    }
  }

  private flushSync(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.map) obj[k] = v;

    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj), "utf-8");
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  private scheduleFlush(): void {
    if (this.writeDebounceMs === 0) {
      this.flushSync();
      return;
    }
    this.dirty = true;
    if (this.debounceTimer) return; // already scheduled
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.dirty) this.flushSync();
    }, this.writeDebounceMs);
  }

  async get(key: string): Promise<string | null> {
    this.hydrate();
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.hydrate();
    this.map.set(key, value);
    this.scheduleFlush();
  }

  async delete(key: string): Promise<void> {
    this.hydrate();
    this.map.delete(key);
    this.scheduleFlush();
  }

  /**
   * Force any pending debounced write to happen now. Call from a process
   * shutdown handler if you enabled `writeDebounceMs`.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.dirty) this.flushSync();
  }
}
