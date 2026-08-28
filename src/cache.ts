import type { CacheAdapter } from "./types.js";
import { ValidationError } from "./errors.js";

export interface MemoryCacheOptions {
  readonly maxEntries?: number;
  /** Maximum UTF-8 bytes retained across cache keys and values. */
  readonly maxBytes?: number;
  readonly ttlMs?: number;
}

interface CacheEntry {
  readonly value: string;
  readonly expiresAt: number;
  readonly bytes: number;
}

const encoder = new TextEncoder();

/** Opt-in bounded, process-local cache. Byte accounting includes UTF-8 keys and values. */
export class MemoryCache implements CacheAdapter {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #ttlMs: number;
  #totalBytes = 0;

  public constructor(options: MemoryCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    this.#maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new ValidationError("Memory cache maxEntries must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new ValidationError("Memory cache maxBytes must be a positive integer");
    }
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs < 0) {
      throw new ValidationError("Memory cache ttlMs must be a non-negative number");
    }
  }

  public async get(key: string): Promise<string | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#remove(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  public async set(key: string, value: string): Promise<void> {
    this.#remove(key);
    const bytes = encoder.encode(key).byteLength + encoder.encode(value).byteLength;
    if (bytes > this.#maxBytes) return;

    const now = Date.now();
    for (const [cachedKey, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(cachedKey);
    }
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs, bytes });
    this.#totalBytes += bytes;
    while (this.#entries.size > this.#maxEntries || this.#totalBytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#remove(oldest.value);
    }
  }

  public async delete(key: string): Promise<void> {
    this.#remove(key);
  }

  public clear(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#totalBytes -= entry.bytes;
  }

  public get size(): number {
    return this.#entries.size;
  }
}
