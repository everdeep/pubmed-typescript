import { describe, expect, it, vi } from "vitest";
import {
  AbortedError,
  InvalidResponseError,
  PaginationConsistencyError,
  PubMedClient,
  SearchLimitError,
  ValidationError,
  type PubMedClientOptions,
  type PubMedEvent,
} from "../src/index.js";

interface Page { total: number; ids: string[] }
let sequence = 0;
function setup(pages: Page[], options: Partial<PubMedClientOptions> = {}, missing: string[] = []) {
  const searches: URLSearchParams[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const parameters = new URLSearchParams(String(init?.body));
    if (String(input).includes("esearch.fcgi")) {
      searches.push(parameters);
      const page = pages[searches.length - 1];
      if (!page) throw new Error("unexpected search");
      return new Response(JSON.stringify({ esearchresult: {
        count: String(page.total), webenv: searches.length === 1 ? "private-history-token" : "replacement-history-token",
        querykey: searches.length === 1 ? "1" : "2", idlist: page.ids,
      } }));
    }
    const ids = parameters.get("id")?.split(",").filter((id) => !missing.includes(id)) ?? [];
    return new Response(`<PubmedArticleSet>${ids.map((id) =>
      `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>Title</ArticleTitle></Article></MedlineCitation></PubmedArticle>`
    ).join("")}</PubmedArticleSet>`);
  });
  const events: PubMedEvent[] = [];
  const client = new PubMedClient({
    email: "private@example.test", tool: "tests", apiKey: `private-key-${++sequence}`, fetch: fetchMock,
    onEvent: (event) => events.push(event), ...options,
  });
  return { client, fetchMock, searches, events };
}

const reportedPages = [
  { total: 5_699_779, ids: ["9", "8"] },
  { total: 5_699_835, ids: ["7", "6"] },
];
const diagnostic = {
  reason: "total-changed", originalTotal: 5_699_779, observedTotal: 5_699_835,
  offset: 2, requestedIds: 2, returnedIds: 2,
};

function decode(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("pagination consistency", () => {
  it.each([5_699_835, 5_699_700])("classifies count drift to %s separately from provider or malformed-response failures by default", async (total) => {
    const { client, fetchMock, events } = setup([reportedPages[0]!, { total, ids: ["7", "6"] }]);
    const expectedDiagnostic = { ...diagnostic, observedTotal: total };
    const first = await client.search({ query: "private query", pageSize: 2 });
    const error: unknown = await client.search({ cursor: first.nextCursor! }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaginationConsistencyError);
    expect(error).toMatchObject({ code: "PAGINATION_INCONSISTENT", retryable: false, diagnostic: expectedDiagnostic });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "PaginationConsistencyError", message: "PubMed search total changed during pagination",
      code: "PAGINATION_INCONSISTENT", retryable: false, diagnostic: expectedDiagnostic,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "terminal-failure", errorCode: "PAGINATION_INCONSISTENT" }));
    expect(events.filter((event) => event.type === "request").every((event) => event.status === 200)).toBe(true);
    expect(events.some((event) => event.type === "retry")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // no record fetch or automatic retry of the drifted page
    const serialized = JSON.stringify({ error, events });
    for (const secret of ["private query", "private@example.test", "private-key", "private-history-token", "replacement-history-token", first.nextCursor!]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([5_699_835, 5_699_700])("allows explicit best-effort continuation for changed total %s", async (total) => {
    const { client, searches, events } = setup([reportedPages[0]!, { total, ids: ["7", "6"] }], { totalDriftPolicy: "warn" });
    const first = await client.search({ query: "private query", pageSize: 2, sort: "relevance" });
    const second = await client.search({ cursor: first.nextCursor! });
    expect(second.records.map((record) => record.pmid)).toEqual(["7", "6"]);
    expect(second.total).toBe(5_699_779);
    expect(second.diagnostics).toEqual([{ ...diagnostic, observedTotal: total }]);
    expect(decode(second.nextCursor!)).toEqual({ ...decode(first.nextCursor!), offset: 4 });
    expect(searches[1]?.get("WebEnv")).toBe("private-history-token");
    expect(searches[1]?.get("term")).toBe("#1");
    expect(searches[1]?.get("retmax")).toBe("2");
    expect(events).toContainEqual({ type: "search-total-drift", ...diagnostic, observedTotal: total });
  });

  it("does not diagnose unchanged totals", async () => {
    const { client, events } = setup([{ total: 4, ids: ["4", "3"] }, { total: 4, ids: ["2", "1"] }]);
    const first = await client.search({ query: "normal", pageSize: 2 });
    const second = await client.search({ cursor: first.nextCursor! });
    expect(first.diagnostics ?? []).toEqual([]);
    expect(second.diagnostics ?? []).toEqual([]);
    expect(second.nextCursor).toBeNull();
    expect(events.some((event) => event.type === "search-total-drift")).toBe(false);
  });

  it.each([
    ["short", 10, ["7"]],
    ["empty", 10, []],
    ["oversized", 10, ["7", "6", "5"]],
    ["duplicate", 10, ["7", "7"]],
    ["shrunk short", 3, ["7"]],
    ["exhausted", 2, []],
    ["zero", 0, []],
    ["contradictory count", 3, ["7", "6"]],
  ] as const)("still rejects %s continuation pages before fetching records", async (_name, total, ids) => {
    const { client, fetchMock } = setup([{ total: 8, ids: ["9", "8"] }, { total, ids: [...ids] }], { totalDriftPolicy: "warn" });
    const first = await client.search({ query: "invalid", pageSize: 2 });
    await expect(client.search({ cursor: first.nextCursor! })).rejects.toBeInstanceOf(InvalidResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([3, 5])("keeps searchAll bounded to original target despite growth (maxResults=%s)", async (maxResults) => {
    const { client, searches } = setup([
      { total: 3, ids: ["3", "2"] }, { total: 30, ids: ["1"] },
    ], { totalDriftPolicy: "warn" }, ["2", "1"]);
    const batches = [];
    for await (const batch of client.searchAll({ query: "bounded", pageSize: 2, maxResults })) batches.push(batch);
    expect(searches.map((parameters) => parameters.get("retmax"))).toEqual(["2", "1"]);
    expect(batches.flatMap((batch) => batch.records.map((record) => record.pmid))).toEqual(["3"]);
    expect(batches.flatMap((batch) => batch.missingPmids)).toEqual(["2", "1"]);
    expect(batches.map((batch) => batch.total)).toEqual([3, 3]);
    expect(batches.at(-1)?.nextCursor).toBeNull();
    expect(batches.at(-1)?.diagnostics).toEqual([expect.objectContaining({ requestedIds: 1, returnedIds: 1 })]);
  });

  it("keeps the original cursor history, expiry, and bound through repeated drift", async () => {
    const { client, searches } = setup([
      { total: 7, ids: ["9", "8"] }, { total: 10, ids: ["7", "6"] }, { total: 6, ids: ["5", "4"] },
    ], { totalDriftPolicy: "warn" });
    const first = await client.search({ query: "drift", pageSize: 2 });
    const second = await client.search({ cursor: first.nextCursor! });
    const third = await client.search({ cursor: second.nextCursor! });
    expect(decode(third.nextCursor!)).toEqual({ ...decode(first.nextCursor!), offset: 6 });
    expect(third.diagnostics).toEqual([expect.objectContaining({ originalTotal: 7, observedTotal: 6, offset: 4 })]);
    expect(searches.slice(1).map((parameters) => [parameters.get("WebEnv"), parameters.get("term")])).toEqual([
      ["private-history-token", "#1"], ["private-history-token", "#1"],
    ]);
  });

  it("caps a partial searchAll page at maxResults, not the observed total", async () => {
    const { client, searches } = setup([
      reportedPages[0]!, { total: 5_699_835, ids: ["7"] },
    ], { totalDriftPolicy: "warn" });
    const batches = [];
    for await (const batch of client.searchAll({ query: "bounded", pageSize: 2, maxResults: 3 })) batches.push(batch);
    expect(batches.flatMap((batch) => batch.records)).toHaveLength(3);
    expect(searches.map((parameters) => parameters.get("retmax"))).toEqual(["2", "1"]);
    expect(decode(batches.at(-1)!.nextCursor!).offset).toBe(3);
  });

  it("delivers diagnostics to every coalesced caller without caching history", async () => {
    const cache = { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) };
    const { client, searches, events } = setup(reportedPages, { totalDriftPolicy: "warn", cache });
    const first = await client.search({ query: "coalesced", pageSize: 2 });
    const pages = await Promise.all([client.search({ cursor: first.nextCursor! }), client.search({ cursor: first.nextCursor! })]);
    expect(pages.map((page) => page.diagnostics)).toEqual([[diagnostic], [diagnostic]]);
    expect(events.filter((event) => event.type === "search-total-drift")).toEqual([
      { type: "search-total-drift", ...diagnostic }, { type: "search-total-drift", ...diagnostic },
    ]);
    expect(searches).toHaveLength(2);
    expect(events.some((event) => event.type === "request-coalesced" && event.endpoint === "esearch")).toBe(true);
    // Only the two EFetch operations are cache-eligible.
    expect(cache.get).toHaveBeenCalledTimes(3);
    expect(cache.set).toHaveBeenCalledTimes(2);
  });

  it("keeps drifted continuation alive when one coalesced caller cancels", async () => {
    const { client, searches, events } = setup(reportedPages, { totalDriftPolicy: "warn" });
    const first = await client.search({ query: "cancellation", pageSize: 2 });
    const controller = new AbortController();
    const cancelled = client.search({ cursor: first.nextCursor!, signal: controller.signal }).catch((error: unknown) => error);
    const surviving = client.search({ cursor: first.nextCursor! });
    controller.abort();
    await expect(cancelled).resolves.toBeInstanceOf(AbortedError);
    await expect(surviving).resolves.toMatchObject({ diagnostics: [diagnostic] });
    expect(searches).toHaveLength(2);
    expect(events.filter((event) => event.type === "search-total-drift")).toHaveLength(1);
  });

  it("isolates throwing or mutating diagnostic event handlers", async () => {
    const { client } = setup(reportedPages, { totalDriftPolicy: "warn", onEvent: (event) => {
      if (event.type === "search-total-drift") {
        Reflect.set(event, "originalTotal", 0);
        throw new Error("callback failure");
      }
    } });
    const first = await client.search({ query: "callbacks", pageSize: 2 });
    const second = await client.search({ cursor: first.nextCursor! });
    expect(second.diagnostics).toEqual([diagnostic]);
  });

  it("retains the 10,000-ID window independently of total drift", async () => {
    const { client, searches } = setup([
      reportedPages[0]!, { total: 5_699_835, ids: ["7"] },
    ], { totalDriftPolicy: "warn" });
    const first = await client.search({ query: "window", pageSize: 2 });
    const nearLimit = Buffer.from(JSON.stringify({ ...decode(first.nextCursor!), offset: 9_999 })).toString("base64url");
    const last = await client.search({ cursor: nearLimit });
    expect(searches[1]?.get("retmax")).toBe("1");
    await expect(client.search({ cursor: last.nextCursor! })).rejects.toBeInstanceOf(SearchLimitError);
    expect(searches).toHaveLength(2);
  });

  it("validates the policy synchronously", () => {
    for (const totalDriftPolicy of [null, true, "ignore", {}, ""]) {
      expect(() => Reflect.construct(PubMedClient, [{ email: "a@test", tool: "test", totalDriftPolicy }])).toThrow(ValidationError);
    }
  });
});
