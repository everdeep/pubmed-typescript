import {
  AbortedError,
  CursorExpiredError,
  HttpError,
  NetworkError,
  PubMedError,
  RateLimitError,
  ResponseTooLargeError,
  TimeoutError,
} from "../errors.js";
import { RequestRateLimiter, safeEvent } from "../rate-limiter.js";
import type { PubMedEvent } from "../types.js";
import type { Endpoint, ResponseDecoder } from "./contracts.js";

const ORIGIN = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
/** Maximum server-directed cooldown accepted before automatic retries stop. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const HTTP_DATE_PATTERN = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/;

interface RetryAfterDelay {
  readonly delayMs: number;
  readonly exceedsMaximum: boolean;
}

interface CappedBody {
  readonly body: string;
  readonly bytes: number;
}

export interface HttpExecutionOptions {
  readonly email: string;
  readonly tool: string;
  readonly apiKey?: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxResponseBytes: number;
  readonly limiter: RequestRateLimiter;
  readonly onEvent?: (event: PubMedEvent) => void;
}

export interface HttpExecutionResult<TValue> {
  readonly value: TValue;
  readonly body: string;
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

async function readCapped(response: Response, limitBytes: number): Promise<CappedBody> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limitBytes) throw new ResponseTooLargeError(limitBytes);
  if (response.body === null) return { body: "", bytes: 0 };

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
    return { body: parts.join(""), bytes: total };
  } finally {
    reader.releaseLock();
  }
}

export class HttpExecutor {
  readonly #email: string;
  readonly #tool: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #maxResponseBytes: number;
  readonly #limiter: RequestRateLimiter;
  readonly #onEvent: ((event: PubMedEvent) => void) | undefined;

  public constructor(options: HttpExecutionOptions) {
    this.#email = options.email;
    this.#tool = options.tool;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#limiter = options.limiter;
    this.#onEvent = options.onEvent;
  }

  public async execute<TValue>(
    endpoint: Endpoint,
    parameters: Readonly<Record<string, string>>,
    operationSignal: AbortSignal,
    decode: ResponseDecoder<TValue>["decode"],
    correlationId: string,
  ): Promise<HttpExecutionResult<TValue>> {
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
          safeEvent(this.#onEvent, { type: "request", endpoint, status: response.status, durationMs: Date.now() - started, attempt, correlationId });
          if (response.ok) {
            const capped = await readCapped(response, this.#maxResponseBytes);
            safeEvent(this.#onEvent, { type: "response-bytes", endpoint, correlationId, attempt, bytes: capped.bytes });
            if (endpoint === "efetch" && /<(?:ERROR|Error)>[\s\S]*(?:history|webenv|query\s*key)/i.test(capped.body)) {
              throw new CursorExpiredError();
            }
            const value = decode(capped.body);
            if (operationSignal.aborted) throw new AbortedError();
            return { value, body: capped.body };
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
        safeEvent(this.#onEvent, { type: "retry", endpoint, attempt, delayMs: retryDelay, reason: retryReason, correlationId });
        await sleep(retryDelay, operationSignal);
    }
    throw lastError;
  }
}
