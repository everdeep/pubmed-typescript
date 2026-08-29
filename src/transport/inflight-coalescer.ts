import { AbortedError } from "../errors.js";

interface InflightRequest<TValue> {
  readonly controller: AbortController;
  readonly correlationId: string;
  readonly promise: Promise<TValue>;
  subscribers: number;
  settled: boolean;
}

export interface CoalescedRequest {
  readonly correlationId: string;
  readonly sharedCorrelationId: string;
}

export class InflightCoalescer {
  readonly #requests = new Map<string, InflightRequest<unknown>>();

  public request<TValue>(
    key: string,
    correlationId: string,
    signal: AbortSignal | undefined,
    create: (signal: AbortSignal) => Promise<TValue>,
    onCoalesced: (event: CoalescedRequest) => void,
  ): Promise<TValue> {
    const existing = this.#requests.get(key);
    if (existing !== undefined) {
      // The decoder identity is part of the coordinator-provided key, so joined
      // subscribers observe the same runtime value type and validation context.
      onCoalesced({ correlationId, sharedCorrelationId: existing.correlationId });
      return this.#subscribe(key, existing, signal) as Promise<TValue>;
    }

    const controller = new AbortController();
    const operation: InflightRequest<TValue> = {
      controller,
      correlationId,
      subscribers: 0,
      settled: false,
      promise: create(controller.signal),
    };
    this.#requests.set(key, operation);
    void operation.promise.then(
      () => this.#settle(key, operation),
      () => this.#settle(key, operation),
    );
    return this.#subscribe(key, operation, signal);
  }

  #settle(key: string, operation: InflightRequest<unknown>): void {
    operation.settled = true;
    if (this.#requests.get(key) === operation) this.#requests.delete(key);
  }

  #subscribe<TValue>(key: string, operation: InflightRequest<TValue>, signal?: AbortSignal): Promise<TValue> {
    if (signal?.aborted === true) {
      if (operation.subscribers === 0 && !operation.settled) {
        if (this.#requests.get(key) === operation) this.#requests.delete(key);
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
        signal?.removeEventListener("abort", onAbort);
        operation.subscribers -= 1;
        if (aborted && operation.subscribers === 0 && !operation.settled) {
          if (this.#requests.get(key) === operation) this.#requests.delete(key);
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
}
