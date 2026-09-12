import { describe, expect, it, vi } from "vitest";
import { MemoryCache, PubMedClient, ValidationError } from "../src/index.js";
import type { PubMedClientOptions, PubMedEvent, PubMedRecord, RequestOptions } from "../src/index.js";

function articleXml(id: string): string {
  return `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>Title ${id}</ArticleTitle></Article></MedlineCitation></PubmedArticle>`;
}

function setXml(...ids: string[]): string {
  return `<PubmedArticleSet>${ids.map(articleXml).join("")}</PubmedArticleSet>`;
}

let sequence = 0;
function setup(options: Partial<PubMedClientOptions> = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const parameters = new URLSearchParams(String(init?.body ?? ""));
    if (String(input).includes("esearch.fcgi")) {
      const offset = Number(parameters.get("retstart") ?? 0);
      const size = Number(parameters.get("retmax") ?? 2);
      return new Response(JSON.stringify({ esearchresult: {
        count: "5", webenv: "history-token", querykey: "1",
        idlist: ["1", "2", "3", "4", "5"].slice(offset, offset + size),
      } }));
    }
    if (String(input).includes("elink.fcgi")) {
      return new Response(`<eLinkResult><LinkSet><IdUrlList><IdUrlSet><Id>1</Id><ObjUrl><Url>https://provider.test/full</Url></ObjUrl></IdUrlSet></IdUrlList></LinkSet></eLinkResult>`);
    }
    return new Response(setXml(...(parameters.get("id")?.split(",") ?? [])));
  });
  const client = new PubMedClient({
    email: "a@example.test", tool: "tests", apiKey: `raw-xml-${++sequence}`, fetch: fetchMock, ...options,
  });
  return { client, fetchMock };
}

function expectRawXml(record: PubMedRecord | null | undefined, included: boolean): void {
  if (record === null || record === undefined) throw new Error("expected a record");
  if (included) expect(record.rawXml).toBe(articleXml(record.pmid ?? ""));
  else expect(record).not.toHaveProperty("rawXml");
}

interface RawXmlCase {
  name: string;
  clientOptions: Partial<PubMedClientOptions>;
  requestOptions: RequestOptions;
  included: boolean;
}

const cases = [
  { name: "omitted by default", clientOptions: {}, requestOptions: {}, included: false },
  { name: "client opt-in", clientOptions: { includeRawXml: true }, requestOptions: {}, included: true },
  { name: "request opt-in", clientOptions: {}, requestOptions: { includeRawXml: true }, included: true },
  { name: "request disables client opt-in", clientOptions: { includeRawXml: true }, requestOptions: { includeRawXml: false }, included: false },
  { name: "request enables client opt-out", clientOptions: { includeRawXml: false }, requestOptions: { includeRawXml: true }, included: true },
] satisfies RawXmlCase[];

describe("raw XML output", () => {
  it.each(cases)("applies $name to get and getMany", async ({ clientOptions, requestOptions, included }) => {
    const { client, fetchMock } = setup(clientOptions);
    expectRawXml(await client.get("1", requestOptions), included);
    const batch = await client.getMany(["2", "1", "2"], requestOptions);
    expect(batch.records.map((record) => record.pmid)).toEqual(["2", "1", "2"]);
    for (const record of batch.records) expectRawXml(record, included);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new URLSearchParams(String(init?.body)).has("includeRawXml")).toBe(false);
    }
  });

  it.each(cases)("applies $name to initial search and cursor pages", async ({ clientOptions, requestOptions, included }) => {
    const { client } = setup(clientOptions);
    const first = await client.search({ query: "test", pageSize: 2, ...requestOptions });
    expect(first.records.map((record) => record.pmid)).toEqual(["1", "2"]);
    for (const record of first.records) expectRawXml(record, included);
    if (first.nextCursor === null) throw new Error("expected continuation cursor");
    const second = await client.search({ cursor: first.nextCursor, ...requestOptions });
    expect(second.records.map((record) => record.pmid)).toEqual(["3", "4"]);
    for (const record of second.records) expectRawXml(record, included);
  });

  it.each(cases)("applies $name to every searchAll page", async ({ clientOptions, requestOptions, included }) => {
    const { client } = setup(clientOptions);
    const pages = [];
    for await (const batch of client.searchAll({ query: "test", pageSize: 2, maxResults: 5, ...requestOptions })) {
      pages.push(batch);
      for (const record of batch.records) expectRawXml(record, included);
    }
    expect(pages.map((page) => page.records.map((record) => record.pmid))).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
  });

  it.each(cases)("preserves $name during LinkOut enrichment", async ({ clientOptions, requestOptions, included }) => {
    const { client } = setup(clientOptions);
    const record = await client.get("1", { ...requestOptions, includeLinkOuts: true });
    expectRawXml(record, included);
    expect(record?.links).toContainEqual(expect.objectContaining({ type: "linkout", url: "https://provider.test/full" }));
  });

  it("resolves cursor options independently of the initial search", async () => {
    const { client } = setup();
    const first = await client.search({ query: "test", pageSize: 2, includeRawXml: true });
    expectRawXml(first.records[0], true);
    if (first.nextCursor === null) throw new Error("expected continuation cursor");
    const second = await client.search({ cursor: first.nextCursor });
    expectRawXml(second.records[0], false);
    if (second.nextCursor === null) throw new Error("expected continuation cursor");
    const third = await client.search({ cursor: second.nextCursor, includeRawXml: true });
    expectRawXml(third.records[0], true);
  });

  it.each([false, true])("isolates mixed coalesced subscribers when includeRawXml=%s arrives first", async (firstIncluded) => {
    const events: PubMedEvent[] = [];
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async () => new Promise<Response>((resolve) => { release = resolve; }));
    const { client } = setup({ fetch: fetchMock, onEvent: (event) => events.push(event) });
    const first = client.get("1", { includeRawXml: firstIncluded });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = client.get("1", { includeRawXml: !firstIncluded });
    await vi.waitFor(() => expect(events.some((event) => event.type === "request-coalesced")).toBe(true));
    if (release === undefined) throw new Error("expected pending fetch");
    release(new Response(setXml("1")));
    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expectRawXml(firstRecord, firstIncluded);
    expectRawXml(secondRecord, !firstIncluded);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("isolates cache hits when includeRawXml=%s populates the cache", async (firstIncluded) => {
    const cache = new MemoryCache();
    const events: PubMedEvent[] = [];
    const { client, fetchMock } = setup({ cache, onEvent: (event) => events.push(event) });
    const first = await client.get("1", { includeRawXml: firstIncluded });
    expectRawXml(first, firstIncluded);
    await vi.waitFor(() => expect(cache.size).toBe(1));
    expectRawXml(await client.get("1", { includeRawXml: !firstIncluded }), !firstIncluded);
    expectRawXml(await client.get("1", { includeRawXml: firstIncluded }), firstIncluded);
    expectRawXml(first, firstIncluded);
    expect(events.filter((event) => event.type === "cache-hit")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, "true", 1, {}, []].map((includeRawXml) => ({ includeRawXml })))("rejects nonboolean includeRawXml: $includeRawXml before network access", async ({ includeRawXml }) => {
    const { client, fetchMock } = setup();
    expect(() => Reflect.construct(PubMedClient, [{ email: "a@example.test", tool: "tests", includeRawXml }]))
      .toThrow(ValidationError);
    await expect(Reflect.apply(client.get, client, ["1", { includeRawXml }])).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.getMany, client, [["1"], { includeRawXml }])).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.search, client, [{ query: "test", includeRawXml }])).rejects.toBeInstanceOf(ValidationError);
    const batches: ReturnType<PubMedClient["searchAll"]> = Reflect.apply(client.searchAll, client, [{ query: "test", maxResults: 1, includeRawXml }]);
    await expect(batches[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
