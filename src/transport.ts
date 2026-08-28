import { createHash } from "node:crypto";
import {
  AbortedError,
  CursorExpiredError,
  HttpError,
  NetworkError,
  PubMedError,
  RateLimitError,
  ResponseTooLargeError,
  TimeoutError,
} from "./errors.js";
import { RequestRateLimiter, safeEvent } from "./rate-limiter.js";
import type { CacheAdapter, PubMedClientOptions, PubMedEvent } from "./types.js";

export type Endpoint = "esearch" | "efetch" | "elink";
export interface ResponseDecoder<TValue> {
  /** Stable identity for the decoded value type and validation context. */
  readonly key: string;
  readonly decode: (body: string) => TValue;
}

export interface TransportRequestOptions {
  readonly signal?: AbortSignal;
  readonly cache?: boolean;
}

interface TransportOptions {
  readonly email: string;
  readonly tool: string;
  readonly apiKey?: string;
  readonly fetch: typeof fetch;
  readonly cache?: CacheAdapter;
  readonly onEvent?: (event: PubMedEvent) => void;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxResponseBytes: number;
  readonly maxQueuedRequests: number;
  readonly rateLimitCoordinator?: PubMedClientOptions["rateLimitCoordinator"];
}

interface InflightRequest<TValue> {
  readonly controller: AbortController;
  promise: Promise<TValue>;
  subscribers: number;
  settled: boolean;
}

const ORIGIN = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const encoder = new TextEncoder();
const INVALID_CACHE_KEY_LIMIT = 1_000;
const INVALID_CACHE_KEY_TTL_MS = 5 * 60_000;
const PENDING_CACHE_WRITE_LIMIT = 100;
const CACHE_MUTATION_TOKEN_LIMIT = INVALID_CACHE_KEY_LIMIT + PENDING_CACHE_WRITE_LIMIT;
/** Maximum server-directed cooldown accepted before automatic retries stop. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const HTTP_DATE_PATTERN = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/;

interface RetryAfterDelay {
  readonly delayMs: number;
  readonly exceedsMaximum: boolean;
}

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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRetryAfter(delayMs: number): RetryAfterDelay {
  return {
    delayMs: Math.min(delayMs, MAX_RETRY_AFTER_MS),
    exceedsMaximum: delayMs > MAX_RETRY_AFTER_MS,
  };
}

function retryAfter(headers: Headers): RetryAfterDelay | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds > MAX_RETRY_AFTER_MS / 1_000) {
      return { delayMs: MAX_RETRY_AFTER_MS, exceedsMaximum: true };
    }
    return boundedRetryAfter(seconds * 1_000);
  }
  if (!HTTP_DATE_PATTERN.test(raw)) return undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? boundedRetryAfter(Math.max(0, date - Date.now())) : undefined;
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

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    const remaining = Math.min(deadline - Date.now(), 2_147_000_000);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, remaining);
      const abort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new AbortedError());
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

function discardBody(response: Response): void {
  if (response.body === null) return;
  void response.body.cancel().catch(() => {
    // Error response bodies are intentionally ignored; status and headers drive retries.
  });
}

async function readCapped(response: Response, limitBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limitBytes) throw new ResponseTooLargeError(limitBytes);
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(limitBytes);
      }
      parts.push(decoder.decode(result.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

export class Transport {
  readonly #email: string;
  readonly #tool: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #cache: CacheAdapter | undefined;
  readonly #onEvent: ((event: PubMedEvent) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #maxResponseBytes: number;
  readonly #limiter: RequestRateLimiter;
  readonly #inflight = new Map<string, InflightRequest<unknown>>();
  readonly #invalidCacheKeys = new InvalidCacheTracker();
  readonly #pendingCacheDeletes = new Map<string, Promise<void>>();
  readonly #pendingCacheWrites = new Set<Promise<void>>();
  readonly #pendingCacheMutationsByKey = new Map<string, Promise<void>>();
  readonly #latestCacheMutation = new Map<string, object>();

  public constructor(options: TransportOptions) {
    this.#email = options.email;
    this.#tool = options.tool;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#cache = options.cache;
    this.#onEvent = options.onEvent;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts;
    this.#maxResponseBytes = options.maxResponseBytes;
    const fingerprint = options.apiKey === undefined ? digest("no-api-key") : digest(options.apiKey);
    this.#limiter = new RequestRateLimiter(fingerprint, options.apiKey !== undefined, options.maxQueuedRequests, options.rateLimitCoordinator, options.onEvent);
  }

  public async request<TValue>(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    decode: ResponseDecoder<TValue>,
    options: TransportRequestOptions = {},
  ): Promise<TValue> {
    const { signal } = options;
    const useCache = options.cache ?? true;
    if (signal?.aborted === true) throw new AbortedError();
    const semantic = new URLSearchParams(parameters);
    semantic.sort();
    const key = digest(`${endpoint}\n${semantic.toString()}`);
    const inflightKey = `${key}:${digest(decode.key)}`;

    const cached = useCache ? await this.#readCache(key, signal) : undefined;
    if (cached !== undefined) {
      if (encoder.encode(cached).byteLength > this.#maxResponseBytes) {
        await this.#invalidateCache(key);
      } else {
        try {
          return decode.decode(cached);
        } catch (error) {
          if (error instanceof ResponseTooLargeError || error instanceof AbortedError) throw error;
          await this.#invalidateCache(key);
        }
      }
    }

    const existing = this.#inflight.get(inflightKey);
    if (existing !== undefined) {
      // The decoder identity is part of the in-flight key, so coalesced subscribers
      // observe the same runtime value type and validation context.
      return this.#subscribe(inflightKey, existing, signal) as Promise<TValue>;
    }

    const controller = new AbortController();
    const operation: InflightRequest<TValue> = {
      controller,
      subscribers: 0,
      settled: false,
      promise: this.#execute(endpoint, parameters, key, controller.signal, decode.decode, useCache),
    };
    this.#inflight.set(inflightKey, operation);
    void operation.promise.then(
      () => this.#settle(inflightKey, operation),
      () => this.#settle(inflightKey, operation),
    );
    return this.#subscribe(inflightKey, operation, signal);
  }

  async #readCache(key: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.#cache === undefined || this.#invalidCacheKeys.has(key)) return undefined;
    try {
      return await waitWithAbort(this.#cache.get(key), signal);
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      return undefined;
    }
  }

  async #invalidateCache(key: string): Promise<void> {
    this.#invalidCacheKeys.add(key);
    if (this.#pendingCacheDeletes.has(key)) return;
    this.#beginCacheMutation(key);
    if (this.#cache?.delete === undefined || this.#pendingCacheDeletes.size >= INVALID_CACHE_KEY_LIMIT) return;

    // Serialize cache mutations in the background, but never make the API request
    // wait for an older, potentially stalled cache write.
    const pendingMutation = this.#pendingCacheMutationsByKey.get(key);
    const deletion = this.#deleteCacheAfterMutation(key, pendingMutation);
    this.#pendingCacheDeletes.set(key, deletion);
    this.#pendingCacheMutationsByKey.set(key, deletion);
    void this.#clearPendingCacheDelete(key, deletion);
  }

  async #deleteCacheAfterMutation(key: string, pendingMutation?: Promise<void>): Promise<void> {
    await pendingMutation;
    await this.#deleteCache(key);
  }

  async #deleteCache(key: string): Promise<void> {
    try {
      await this.#cache?.delete?.(key);
    } catch {
      // The bounded local bypass still prevents immediate reuse when deletion fails.
    }
  }

  async #clearPendingCacheDelete(key: string, deletion: Promise<void>): Promise<void> {
    await deletion;
    if (this.#pendingCacheDeletes.get(key) === deletion) this.#pendingCacheDeletes.delete(key);
    if (this.#pendingCacheMutationsByKey.get(key) === deletion) this.#pendingCacheMutationsByKey.delete(key);
  }

  #beginCacheMutation(key: string): object {
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

  #writeCache(key: string, body: string): void {
    if (this.#cache === undefined) return;
    // Even when the write queue is full, mark this response as newer so an
    // older pending write cannot later publish stale data for the same key.
    const token = this.#beginCacheMutation(key);
    if (this.#pendingCacheWrites.size >= PENDING_CACHE_WRITE_LIMIT) return;
    const pendingMutation = this.#pendingCacheMutationsByKey.get(key);
    const write = this.#performCacheWrite(key, body, token, pendingMutation);
    this.#pendingCacheWrites.add(write);
    this.#pendingCacheMutationsByKey.set(key, write);
    void write.then(() => {
      this.#pendingCacheWrites.delete(write);
      if (this.#pendingCacheMutationsByKey.get(key) === write) this.#pendingCacheMutationsByKey.delete(key);
    });
  }

  async #performCacheWrite(key: string, body: string, token: object, pendingMutation?: Promise<void>): Promise<void> {
    await pendingMutation;
    try {
      await this.#cache?.set(key, body);
      if (this.#latestCacheMutation.get(key) === token) {
        this.#latestCacheMutation.delete(key);
        this.#invalidCacheKeys.delete(key);
      } else {
        // This write was superseded while it was pending. Remove its potentially
        // stale value without affecting request completion.
        await this.#deleteCache(key);
      }
    } catch {
      // Cache writes are asynchronous best effort and must never reject a request.
    }
  }

  #settle(key: string, operation: InflightRequest<unknown>): void {
    operation.settled = true;
    if (this.#inflight.get(key) === operation) this.#inflight.delete(key);
  }

  #subscribe<TValue>(key: string, operation: InflightRequest<TValue>, signal?: AbortSignal): Promise<TValue> {
    if (signal?.aborted === true) {
      if (operation.subscribers === 0 && !operation.settled) {
        if (this.#inflight.get(key) === operation) this.#inflight.delete(key);
        operation.controller.abort();
      }
      return Promise.reject(new AbortedError());
    }

    operation.subscribers += 1;
    return new Promise<TValue>((resolve, reject) => {
      let finished = false;
      const finish = (aborted: boolean, complete: () => void): void => {
        if (finished) return;
        finished = true;
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        operation.subscribers -= 1;
        if (aborted && operation.subscribers === 0 && !operation.settled) {
          if (this.#inflight.get(key) === operation) this.#inflight.delete(key);
          operation.controller.abort();
        }
        complete();
      };
      const onAbort = (): void => finish(true, () => reject(new AbortedError()));
      signal?.addEventListener("abort", onAbort, { once: true });
      void operation.promise.then(
        (value) => finish(false, () => resolve(value)),
        (error: unknown) => finish(false, () => reject(error)),
      );
    });
  }

  async #execute<TValue>(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    cacheKey: string,
    operationSignal: AbortSignal,
    decode: ResponseDecoder<TValue>["decode"],
    useCache: boolean,
  ): Promise<TValue> {
    let lastError: Error = new NetworkError();
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (operationSignal.aborted) throw new AbortedError();
      await this.#limiter.acquire(operationSignal);
      if (operationSignal.aborted) throw new AbortedError();

      const controller = new AbortController();
      let timedOut = false;
      const abortAttempt = (): void => controller.abort();
      operationSignal.addEventListener("abort", abortAttempt, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.#timeoutMs);
      const started = Date.now();
      let retryDelay: number | undefined;
      let retryReason: "network" | "timeout" | "http" = "network";
      let stopAutomaticRetry = false;
      try {
        const form = new URLSearchParams({ db: "pubmed", ...parameters, tool: this.#tool, email: this.#email });
        if (this.#apiKey !== undefined) form.set("api_key", this.#apiKey);
        const path = `${ORIGIN}${endpoint}.fcgi`;
        const response = await this.#fetch(path, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
        safeEvent(this.#onEvent, { type: "request", endpoint, status: response.status, durationMs: Date.now() - started, attempt });
        if (response.ok) {
          const body = await readCapped(response, this.#maxResponseBytes);
          if (endpoint === "efetch" && /<(?:ERROR|Error)>[\s\S]*(?:history|webenv|query\s*key)/i.test(body)) throw new CursorExpiredError();
          const value = decode(body);
          if (operationSignal.aborted) throw new AbortedError();
          if (useCache) this.#writeCache(cacheKey, body);
          if (operationSignal.aborted) throw new AbortedError();
          return value;
        }
        discardBody(response);

        if (response.status === 429) {
          const serverDelay = retryAfter(response.headers);
          retryDelay = serverDelay?.delayMs ?? Math.random() * 1_000 * 2 ** (attempt - 1);
          stopAutomaticRetry = serverDelay?.exceedsMaximum ?? false;
          await this.#limiter.cooldown(retryDelay, operationSignal, !stopAutomaticRetry);
          lastError = new RateLimitError();
        } else {
          const retryable = response.status === 408 || response.status >= 500;
          lastError = new HttpError(response.status, retryable);
          if (retryable) retryDelay = Math.random() * 500 * 2 ** (attempt - 1);
        }
        retryReason = "http";
      } catch (error) {
        if (operationSignal.aborted) throw new AbortedError();
        if (error instanceof ResponseTooLargeError || error instanceof CursorExpiredError) throw error;
        if (error instanceof PubMedError && !error.retryable) throw error;
        if (timedOut) {
          lastError = new TimeoutError();
          retryDelay = Math.random() * 500 * 2 ** (attempt - 1);
          retryReason = "timeout";
        } else if (error instanceof RateLimitError || error instanceof HttpError) {
          lastError = error;
          if (error.retryable) retryDelay ??= Math.random() * 500 * 2 ** (attempt - 1);
          retryReason = "http";
        } else if (error instanceof AbortedError) {
          throw error;
        } else {
          lastError = new NetworkError();
          retryDelay = Math.random() * 500 * 2 ** (attempt - 1);
          retryReason = "network";
        }
      } finally {
        clearTimeout(timer);
        operationSignal.removeEventListener("abort", abortAttempt);
      }

      if (stopAutomaticRetry) throw new RateLimitError();
      if (retryDelay === undefined || attempt === this.#maxAttempts) throw lastError;
      safeEvent(this.#onEvent, { type: "retry", endpoint, attempt, delayMs: retryDelay, reason: retryReason });
      await sleep(retryDelay, operationSignal);
    }
    throw lastError;
  }
}
