import { AbortedError } from "../errors.js";
import type { CacheAdapter } from "../types.js";

const INVALID_CACHE_KEY_LIMIT = 1_000;
const INVALID_CACHE_KEY_TTL_MS = 5 * 60_000;
const PENDING_CACHE_WRITE_LIMIT = 100;
const CACHE_MUTATION_TOKEN_LIMIT = INVALID_CACHE_KEY_LIMIT + PENDING_CACHE_WRITE_LIMIT;

export type CacheReadResult =
  | Readonly<{ status: "disabled" | "miss" }>
  | Readonly<{ status: "hit"; value: string }>;

export class InvalidCacheTracker {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  public constructor(maxEntries = INVALID_CACHE_KEY_LIMIT, ttlMs = INVALID_CACHE_KEY_TTL_MS) {
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
  }

  public has(key: string): boolean {
    const expiresAt = this.#entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return false;
    }
    this.#entries.delete(key);
    this.#entries.set(key, expiresAt);
    return true;
  }

  public add(key: string): void {
    const now = Date.now();
    for (const [cachedKey, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(cachedKey);
    }
    this.#entries.delete(key);
    this.#entries.set(key, now + this.#ttlMs);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  public delete(key: string): void {
    this.#entries.delete(key);
  }

  public get size(): number {
    return this.#entries.size;
  }
}

async function waitWithAbort<TValue>(promise: Promise<TValue>, signal?: AbortSignal): Promise<TValue> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new AbortedError();
  return new Promise<TValue>((resolve, reject) => {
    let finished = false;
    const finish = (complete: () => void): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = (): void => finish(() => reject(new AbortedError()));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export class CacheLifecycle {
  readonly #cache: CacheAdapter | undefined;
  readonly #invalidCacheKeys = new InvalidCacheTracker();
  readonly #pendingCacheDeletes = new Map<string, Promise<void>>();
  readonly #pendingCacheWrites = new Set<Promise<void>>();
  readonly #pendingCacheMutationsByKey = new Map<string, Promise<void>>();
  readonly #latestCacheMutation = new Map<string, object>();

  public constructor(cache?: CacheAdapter) {
    this.#cache = cache;
  }

  public async read(key: string, signal?: AbortSignal): Promise<CacheReadResult> {
    if (this.#cache === undefined || this.#invalidCacheKeys.has(key)) return { status: "disabled" };
    try {
      const value = await waitWithAbort(this.#cache.get(key), signal);
      return value === undefined ? { status: "miss" } : { status: "hit", value };
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      return { status: "miss" };
    }
  }

  public async invalidate(key: string): Promise<void> {
    this.#invalidCacheKeys.add(key);
    if (this.#pendingCacheDeletes.has(key)) return;
    this.#beginMutation(key);
    if (this.#cache?.delete === undefined || this.#pendingCacheDeletes.size >= INVALID_CACHE_KEY_LIMIT) return;

    // Serialize cache mutations in the background, but never make the API request
    // wait for an older, potentially stalled cache write.
    const pendingMutation = this.#pendingCacheMutationsByKey.get(key);
    const deletion = this.#deleteAfterMutation(key, pendingMutation);
    this.#pendingCacheDeletes.set(key, deletion);
    this.#pendingCacheMutationsByKey.set(key, deletion);
    void this.#clearPendingDelete(key, deletion);
  }

  public write(key: string, body: string): void {
    if (this.#cache === undefined) return;
    // Even when the write queue is full, mark this response as newer so an
    // older pending write cannot later publish stale data for the same key.
    const token = this.#beginMutation(key);
    if (this.#pendingCacheWrites.size >= PENDING_CACHE_WRITE_LIMIT) return;
    const pendingMutation = this.#pendingCacheMutationsByKey.get(key);
    const write = this.#performWrite(key, body, token, pendingMutation);
    this.#pendingCacheWrites.add(write);
    this.#pendingCacheMutationsByKey.set(key, write);
    void write.then(() => {
      this.#pendingCacheWrites.delete(write);
      if (this.#pendingCacheMutationsByKey.get(key) === write) this.#pendingCacheMutationsByKey.delete(key);
    });
  }

  #beginMutation(key: string): object {
    const token = {};
    this.#latestCacheMutation.delete(key);
    this.#latestCacheMutation.set(key, token);
    while (this.#latestCacheMutation.size > CACHE_MUTATION_TOKEN_LIMIT) {
      const oldest = this.#latestCacheMutation.keys().next();
      if (oldest.done) break;
      this.#latestCacheMutation.delete(oldest.value);
    }
    return token;
  }

  async #deleteAfterMutation(key: string, pendingMutation?: Promise<void>): Promise<void> {
    await pendingMutation;
    await this.#delete(key);
  }

  async #delete(key: string): Promise<void> {
    try {
      await this.#cache?.delete?.(key);
    } catch {
      // The bounded local bypass still prevents immediate reuse when deletion fails.
    }
  }

  async #clearPendingDelete(key: string, deletion: Promise<void>): Promise<void> {
    await deletion;
    if (this.#pendingCacheDeletes.get(key) === deletion) this.#pendingCacheDeletes.delete(key);
    if (this.#pendingCacheMutationsByKey.get(key) === deletion) this.#pendingCacheMutationsByKey.delete(key);
  }

  async #performWrite(key: string, body: string, token: object, pendingMutation?: Promise<void>): Promise<void> {
    await pendingMutation;
    try {
      await this.#cache?.set(key, body);
      if (this.#latestCacheMutation.get(key) === token) {
        this.#latestCacheMutation.delete(key);
        this.#invalidCacheKeys.delete(key);
      } else {
        // This write was superseded while it was pending. Remove its potentially
        // stale value without affecting request completion.
        await this.#delete(key);
      }
    } catch {
      // Cache writes are asynchronous best effort and must never reject a request.
    }
  }
}
