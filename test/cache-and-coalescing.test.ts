import { describe, expect, it, vi } from "vitest";
import { AbortedError, MemoryCache, PubMedClient } from "../src/index.js";
import type { CacheAdapter, RateLimitBucket, RateLimitCoordinator } from "../src/index.js";

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
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async () => new Promise<Response>((resolve) => { release = resolve; }));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "coalesce-key", fetch: fetchMock });
    const controller = new AbortController();
    const canceled = client.get("1", { signal: controller.signal });
    const survivor = client.get("1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    release?.(new Response(xml));
    await expect(canceled).rejects.toBeInstanceOf(AbortedError);
    await expect(survivor).resolves.toMatchObject({ pmid: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("automatically POSTs oversized payloads to the fixed NCBI endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ esearchresult: { count: "0", querykey: "0", idlist: [] } })));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "post-key", fetch: fetchMock });
    await client.search({ query: "x".repeat(2_000) });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    expect(call?.[1]?.method).toBe("POST");
    expect(String(call?.[1]?.body)).toContain("tool=tests");
    expect(String(call?.[1]?.body)).toContain("email=a%40example.test");
    expect(String(call?.[1]?.body)).toContain("api_key=post-key");
  });
});
