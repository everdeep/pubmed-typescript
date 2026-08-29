import { createHash, randomUUID } from "node:crypto";
import { AbortedError, PubMedError, ResponseTooLargeError } from "./errors.js";
import { safeEvent, RequestRateLimiter } from "./rate-limiter.js";
import { CacheLifecycle } from "./transport/cache-lifecycle.js";
import { HttpExecutor } from "./transport/http-execution.js";
import { InflightCoalescer } from "./transport/inflight-coalescer.js";
import type {
  Endpoint,
  ResponseDecoder,
  TransportOptions,
  TransportRequestOptions,
} from "./transport/contracts.js";

export { InvalidCacheTracker } from "./transport/cache-lifecycle.js";
export type { Endpoint, ResponseDecoder, TransportRequestOptions } from "./transport/contracts.js";

const encoder = new TextEncoder();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class Transport {
  readonly #maxResponseBytes: number;
  readonly #onEvent: TransportOptions["onEvent"];
  readonly #cache: CacheLifecycle;
  readonly #inflight = new InflightCoalescer();
  readonly #http: HttpExecutor;

  public constructor(options: TransportOptions) {
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#onEvent = options.onEvent;
    this.#cache = new CacheLifecycle(options.cache);
    const fingerprint = options.apiKey === undefined ? digest("no-api-key") : digest(options.apiKey);
    const limiter = new RequestRateLimiter(
      fingerprint,
      options.apiKey !== undefined,
      options.maxQueuedRequests,
      options.rateLimitCoordinator,
      options.onEvent,
    );
    this.#http = new HttpExecutor({
      email: options.email,
      tool: options.tool,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
      maxResponseBytes: options.maxResponseBytes,
      limiter,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
  }

  public async request<TValue>(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    decode: ResponseDecoder<TValue>,
    options: TransportRequestOptions = {},
  ): Promise<TValue> {
    const correlationId = randomUUID();
    safeEvent(this.#onEvent, { type: "correlation-id", endpoint, correlationId });
    try {
      return await this.#coordinate(endpoint, parameters, decode, options, correlationId);
    } catch (error) {
      safeEvent(this.#onEvent, {
        type: "terminal-failure",
        endpoint,
        correlationId,
        errorCode: error instanceof PubMedError ? error.code : "UNKNOWN_ERROR",
      });
      throw error;
    }
  }

  async #coordinate<TValue>(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    decode: ResponseDecoder<TValue>,
    options: TransportRequestOptions,
    correlationId: string,
  ): Promise<TValue> {
    const { signal } = options;
    const useCache = options.cache ?? true;
    if (signal?.aborted === true) throw new AbortedError();

    const semantic = new URLSearchParams(parameters);
    semantic.sort();
    const key = digest(`${endpoint}\n${semantic.toString()}`);
    const inflightKey = `${key}:${digest(decode.key)}`;

    if (useCache) {
      const cached = await this.#cache.read(key, signal);
      if (cached.status === "hit") {
        safeEvent(this.#onEvent, { type: "cache-hit", endpoint, correlationId });
        if (encoder.encode(cached.value).byteLength > this.#maxResponseBytes) {
          await this.#cache.invalidate(key);
        } else {
          try {
            return decode.decode(cached.value);
          } catch (error) {
            if (error instanceof ResponseTooLargeError || error instanceof AbortedError) throw error;
            await this.#cache.invalidate(key);
          }
        }
      } else if (cached.status === "miss") {
        safeEvent(this.#onEvent, { type: "cache-miss", endpoint, correlationId });
      }
    }

    return this.#inflight.request(
      inflightKey,
      correlationId,
      signal,
      async (operationSignal) => {
        const result = await this.#http.execute(endpoint, parameters, operationSignal, decode.decode, correlationId);
        if (operationSignal.aborted) throw new AbortedError();
        if (useCache) this.#cache.write(key, result.body);
        if (operationSignal.aborted) throw new AbortedError();
        return result.value;
      },
      ({ correlationId: joinedCorrelationId, sharedCorrelationId }) => {
        safeEvent(this.#onEvent, {
          type: "request-coalesced",
          endpoint,
          correlationId: joinedCorrelationId,
          sharedCorrelationId,
        });
      },
    );
  }
}
