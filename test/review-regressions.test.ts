import { describe, expect, it, vi } from "vitest";
import {
  AbortedError,
  CursorInvalidError,
  InvalidResponseError,
  NetworkError,
  ParseError,
  PubMedClient,
  RateLimitError,
  parsePubMedXml,
} from "../src/index.js";
import type { CacheAdapter, PubMedEvent, RateLimitBucket, RateLimitCoordinator } from "../src/index.js";
import { RequestRateLimiter } from "../src/rate-limiter.js";
import { InvalidCacheTracker } from "../src/transport.js";

function articleXml(id: string, extraIds = ""): string {
  return `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>Title ${id}</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${id}</ArticleId>${extraIds}</ArticleIdList></PubmedData></PubmedArticle>`;
}

function setXml(...records: readonly string[]): string {
  return `<PubmedArticleSet>${records.join("")}</PubmedArticleSet>`;
}

function searchBody(count: number, ids: readonly string[]): string {
  return JSON.stringify({ esearchresult: { count: String(count), webenv: "history-token", querykey: "1", idlist: ids } });
}

function cursor(overrides: Readonly<Record<string, unknown>> = {}): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    webEnv: "history-token",
    queryKey: "1",
    total: 3,
    offset: 2,
    pageSize: 1,
    issuedAt: Date.now(),
    ...overrides,
  }), "utf8").toString("base64url");
}

describe("review regressions", () => {
  it("bounds and expires local invalid-cache bypass markers", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const tracker = new InvalidCacheTracker(2, 10);
      tracker.add("a");
      tracker.add("b");
      expect(tracker.has("a")).toBe(true);
      tracker.add("c");
      expect(tracker.has("b")).toBe(false);
      expect(tracker.size).toBe(2);
      now.mockReturnValue(1_011);
      expect(tracker.has("a")).toBe(false);
      expect(tracker.has("c")).toBe(false);
      expect(tracker.size).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a cache-waiting subscriber immediately on abort", async () => {
    let finishRead: (() => void) | undefined;
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> {
        await new Promise<void>((resolve) => { finishRead = resolve; });
        return setXml(articleXml("1"));
      },
      async set(): Promise<void> {},
    };
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "immediate-cache-abort", cache, fetch: vi.fn<typeof fetch>() });
    const controller = new AbortController();
    const request = client.get("1", { signal: controller.signal });
    await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
    controller.abort();
    await expect(request).rejects.toBeInstanceOf(AbortedError);
    finishRead?.();
  });

  it("aborts the shared fetch after the final coalesced subscriber leaves", async () => {
    const events: PubMedEvent[] = [];
    let fetchSignal: AbortSignal | undefined;
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> { return undefined; },
      set: vi.fn<CacheAdapter["set"]>(async () => {}),
    };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "final-subscriber-abort", cache, fetch: fetchMock, onEvent: (event) => events.push(event) });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = client.get("1", { signal: firstController.signal });
    const second = client.get("1", { signal: secondController.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(AbortedError);
    expect(fetchSignal?.aborted).toBe(false);
    secondController.abort();
    await expect(second).rejects.toBeInstanceOf(AbortedError);
    await vi.waitFor(() => expect(fetchSignal?.aborted).toBe(true));
    expect(events.filter((event) => event.type === "retry")).toHaveLength(0);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("starts request timeout after coordinator admission", async () => {
    let release: (() => void) | undefined;
    const coordinator: RateLimitCoordinator = {
      async acquire(): Promise<void> {
        await new Promise<void>((resolve) => { release = resolve; });
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(setXml(articleXml("1"))));
    const client = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "timeout-after-admission",
      fetch: fetchMock,
      rateLimitCoordinator: coordinator,
      timeoutMs: 10,
      maxAttempts: 2,
    });
    const request = client.get("1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    release?.();
    await expect(request).resolves.toMatchObject({ pmid: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("orders shared cache deletion before writing a refreshed body", async () => {
    let releaseDelete: (() => void) | undefined;
    const operations: string[] = [];
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> { return "<not-pubmed />"; },
      async delete(): Promise<void> {
        operations.push("delete-start");
        await new Promise<void>((resolve) => { releaseDelete = resolve; });
        operations.push("delete-end");
      },
      async set(): Promise<void> { operations.push("set"); },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(setXml(articleXml("1"))));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "ordered-cache-delete", cache, fetch: fetchMock });
    const first = client.get("1");
    const second = client.get("1");
    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf("function"));
    const third = client.get("1");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    releaseDelete?.();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    expect(operations).toEqual(["delete-start", "delete-end", "set"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("evicts malformed cached endpoint bodies and refreshes them", async () => {
    const deleteMock = vi.fn<(key: string) => Promise<void>>(async () => {});
    const setMock = vi.fn<(key: string, value: string) => Promise<void>>(async () => {});
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> { return "<not-pubmed />"; },
      set: setMock,
      delete: deleteMock,
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(setXml(articleXml("1"))));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "poisoned-cache", cache, fetch: fetchMock });
    await expect(client.get("1")).resolves.toMatchObject({ pmid: "1" });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(expect.any(String), setXml(articleXml("1")));
  });

  it("evicts malformed cached ESearch and ELink bodies", async () => {
    const searchDeletes = vi.fn<(key: string) => Promise<void>>(async () => {});
    const poisonedSearchCache: CacheAdapter = {
      async get(): Promise<string | undefined> { return "not-json"; },
      async set(): Promise<void> {},
      delete: searchDeletes,
    };
    const searchClient = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "poisoned-esearch",
      cache: poisonedSearchCache,
      fetch: vi.fn<typeof fetch>(async () => new Response(searchBody(0, []))),
    });
    await expect(searchClient.search({ query: "safe" })).resolves.toMatchObject({ total: 0, nextCursor: null });
    expect(searchDeletes).toHaveBeenCalledTimes(1);

    let cacheRead = 0;
    const linkDeletes = vi.fn<(key: string) => Promise<void>>(async () => {});
    const poisonedLinkCache: CacheAdapter = {
      async get(): Promise<string | undefined> {
        cacheRead += 1;
        return cacheRead === 2 ? "<not-linkout />" : undefined;
      },
      async set(): Promise<void> {},
      delete: linkDeletes,
    };
    const linkClient = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "poisoned-elink",
      cache: poisonedLinkCache,
      fetch: vi.fn<typeof fetch>(async (input) => String(input).includes("elink.fcgi")
        ? new Response("<eLinkResult><LinkSet /></eLinkResult>")
        : new Response(setXml(articleXml("1")))),
    });
    await expect(linkClient.get("1", { includeLinkOuts: true })).resolves.toMatchObject({ pmid: "1" });
    expect(linkDeletes).toHaveBeenCalledTimes(1);
  });

  it("does not cache malformed successful network bodies", async () => {
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> { return undefined; },
      set: vi.fn<CacheAdapter["set"]>(async () => {}),
    };
    const client = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "malformed-network-body",
      cache,
      fetch: vi.fn<typeof fetch>(async () => new Response("<not-pubmed />")),
      maxAttempts: 1,
    });
    await expect(client.get("1")).rejects.toBeInstanceOf(ParseError);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("invalidates oversized UTF-8 cache hits and refreshes them", async () => {
    const deleteMock = vi.fn<(key: string) => Promise<void>>(async () => {});
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> { return "é".repeat(300); },
      async set(): Promise<void> {},
      delete: deleteMock,
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(setXml(articleXml("1"))));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "cache-byte-cap", cache, fetch: fetchMock, maxResponseBytes: 512 });
    await expect(client.get("1")).resolves.toMatchObject({ pmid: "1" });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["noncanonical count", { count: "01", webenv: "history", querykey: "1", idlist: ["1"] }],
    ["numeric count", { count: 1, webenv: "history", querykey: "1", idlist: ["1"] }],
    ["zero history query key", { count: "1", webenv: "history", querykey: "0", idlist: ["1"] }],
    ["scalar ID list", { count: "1", webenv: "history", querykey: "1", idlist: "1" }],
    ["noncanonical PMID", { count: "1", webenv: "history", querykey: "1", idlist: ["01"] }],
    ["missing empty ID list", { count: "0", querykey: "0" }],
    ["missing query key", { count: "0", idlist: [] }],
  ])("rejects malformed ESearch metadata without caching it: %s", async (name, esearchresult) => {
    const cache: CacheAdapter = {
      async get(): Promise<string | undefined> { return undefined; },
      set: vi.fn<CacheAdapter["set"]>(async () => {}),
    };
    const client = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: `strict-esearch-${name}`,
      cache,
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ esearchresult }))),
      maxAttempts: 1,
    });
    await expect(client.search({ query: "strict" })).rejects.toBeInstanceOf(InvalidResponseError);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each([
    ["negative offset", { offset: -1 }],
    ["offset at total", { offset: 3 }],
    ["offset after total", { offset: 4 }],
    ["oversized page", { pageSize: 201 }],
    ["future issue time", { issuedAt: Date.now() + 10 * 60_000 }],
  ])("rejects an impossible cursor: %s", async (_name, override) => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: `invalid-cursor-${String(_name)}`, fetch: fetchMock });
    await expect(client.search({ cursor: cursor(override) })).rejects.toBeInstanceOf(CursorInvalidError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create a cursor when the first page is final", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input).includes("esearch.fcgi")
      ? new Response(searchBody(2, ["2", "1"]))
      : new Response(setXml(articleXml("1"), articleXml("2"))));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "final-first-page", fetch: fetchMock });
    const result = await client.search({ query: "final", pageSize: 2 });
    expect(result.records.map((record) => record.pmid)).toEqual(["2", "1"]);
    expect(result.nextCursor).toBeNull();
  });

  it("retrieves expected IDs for cursor pages, preserves order, and reports missing records", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const value = String(input);
      if (value.includes("esearch.fcgi") && value.includes("term=initial")) return new Response(searchBody(3, ["3", "2"]));
      if (value.includes("id=3%2C2")) return new Response(setXml(articleXml("2"), articleXml("3")));
      if (value.includes("esearch.fcgi") && value.includes("retstart=2")) return new Response(searchBody(3, ["1"]));
      if (value.includes("id=1")) return new Response(setXml());
      throw new Error(`unexpected request: ${value}`);
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "expected-cursor-ids", fetch: fetchMock });
    const first = await client.search({ query: "initial", pageSize: 2 });
    expect(first.records.map((record) => record.pmid)).toEqual(["3", "2"]);
    const second = await client.search({ cursor: first.nextCursor ?? "" });
    expect(second.records).toEqual([]);
    expect(second.missingPmids).toEqual(["1"]);
    expect(second.nextCursor).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("query_key=1") && String(input).includes("efetch.fcgi"))).toBe(false);
  });

  it("rejects incomplete history ID pages instead of skipping results", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(searchBody(3, [])));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "incomplete-history-page", fetch: fetchMock });
    await expect(client.search({ cursor: cursor() })).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("counts expected IDs in searchAll so missing records do not stop progress", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const value = String(input);
      if (value.includes("esearch.fcgi") && value.includes("term=missing")) return new Response(searchBody(3, ["1", "2"]));
      if (value.includes("id=1%2C2")) return new Response(setXml(articleXml("1")));
      if (value.includes("esearch.fcgi") && value.includes("retstart=2")) return new Response(searchBody(3, ["3"]));
      if (value.includes("id=3")) return new Response(setXml());
      throw new Error(`unexpected request: ${value}`);
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "search-all-missing", fetch: fetchMock });
    const batches = [];
    for await (const batch of client.searchAll({ query: "missing", maxResults: 3, pageSize: 2 })) batches.push(batch);
    expect(batches).toHaveLength(2);
    expect(batches.flatMap((batch) => batch.records.flatMap((record) => record.pmid ?? []))).toEqual(["1"]);
    expect(batches.flatMap((batch) => batch.missingPmids)).toEqual(["2", "3"]);
    expect(batches.at(-1)?.nextCursor).toBeNull();
  });

  it("batches EFetch requests at no more than 200 IDs", async () => {
    const requestedChunks: string[][] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const parameters = init?.method === "POST"
        ? new URLSearchParams(String(init.body))
        : new URL(String(input)).searchParams;
      const ids = parameters.get("id")?.split(",") ?? [];
      requestedChunks.push(ids);
      return new Response(setXml(...ids.map((id) => articleXml(id))));
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "batch-200", fetch: fetchMock });
    const result = await client.getMany(Array.from({ length: 201 }, (_, index) => String(index + 1)));
    expect(requestedChunks.map((chunk) => chunk.length)).toEqual([200, 1]);
    expect(result.records).toHaveLength(201);
  });

  it("cancels retry backoff when the final subscriber aborts", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const events: PubMedEvent[] = [];
      const fetchMock = vi.fn<typeof fetch>(async () => new Response("retry", { status: 500 }));
      const client = new PubMedClient({
        email: "a@example.test",
        tool: "tests",
        apiKey: "abort-retry-backoff",
        fetch: fetchMock,
        onEvent: (event) => events.push(event),
      });
      const controller = new AbortController();
      const request = client.get("1", { signal: controller.signal });
      await vi.waitFor(() => expect(events.some((event) => event.type === "retry")).toBe(true));
      controller.abort();
      await expect(request).rejects.toBeInstanceOf(AbortedError);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
  });

  it("shares admission pacing between limiter clients with the same fingerprint", async () => {
    const baseline = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(baseline);
      const first = new RequestRateLimiter("same-key-pacing", true, 10, undefined, undefined);
      const second = new RequestRateLimiter("same-key-pacing", true, 10, undefined, undefined);
      const firstAdmission = first.acquire();
      const secondAdmission = second.acquire();
      for (let index = 0; index < 300; index += 1) {
        new RequestRateLimiter(`pressure-${index}`, true, 10, undefined, undefined);
      }
      const registry: unknown = Reflect.get(globalThis, Symbol.for("@everdeep/pubmed/shared-rate-limiters/v1"));
      expect(registry).toBeInstanceOf(Map);
      if (!(registry instanceof Map)) throw new Error("expected limiter registry");
      expect(registry.has("eutils.ncbi.nlm.nih.gov:same-key-pacing")).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await expect(firstAdmission).resolves.toBeUndefined();

      let secondSettled = false;
      void secondAdmission.then(() => { secondSettled = true; });
      await vi.advanceTimersByTimeAsync(100);
      expect(secondSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(12);
      await expect(secondAdmission).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares a bounded limiter registry across module instances", async () => {
    const registrySymbol = Symbol.for("@everdeep/pubmed/shared-rate-limiters/v1");
    const before: unknown = Reflect.get(globalThis, registrySymbol);
    expect(before).toBeInstanceOf(Map);
    vi.resetModules();
    const moduleCopy = await import("../src/rate-limiter.js");
    new moduleCopy.RequestRateLimiter("module-copy-fingerprint", true, 10, undefined, undefined);
    new moduleCopy.RequestRateLimiter("module-copy-fingerprint", true, 10, undefined, undefined);
    for (let index = 0; index < 400; index += 1) {
      new moduleCopy.RequestRateLimiter(`fingerprint-${index}`, true, 10, undefined, undefined);
    }
    const after: unknown = Reflect.get(globalThis, registrySymbol);
    expect(after).toBe(before);
    expect(after).toBeInstanceOf(Map);
    if (!(after instanceof Map)) throw new Error("expected limiter registry");
    expect(after.size).toBeLessThanOrEqual(256);
    expect([...after.keys()].join("|")).not.toContain("raw-secret");
  });

  it("retries HTTP 408 and network failures", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("timeout", { status: 408 }))
        .mockRejectedValueOnce(new TypeError("socket closed with private details"))
        .mockResolvedValueOnce(new Response(setXml(articleXml("1"))));
      const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "408-network-retry", fetch: fetchMock, maxAttempts: 3 });
      await expect(client.get("1")).resolves.toMatchObject({ pmid: "1" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      random.mockRestore();
    }
  });

  it("applies Retry-After cooldown and notifies the coordinator without credentials", async () => {
    const cooldowns: Array<{ bucket: RateLimitBucket; delayMs: number }> = [];
    const coordinator: RateLimitCoordinator = {
      async acquire(): Promise<void> {},
      async cooldown(bucket, delayMs): Promise<void> { cooldowns.push({ bucket, delayMs }); },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(setXml(articleXml("1"))));
    const client = new PubMedClient({ email: "private@example.test", tool: "tests", apiKey: "retry-after-secret", fetch: fetchMock, rateLimitCoordinator: coordinator, maxAttempts: 2 });
    await expect(client.get("1")).resolves.toMatchObject({ pmid: "1" });
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]?.delayMs).toBe(0);
    expect(cooldowns[0]?.bucket.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(cooldowns)).not.toContain("retry-after-secret");
  });

  it.each(["numeric", "date"] as const)("caps excessive %s Retry-After cooldowns and stops retrying immediately", async (kind) => {
    const baseline = new Date("2025-01-01T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(baseline);
    const events: PubMedEvent[] = [];
    const cooldowns: number[] = [];
    const coordinator: RateLimitCoordinator = {
      async acquire(): Promise<void> {},
      cooldown(_bucket, delayMs): Promise<void> {
        cooldowns.push(delayMs);
        return new Promise<void>(() => {
          // A distributed publisher may remain pending independently of this request.
        });
      },
    };
    const retryAfter = kind === "numeric"
      ? "999999999"
      : new Date(baseline + 60 * 60_000).toUTCString();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("slow down", {
      status: 429,
      headers: { "retry-after": retryAfter },
    }));
    const controller = new AbortController();
    let caught: unknown;
    let settled = false;
    const client = new PubMedClient({
      email: "private@example.test",
      tool: "tests",
      apiKey: `extreme-retry-after-${kind}`,
      fetch: fetchMock,
      rateLimitCoordinator: coordinator,
      onEvent: (event) => events.push(event),
      maxAttempts: 2,
    });
    const request = client.get("1", { signal: controller.signal }).catch((error: unknown) => {
      caught = error;
      settled = true;
    });

    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(true);
      expect(caught).toBeInstanceOf(RateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cooldowns).toEqual([5 * 60_000]);
      expect(events.filter((event) => event.type === "retry")).toHaveLength(0);
      for (const event of events) {
        if (event.type === "rate-cooldown" || event.type === "retry") {
          expect(event.delayMs).toBeLessThanOrEqual(5 * 60_000);
        }
      }
    } finally {
      controller.abort();
      await request;
      vi.useRealTimers();
    }
  });

  it("keeps the limiter registry bounded by sharing overflow pacing and cooldowns", async () => {
    const registrySymbol = Symbol.for("@everdeep/pubmed/shared-rate-limiters/v1");
    const keyedOverflowSymbol = Symbol.for("@everdeep/pubmed/shared-rate-limiters/overflow/keyed/v1");
    const noKeyOverflowSymbol = Symbol.for("@everdeep/pubmed/shared-rate-limiters/overflow/no-key/v1");
    const previousRegistry: unknown = Reflect.get(globalThis, registrySymbol);
    const previousKeyedOverflow: unknown = Reflect.get(globalThis, keyedOverflowSymbol);
    const previousNoKeyOverflow: unknown = Reflect.get(globalThis, noKeyOverflowSymbol);
    const hadRegistry = Reflect.has(globalThis, registrySymbol);
    const hadKeyedOverflow = Reflect.has(globalThis, keyedOverflowSymbol);
    const hadNoKeyOverflow = Reflect.has(globalThis, noKeyOverflowSymbol);
    Reflect.set(globalThis, registrySymbol, new Map());
    Reflect.deleteProperty(globalThis, keyedOverflowSymbol);
    Reflect.deleteProperty(globalThis, noKeyOverflowSymbol);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    try {
      for (let index = 0; index < 258; index += 1) {
        const limiter = new RequestRateLimiter(`cooled-fingerprint-${index}`, true, 10, undefined, undefined);
        await limiter.cooldown(10_000);
      }

      const registry: unknown = Reflect.get(globalThis, registrySymbol);
      expect(registry).toBeInstanceOf(Map);
      if (!(registry instanceof Map)) throw new Error("expected limiter registry");
      expect(registry.size).toBeLessThanOrEqual(256);
      expect(Reflect.has(globalThis, keyedOverflowSymbol)).toBe(true);
      const keyedOverflow: unknown = Reflect.get(globalThis, keyedOverflowSymbol);

      vi.resetModules();
      const moduleCopy = await import("../src/rate-limiter.js");
      const excessKeyed = new moduleCopy.RequestRateLimiter("another-cooled-key", true, 10, undefined, undefined);
      expect(Reflect.get(globalThis, keyedOverflowSymbol)).toBe(keyedOverflow);
      await excessKeyed.cooldown(20_000);

      const excessNoKey = new RequestRateLimiter("excess-no-key", false, 10, undefined, undefined);
      const noKeyAdmission = excessNoKey.acquire();
      await vi.advanceTimersByTimeAsync(0);
      await expect(noKeyAdmission).resolves.toBeUndefined();
      expect(Reflect.has(globalThis, noKeyOverflowSymbol)).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);
      new RequestRateLimiter("replacement-after-cooldown", true, 10, undefined, undefined);
      const keyedAdmission = excessKeyed.acquire();
      let keyedSettled = false;
      void keyedAdmission.then(() => { keyedSettled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(keyedSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(keyedAdmission).resolves.toBeUndefined();
      expect([...registry.keys()].join("|")).not.toContain("raw-secret");
    } finally {
      vi.useRealTimers();
      if (hadRegistry) Reflect.set(globalThis, registrySymbol, previousRegistry);
      else Reflect.deleteProperty(globalThis, registrySymbol);
      if (hadKeyedOverflow) Reflect.set(globalThis, keyedOverflowSymbol, previousKeyedOverflow);
      else Reflect.deleteProperty(globalThis, keyedOverflowSymbol);
      if (hadNoKeyOverflow) Reflect.set(globalThis, noKeyOverflowSymbol, previousNoKeyOverflow);
      else Reflect.deleteProperty(globalThis, noKeyOverflowSymbol);
    }
  });

  it("keeps network error details sanitized", async () => {
    const client = new PubMedClient({
      email: "private@example.test",
      tool: "tests",
      apiKey: "network-secret",
      fetch: vi.fn<typeof fetch>(async () => { throw new TypeError("private body and query"); }),
      maxAttempts: 1,
    });
    const error = await client.get("1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
    expect(JSON.stringify(error)).not.toContain("private body and query");
  });

  it("validates canonical identifier links and safely encodes DOI paths", async () => {
    const extras = [
      `<ArticleId IdType="doi">10.1000/a/b?secret=yes#fragment</ArticleId>`,
      `<ArticleId IdType="pmc">PMC123/../../escape</ArticleId>`,
    ].join("");
    const client = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "canonical-safe-links",
      fetch: vi.fn<typeof fetch>(async () => new Response(setXml(articleXml("1", extras)))),
    });
    const record = await client.get("1");
    expect(record?.links).toContainEqual({ url: "https://pubmed.ncbi.nlm.nih.gov/1/", type: "pubmed", provenance: "canonical" });
    expect(record?.links).toContainEqual({ url: "https://doi.org/10.1000%2Fa%2Fb%3Fsecret%3Dyes%23fragment", type: "doi", provenance: "canonical" });
    expect(record?.links.some((link) => link.type === "pmc")).toBe(false);

    const invalidPmid = parsePubMedXml(setXml(articleXml("1/../../escape"))).records[0];
    expect(invalidPmid?.links.some((link) => link.type === "pubmed")).toBe(false);
  });
});
