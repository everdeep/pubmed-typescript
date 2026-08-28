import { describe, expect, it, vi } from "vitest";
import {
  AbortedError,
  CursorInvalidError,
  HttpError,
  PubMedClient,
  ResponseTooLargeError,
  SearchLimitError,
  ValidationError,
} from "../src/index.js";

function articleXml(id: string, title = `Title ${id}`): string {
  return `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>${title}</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${id}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;
}

function setXml(...records: readonly string[]): string {
  return `<PubmedArticleSet>${records.join("")}</PubmedArticleSet>`;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
}

function searchResponse(count: number, ids: readonly string[]): Response {
  return jsonResponse({ esearchresult: { count: String(count), webenv: "history-token", querykey: "1", idlist: ids } });
}

function requestParameters(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("PubMedClient", () => {
  it("validates identity, PMIDs, and runtime request options without consulting the environment", async () => {
    expect(() => new PubMedClient({ email: "", tool: "test" })).toThrow(ValidationError);
    expect(() => new PubMedClient({ email: "a@example.test", tool: "" })).toThrow(ValidationError);
    const fetchMock = vi.fn<typeof fetch>();
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "validation-key", fetch: fetchMock });
    await expect(client.get("01")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.getMany(["1", "x"])).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.get, client, ["1", null])).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.getMany, client, [["1"], "bad-options"])).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.search, client, [[]])).rejects.toBeInstanceOf(ValidationError);
    const invalidSearchAll = client.searchAll({ query: "", maxResults: 0 })[Symbol.asyncIterator]();
    await expect(invalidSearchAll.next()).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates network IDs while restoring input order, duplicates, and missing IDs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(setXml(articleXml("1"), articleXml("2"))));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "order-key", fetch: fetchMock });
    const result = await client.getMany(["2", "1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = requestParameters(fetchMock.mock.calls[0]?.[1]);
    expect(requested.get("id")).toBe("2,1,3");
    expect(result.records.map((record) => record.pmid)).toEqual(["2", "1", "2"]);
    expect(result.missingPmids).toEqual(["3"]);
  });

  it("returns null for a missing PMID and rejects aborts rather than partial data", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(setXml()));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "missing-key", fetch: fetchMock });
    await expect(client.get("999")).resolves.toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(client.getMany(["1"], { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
  });

  it("searches with history and resumes an encoded cursor in ranking order", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const endpoint = String(input);
      const parameters = requestParameters(init);
      if (endpoint.includes("esearch.fcgi") && parameters.get("retstart") === "2") return searchResponse(3, ["7"]);
      if (endpoint.includes("esearch.fcgi")) return searchResponse(3, ["9", "8"]);
      if (parameters.get("id") === "9,8") return new Response(setXml(articleXml("9"), articleXml("8")));
      if (parameters.get("id") === "7") return new Response(setXml(articleXml("7")));
      throw new Error("unexpected mocked request");
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "cursor-key", fetch: fetchMock });
    const first = await client.search({ query: "cancer[Title]", pageSize: 2, sort: "relevance" });
    expect(first.records.map((record) => record.pmid)).toEqual(["9", "8"]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain("cancer");

    const second = await client.search({ cursor: first.nextCursor ?? "" });
    expect(second.records.map((record) => record.pmid)).toEqual(["7"]);
    expect(second.nextCursor).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => requestParameters(init).get("retstart") === "2")).toBe(true);
    await expect(client.search({ cursor: "not a cursor" })).rejects.toBeInstanceOf(CursorInvalidError);
  });

  it("streams search batches up to required maxResults and guards the retrieval window", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const endpoint = String(input);
      const parameters = requestParameters(init);
      if (endpoint.includes("esearch.fcgi") && parameters.get("retstart") === "2") return searchResponse(3, ["3"]);
      if (endpoint.includes("esearch.fcgi") && parameters.get("term") === "normal") return searchResponse(3, ["1", "2"]);
      if (endpoint.includes("esearch.fcgi")) return searchResponse(10_001, ["1", "2"]);
      if (parameters.get("id") === "1,2") return new Response(setXml(articleXml("1"), articleXml("2")));
      return new Response(setXml(articleXml("3")));
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "stream-key", fetch: fetchMock });
    const ids: string[] = [];
    for await (const batch of client.searchAll({ query: "normal", maxResults: 3, pageSize: 2 })) {
      ids.push(...batch.records.flatMap((record) => record.pmid ?? []));
    }
    expect(ids).toEqual(["1", "2", "3"]);
    const oversized = client.searchAll({ query: "too-many", maxResults: 10_001, pageSize: 2 });
    await expect(oversized[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(SearchLimitError);
  });

  it("adds safe LinkOut links without dereferencing them", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("elink.fcgi")) {
        return new Response(`<eLinkResult><LinkSet><IdUrlList><IdUrlSet><Id>1</Id><ObjUrl><Url>https://provider.test/full</Url><Provider><Name>Provider</Name><NameAbbr>PRV</NameAbbr></Provider></ObjUrl><ObjUrl><Url>javascript:alert(1)</Url></ObjUrl></IdUrlSet></IdUrlList></LinkSet></eLinkResult>`);
      }
      return new Response(setXml(articleXml("1")));
    });
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "links-key", fetch: fetchMock });
    const record = await client.get("1", { includeLinkOuts: true });
    expect(record?.links).toContainEqual({ url: "https://provider.test/full", type: "linkout", provenance: "ncbi-linkout", provider: { name: "Provider", abbreviation: "PRV" } });
    expect(record?.links.some((link) => link.url.startsWith("javascript:"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries only retryable HTTP responses and keeps errors sanitized", async () => {
    const secret = "secret-api-key";
    const privateQuery = "private patient query";
    const events: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server detail containing secret", { status: 500 }))
      .mockResolvedValueOnce(new Response(setXml(articleXml("1"))));
    const client = new PubMedClient({ email: "private@example.test", tool: "tests", apiKey: secret, fetch: fetchMock, onEvent: (event) => events.push(event) });
    await expect(client.get("1")).resolves.toMatchObject({ pmid: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("private@example.test");

    const badFetch = vi.fn<typeof fetch>(async () => new Response(privateQuery, { status: 400 }));
    const badClient = new PubMedClient({ email: "private@example.test", tool: "tests", apiKey: "bad-http-key", fetch: badFetch });
    const error = await badClient.search({ query: privateQuery }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(JSON.stringify(error)).not.toContain(privateQuery);
    expect(JSON.stringify(error)).not.toContain("private@example.test");
    expect(badFetch).toHaveBeenCalledTimes(1);
  });

  it("incrementally enforces the configured response cap", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("01234567890"));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "cap-key", fetch: fetchMock, maxResponseBytes: 10 });
    await expect(client.get("1")).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
