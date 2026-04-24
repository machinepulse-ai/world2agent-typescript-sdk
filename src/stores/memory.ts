import type { SensorStore } from "../types.js";

interface Entry {
  value: string;
}

/**
 * In-memory SensorStore with LRU eviction.
 *
 * Suitable for development and testing. For production, use a file-backed
 * or database-backed SensorStore implementation.
 */
export class MemorySensorStore implements SensorStore {
  private readonly map = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1024) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    if (!entry) return null;

    this.map.delete(key);
    this.map.set(key, entry);

    return entry.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.delete(key);
    this.map.set(key, { value });

    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
