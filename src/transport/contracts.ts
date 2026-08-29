import type { CacheAdapter, PubMedClientOptions, PubMedEvent } from "../types.js";

export type Endpoint = "esearch" | "esummary" | "efetch" | "elink";

export interface ResponseDecoder<TValue> {
  /** Stable identity for the decoded value type and validation context. */
  readonly key: string;
  readonly decode: (body: string) => TValue;
}

export interface TransportRequestOptions {
  readonly signal?: AbortSignal;
  readonly cache?: boolean;
}

export interface TransportOptions {
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
