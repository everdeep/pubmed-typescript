import { describe, expect, it, vi } from "vitest";
import { AbortedError, MemoryCache, PubMedClient } from "../src/index.js";
import type { CacheAdapter, PubMedEvent, RateLimitBucket, RateLimitCoordinator } from "../src/index.js";

const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>One</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">1</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;

describe("cache, coordination, and coalescing", () => {
  it("provides an opt-in memory cache bounded by entries and UTF-8 bytes", async () => {
    const cache = new MemoryCache({ maxEntries: 2, maxBytes: 8, ttlMs: 10_000 });
    await cache.set("a", "éé"); // 1 key byte + 4 value bytes
    await cache.set("b", "xx"); // 1 key byte + 2 value bytes
    expect(await cache.get("a")).toBe("éé");

    await cache.set("c", "yy");
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBe("éé");
    expect(await cache.get("c")).toBe("yy");
    expect(cache.size).toBe(2);
  });

  it("skips entries larger than the memory cache byte limit and removes stale replacements", async () => {
    const cache = new MemoryCache({ maxEntries: 2, maxBytes: 4, ttlMs: 10_000 });
    await cache.set("a", "x");
    await cache.set("a", "éé");
    expect(await cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(() => new MemoryCache({ maxBytes: 0 })).toThrow();
  });

  it("coalesces equivalent in-flight requests and isolates subscriber cancellation", async () => {
    const events: PubMedEvent[] = [];
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async () => new Promise<Response>((resolve) => { release = resolve; }));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "coalesce-key", fetch: fetchMock, onEvent: (event) => events.push(event) });
    const controller = new AbortController();
    const canceled = client.get("1", { signal: controller.signal });
    const survivor = client.get("1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    release?.(new Response(xml));
    await expect(canceled).rejects.toBeInstanceOf(AbortedError);
    await expect(survivor).resolves.toMatchObject({ pmid: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const coalesced = events.find((event) => event.type === "request-coalesced");
    if (coalesced?.type !== "request-coalesced") throw new Error("expected a coalescing event");
    expect(events).toContainEqual(expect.objectContaining({
      type: "terminal-failure",
      correlationId: coalesced.sharedCorrelationId,
      errorCode: "ABORTED",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "terminal-failure",
      correlationId: coalesced.correlationId,
    }));
  });

  it("emits correlated, sanitized cache, coalescing, response-size, and failure events", async () => {
    const email = "private-observability@example.test";
    const apiKey = "private-observability-api-key";
    const query = "private-observability-query";
    const rawResponseMarker = "private-observability-response";
    const events: PubMedEvent[] = [];
    const stored = new Map<string, string>();
    const observedCacheKeys = new Set<string>();
    const cache: CacheAdapter = {
      async get(key): Promise<string | undefined> {
        observedCacheKeys.add(key);
        return stored.get(key);
      },
      async set(key, value): Promise<void> {
        observedCacheKeys.add(key);
        stored.set(key, value);
      },
    };
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("esearch.fcgi")) {
        return new Response(JSON.stringify({
          esearchresult: { count: "0", querykey: "0", idlist: [] },
          diagnostic: rawResponseMarker,
        }));
      }
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const client = new PubMedClient({ email, tool: "observability-tests", apiKey, cache, fetch: fetchMock, onEvent: (event) => events.push(event), maxAttempts: 1 });

    const first = client.get("1");
    const second = client.get("1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release?.(new Response(xml));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await vi.waitFor(() => expect(stored.size).toBe(1));
    await expect(client.get("1")).resolves.toMatchObject({ pmid: "1" });
    await expect(client.search({ query })).resolves.toMatchObject({ total: 0 });

    const correlations = events.filter((event) => event.type === "correlation-id");
    expect(correlations).toHaveLength(4);
    expect(new Set(correlations.map((event) => event.correlationId)).size).toBe(4);
    for (const event of correlations) expect(event.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const coalesced = events.find((event) => event.type === "request-coalesced");
    expect(coalesced).toBeDefined();
    if (coalesced?.type !== "request-coalesced") throw new Error("expected a coalescing event");
    expect(coalesced.correlationId).not.toBe(coalesced.sharedCorrelationId);
    expect(correlations.map((event) => event.correlationId)).toEqual(expect.arrayContaining([
      coalesced.correlationId,
      coalesced.sharedCorrelationId,
    ]));
    expect(events.some((event) => event.type === "cache-miss")).toBe(true);
    expect(events.some((event) => event.type === "cache-hit")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "response-bytes",
      endpoint: "efetch",
      bytes: new TextEncoder().encode(xml).byteLength,
    }));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(query);
    expect(serialized).not.toContain(rawResponseMarker);
    for (const cacheKey of observedCacheKeys) expect(serialized).not.toContain(cacheKey);

    const failureEvents: PubMedEvent[] = [];
    const failingClient = new PubMedClient({
      email,
      tool: "observability-tests",
      apiKey: `${apiKey}-failure`,
      fetch: vi.fn<typeof fetch>(async () => new Response(rawResponseMarker, { status: 400 })),
      onEvent: (event) => failureEvents.push(event),
      maxAttempts: 1,
    });
    await expect(failingClient.get("1")).rejects.toBeDefined();
    const terminal = failureEvents.find((event) => event.type === "terminal-failure");
    expect(terminal).toEqual(expect.objectContaining({ type: "terminal-failure", endpoint: "efetch", errorCode: "HTTP_ERROR" }));
    if (terminal?.type !== "terminal-failure") throw new Error("expected a terminal failure event");
    expect(failureEvents).toContainEqual(expect.objectContaining({ type: "correlation-id", correlationId: terminal.correlationId }));
    expect(JSON.stringify(failureEvents)).not.toContain(rawResponseMarker);
  });

  it("honors cancellation while an asynchronous cache read is pending", async () => {
    let finishRead: (() => void) | undefined;
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> {
        await new Promise<void>((resolve) => { finishRead = resolve; });
        return xml;
      },
      async set(): Promise<void> {},
    };
    const fetchMock = vi.fn<typeof fetch>();
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "cache-abort-key", fetch: fetchMock, cache });
    const controller = new AbortController();
    const request = client.get("1", { signal: controller.signal });
    await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
    controller.abort();
    finishRead?.();
    await expect(request).rejects.toBeInstanceOf(AbortedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses credential fingerprints—not raw API keys—with distributed coordination", async () => {
    const buckets: RateLimitBucket[] = [];
    const coordinator: RateLimitCoordinator = {
      async acquire(bucket): Promise<void> { buckets.push(bucket); },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(xml));
    const apiKey = "raw-secret-value";
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey, fetch: fetchMock, rateLimitCoordinator: coordinator });
    await client.get("1");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ host: "eutils.ncbi.nlm.nih.gov", requestsPerSecond: 9 });
    expect(buckets[0]?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(buckets)).not.toContain(apiKey);
  });

  it("always form-POSTs parameters to the fixed NCBI endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ esearchresult: { count: "0", querykey: "0", idlist: [] } })));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "post-key", fetch: fetchMock });
    await client.search({ query: "private query" });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    const parameters = new URLSearchParams(String(call?.[1]?.body));
    expect(parameters.get("term")).toBe("private query");
    expect(parameters.get("tool")).toBe("tests");
    expect(parameters.get("email")).toBe("a@example.test");
    expect(parameters.get("api_key")).toBe("post-key");
  });
});
