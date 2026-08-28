import { AbortedError, QueueFullError } from "./errors.js";
import type { PubMedEvent, RateLimitBucket, RateLimitCoordinator } from "./types.js";

interface QueueItem {
  readonly enqueuedAt: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

class SharedLimiter {
  readonly #intervalMs: number;
  readonly #queue: QueueItem[] = [];
  #nextAvailable = 0;
  #cooldownUntil = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(requestsPerSecond: number) {
    this.#intervalMs = 1_000 / requestsPerSecond;
  }

  public acquire(maxQueue: number, signal: AbortSignal | undefined, onEvent: ((event: PubMedEvent) => void) | undefined): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new AbortedError());
    if (this.#queue.length >= maxQueue) return Promise.reject(new QueueFullError());

    return new Promise<void>((resolve, reject) => {
      const item: QueueItem = { enqueuedAt: Date.now(), resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        item.abortListener = (): void => {
          const index = this.#queue.indexOf(item);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          reject(new AbortedError());
          this.#schedule(onEvent);
        };
        signal.addEventListener("abort", item.abortListener, { once: true });
      }
      this.#queue.push(item);
      this.#schedule(onEvent);
    });
  }

  public cooldown(delayMs: number, onEvent: ((event: PubMedEvent) => void) | undefined): void {
    this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delayMs);
    safeEvent(onEvent, { type: "rate-cooldown", delayMs });
    this.#schedule(onEvent);
  }

  public isIdle(now: number): boolean {
    return this.#queue.length === 0 && this.#timer === undefined && this.#nextAvailable <= now && this.#cooldownUntil <= now;
  }

  #schedule(onEvent: ((event: PubMedEvent) => void) | undefined): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#queue.length === 0) return;
    const now = Date.now();
    const at = Math.max(now, this.#nextAvailable, this.#cooldownUntil);
    const delay = Math.max(0, at - now);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (Date.now() < at) {
        this.#schedule(onEvent);
        return;
      }
      const item = this.#queue.shift();
      if (item === undefined) return;
      if (item.abortListener !== undefined && item.signal !== undefined) {
        item.signal.removeEventListener("abort", item.abortListener);
      }
      if (item.signal?.aborted === true) {
        item.reject(new AbortedError());
      } else {
        const waited = Date.now() - item.enqueuedAt;
        if (waited > 0) safeEvent(onEvent, { type: "queue-delay", delayMs: waited });
        this.#nextAvailable = Math.max(Date.now(), this.#nextAvailable) + this.#intervalMs;
        item.resolve();
      }
      this.#schedule(onEvent);
    }, Math.min(delay, 2_147_000_000));
  }
}

interface LimiterRegistryEntry {
  readonly limiter: SharedLimiter;
  activeAdmissions: number;
  lastUsedAt: number;
}

interface LimiterEntrySelection {
  readonly entry: LimiterRegistryEntry;
  readonly overflow: boolean;
}

const REGISTRY_SYMBOL = Symbol.for("@everdeep/pubmed/shared-rate-limiters/v1");
const KEYED_OVERFLOW_SYMBOL = Symbol.for("@everdeep/pubmed/shared-rate-limiters/overflow/keyed/v1");
const NO_KEY_OVERFLOW_SYMBOL = Symbol.for("@everdeep/pubmed/shared-rate-limiters/overflow/no-key/v1");
const HOST = "eutils.ncbi.nlm.nih.gov";
const MAX_LIMITER_REGISTRY_ENTRIES = 256;
const LIMITER_IDLE_TTL_MS = 10 * 60_000;

function limiterRegistry(): Map<string, LimiterRegistryEntry> {
  const existing = Reflect.get(globalThis, REGISTRY_SYMBOL) as unknown;
  if (existing instanceof Map) return existing as Map<string, LimiterRegistryEntry>;
  const registry = new Map<string, LimiterRegistryEntry>();
  Reflect.set(globalThis, REGISTRY_SYMBOL, registry);
  return registry;
}

function canEvict(entry: LimiterRegistryEntry, now: number): boolean {
  return entry.activeAdmissions === 0 && entry.limiter.isIdle(now);
}

function evictOne(registry: Map<string, LimiterRegistryEntry>, now: number, protectedKey?: string): boolean {
  for (const [key, entry] of registry) {
    if (key === protectedKey || !canEvict(entry, now)) continue;
    registry.delete(key);
    return true;
  }
  return false;
}

function pruneRegistry(registry: Map<string, LimiterRegistryEntry>, now: number, protectedKey?: string): void {
  for (const [key, entry] of registry) {
    if (key !== protectedKey && now - entry.lastUsedAt >= LIMITER_IDLE_TTL_MS && canEvict(entry, now)) registry.delete(key);
  }
  while (registry.size > MAX_LIMITER_REGISTRY_ENTRIES && evictOne(registry, now, protectedKey)) {
    // Remove only limiters with no queued work, active admission, pacing, or cooldown state.
  }
}

function isLimiterRegistryEntry(value: unknown): value is LimiterRegistryEntry {
  if (typeof value !== "object" || value === null || !("limiter" in value) || !("activeAdmissions" in value) || !("lastUsedAt" in value)) {
    return false;
  }
  const limiter = value.limiter;
  return typeof value.activeAdmissions === "number"
    && typeof value.lastUsedAt === "number"
    && typeof limiter === "object"
    && limiter !== null
    && "acquire" in limiter
    && typeof limiter.acquire === "function"
    && "cooldown" in limiter
    && typeof limiter.cooldown === "function"
    && "isIdle" in limiter
    && typeof limiter.isIdle === "function";
}

function overflowLimiterEntry(keyed: boolean, requestsPerSecond: number): LimiterRegistryEntry {
  const symbol = keyed ? KEYED_OVERFLOW_SYMBOL : NO_KEY_OVERFLOW_SYMBOL;
  const existing: unknown = Reflect.get(globalThis, symbol);
  if (isLimiterRegistryEntry(existing)) return existing;
  const created: LimiterRegistryEntry = { limiter: new SharedLimiter(requestsPerSecond), activeAdmissions: 0, lastUsedAt: Date.now() };
  Reflect.set(globalThis, symbol, created);
  return created;
}

function limiterEntry(registryKey: string, requestsPerSecond: number, keyed: boolean): LimiterEntrySelection {
  const registry = limiterRegistry();
  const now = Date.now();
  const existing = registry.get(registryKey);
  if (existing !== undefined && now - existing.lastUsedAt < LIMITER_IDLE_TTL_MS) {
    existing.lastUsedAt = now;
    registry.delete(registryKey);
    registry.set(registryKey, existing);
    pruneRegistry(registry, now, registryKey);
    return { entry: existing, overflow: false };
  }
  if (existing !== undefined && canEvict(existing, now)) registry.delete(registryKey);
  const current = registry.get(registryKey);
  if (current !== undefined) {
    current.lastUsedAt = now;
    return { entry: current, overflow: false };
  }

  pruneRegistry(registry, now);
  if (registry.size >= MAX_LIMITER_REGISTRY_ENTRIES && !evictOne(registry, now)) {
    return { entry: overflowLimiterEntry(keyed, requestsPerSecond), overflow: true };
  }

  const created: LimiterRegistryEntry = { limiter: new SharedLimiter(requestsPerSecond), activeAdmissions: 0, lastUsedAt: now };
  registry.set(registryKey, created);
  return { entry: created, overflow: false };
}

async function waitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await promise;
    return;
  }
  if (signal.aborted) throw new AbortedError();
  await new Promise<void>((resolve, reject) => {
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
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function safeEvent(handler: ((event: PubMedEvent) => void) | undefined, event: PubMedEvent): void {
  if (handler === undefined) return;
  try {
    handler(event);
  } catch {
    // Observability must never affect a request.
  }
}

export class RequestRateLimiter {
  readonly #registryKey: string;
  readonly #requestsPerSecond: number;
  readonly #keyed: boolean;
  readonly #bucket: RateLimitBucket;
  readonly #maxQueue: number;
  readonly #coordinator: RateLimitCoordinator | undefined;
  readonly #onEvent: ((event: PubMedEvent) => void) | undefined;
  #overflowEntry: LimiterRegistryEntry | undefined;

  public constructor(
    credentialFingerprint: string,
    keyed: boolean,
    maxQueue: number,
    coordinator: RateLimitCoordinator | undefined,
    onEvent: ((event: PubMedEvent) => void) | undefined,
  ) {
    this.#requestsPerSecond = keyed ? 9 : 2.8;
    this.#keyed = keyed;
    this.#registryKey = `${HOST}:${credentialFingerprint}`;
    const selection = limiterEntry(this.#registryKey, this.#requestsPerSecond, this.#keyed);
    if (selection.overflow) this.#overflowEntry = selection.entry;
    this.#bucket = { host: HOST, credentialFingerprint, requestsPerSecond: this.#requestsPerSecond };
    this.#maxQueue = maxQueue;
    this.#coordinator = coordinator;
    this.#onEvent = onEvent;
  }

  #entry(): LimiterRegistryEntry {
    if (this.#overflowEntry !== undefined) return this.#overflowEntry;
    const selection = limiterEntry(this.#registryKey, this.#requestsPerSecond, this.#keyed);
    if (selection.overflow) this.#overflowEntry = selection.entry;
    return selection.entry;
  }

  public async acquire(signal?: AbortSignal): Promise<void> {
    const entry = this.#entry();
    entry.activeAdmissions += 1;
    try {
      await entry.limiter.acquire(this.#maxQueue, signal, this.#onEvent);
      if (this.#coordinator !== undefined) await waitWithAbort(this.#coordinator.acquire(this.#bucket, signal), signal);
    } finally {
      entry.activeAdmissions -= 1;
      entry.lastUsedAt = Date.now();
      pruneRegistry(limiterRegistry(), entry.lastUsedAt, this.#registryKey);
    }
  }

  public async cooldown(delayMs: number, signal?: AbortSignal, waitForCoordinator = true): Promise<void> {
    const entry = this.#entry();
    entry.activeAdmissions += 1;
    try {
      entry.limiter.cooldown(delayMs, this.#onEvent);
      if (this.#coordinator?.cooldown !== undefined) {
        if (waitForCoordinator) {
          await waitWithAbort(this.#coordinator.cooldown(this.#bucket, delayMs), signal);
        } else {
          try {
            void this.#coordinator.cooldown(this.#bucket, delayMs).catch(() => {
              // A best-effort distributed publication must not delay an excessive Retry-After failure.
            });
          } catch {
            // Treat synchronous coordinator failures as best effort on the no-wait path.
          }
        }
      }
    } finally {
      entry.activeAdmissions -= 1;
      entry.lastUsedAt = Date.now();
      pruneRegistry(limiterRegistry(), entry.lastUsedAt, this.#registryKey);
    }
  }
}
