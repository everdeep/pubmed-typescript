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
export type ResponseValidator = (body: string) => void;

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

interface InflightRequest {
  readonly controller: AbortController;
  promise: Promise<string>;
  subscribers: number;
  settled: boolean;
}

const ORIGIN = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const encoder = new TextEncoder();
const INVALID_CACHE_KEY_LIMIT = 1_000;
const INVALID_CACHE_KEY_TTL_MS = 5 * 60_000;
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
  readonly #inflight = new Map<string, InflightRequest>();
  readonly #invalidCacheKeys = new InvalidCacheTracker();
  readonly #pendingCacheDeletes = new Map<string, Promise<void>>();

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

  public async request(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    validate?: ResponseValidator,
  ): Promise<string> {
    if (signal?.aborted === true) throw new AbortedError();
    const semantic = new URLSearchParams(parameters);
    semantic.sort();
    const key = digest(`${endpoint}\n${semantic.toString()}`);

    const cached = await this.#readCache(key, signal);
    if (cached === undefined) await this.#awaitPendingCacheDelete(key, signal);
    if (cached !== undefined) {
      if (encoder.encode(cached).byteLength > this.#maxResponseBytes) {
        await this.#invalidateCache(key, signal);
      } else {
        try {
          validate?.(cached);
          return cached;
        } catch (error) {
          if (error instanceof ResponseTooLargeError || error instanceof AbortedError) throw error;
          await this.#invalidateCache(key, signal);
        }
      }
    }

    let operation = this.#inflight.get(key);
    if (operation === undefined) {
      const controller = new AbortController();
      operation = { controller, subscribers: 0, settled: false, promise: Promise.resolve("") };
      this.#inflight.set(key, operation);
      operation.promise = this.#execute(endpoint, parameters, key, controller.signal, validate);
      const tracked = operation;
      void operation.promise.then(
        () => this.#settle(key, tracked),
        () => this.#settle(key, tracked),
      );
    }
    return this.#subscribe(key, operation, signal);
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

  async #invalidateCache(key: string, signal?: AbortSignal): Promise<void> {
    this.#invalidCacheKeys.add(key);
    const pending = this.#pendingCacheDeletes.get(key);
    if (pending !== undefined) {
      await waitWithAbort(pending, signal);
      return;
    }
    if (this.#cache?.delete === undefined || this.#pendingCacheDeletes.size >= INVALID_CACHE_KEY_LIMIT) return;

    const deletion = this.#cache.delete(key).catch(() => {
      // The bounded local bypass still prevents immediate reuse when deletion fails.
    });
    this.#pendingCacheDeletes.set(key, deletion);
    void this.#clearPendingCacheDelete(key, deletion);
    await waitWithAbort(deletion, signal);
  }

  async #clearPendingCacheDelete(key: string, deletion: Promise<void>): Promise<void> {
    await deletion;
    if (this.#pendingCacheDeletes.get(key) === deletion) this.#pendingCacheDeletes.delete(key);
  }

  async #awaitPendingCacheDelete(key: string, signal?: AbortSignal): Promise<void> {
    const pending = this.#pendingCacheDeletes.get(key);
    if (pending !== undefined) await waitWithAbort(pending, signal);
  }

  #settle(key: string, operation: InflightRequest): void {
    operation.settled = true;
    if (this.#inflight.get(key) === operation) this.#inflight.delete(key);
  }

  #subscribe(key: string, operation: InflightRequest, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) {
      if (operation.subscribers === 0 && !operation.settled) {
        if (this.#inflight.get(key) === operation) this.#inflight.delete(key);
        operation.controller.abort();
      }
      return Promise.reject(new AbortedError());
    }

    operation.subscribers += 1;
    return new Promise<string>((resolve, reject) => {
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

  async #execute(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    cacheKey: string,
    operationSignal: AbortSignal,
    validate?: ResponseValidator,
  ): Promise<string> {
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
        const encodedForm = form.toString();
        const url = `${path}?${encodedForm}`;
        const usePost = url.length > 1_800 || encoder.encode(encodedForm).byteLength > 1_500;
        const response = await this.#fetch(usePost ? path : url, {
          method: usePost ? "POST" : "GET",
          ...(usePost ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: encodedForm } : {}),
          signal: controller.signal,
        });
        safeEvent(this.#onEvent, { type: "request", endpoint, status: response.status, durationMs: Date.now() - started, attempt });
        if (response.ok) {
          const body = await readCapped(response, this.#maxResponseBytes);
          if (endpoint === "efetch" && /<(?:ERROR|Error)>[\s\S]*(?:history|webenv|query\s*key)/i.test(body)) throw new CursorExpiredError();
          validate?.(body);
          if (operationSignal.aborted) throw new AbortedError();
          let cached = false;
          try {
            await this.#cache?.set(cacheKey, body);
            cached = this.#cache !== undefined;
          } catch {
            // Cache writes are best effort.
          }
          if (cached) this.#invalidCacheKeys.delete(cacheKey);
          if (operationSignal.aborted) throw new AbortedError();
          return body;
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
