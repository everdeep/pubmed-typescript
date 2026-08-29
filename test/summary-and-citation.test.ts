import { describe, expect, it, vi } from "vitest";
import {
  AbortedError,
  formatCitation,
  formatCitations,
  InvalidResponseError,
  parsePubMedXml,
  PubMedClient,
  ValidationError,
} from "../src/index.js";
import type { CitationFormat, PubMedEvent, PubMedSummary } from "../src/index.js";

function summaryRecord(uid: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    uid,
    title: `Title ${uid}`,
    authors: [{ name: "Smith J", authtype: "Author", clusterid: "1" }],
    lastauthor: "Smith J",
    pubdate: "2024 Jan",
    epubdate: "2023 Dec 12",
    source: "J Test",
    fulljournalname: "Journal of Tests",
    volume: "12",
    issue: "3",
    pages: "10-19",
    elocationid: "e12345",
    lang: ["eng"],
    pubtype: ["Journal Article"],
    articleids: [
      { idtype: "pubmed", idtypen: 1, value: uid },
      { idtype: "doi", idtypen: 3, value: `10.1000/${uid}` },
    ],
    history: [{ pubstatus: "received", date: "2023/10/01 00:00" }],
    recordstatus: "PubMed - indexed for MEDLINE",
    pubstatus: "4",
    doctype: "citation",
    ...overrides,
  };
}

function summaryResponse(uids: readonly string[], records: Readonly<Record<string, Record<string, unknown>>>): Response {
  return new Response(JSON.stringify({ result: { uids, ...records } }), {
    headers: { "content-type": "application/json" },
  });
}

function requestParameters(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("ESummary", () => {
  it("retrieves typed summaries while preserving input order, duplicates, and missing PMIDs", async () => {
    const events: PubMedEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () => summaryResponse(
      ["2", "1"],
      { "1": summaryRecord("1"), "2": summaryRecord("2") },
    ));
    const client = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "summary-order-key",
      fetch: fetchMock,
      onEvent: (event) => events.push(event),
    });

    const result = await client.getManySummaries(["2", "1", "2", "3"]);

    expect(result.summaries.map((summary) => summary.pmid)).toEqual(["2", "1", "2"]);
    expect(result.missingPmids).toEqual(["3"]);
    expect(result.summaries[0]).toMatchObject({
      kind: "summary",
      uid: "2",
      pmid: "2",
      title: "Title 2",
      authors: [{ name: "Smith J", type: "Author", clusterId: "1" }],
      journal: { title: "Journal of Tests", abbreviation: "J Test", volume: "12", issue: "3", pages: "10-19" },
      publicationDate: "2024 Jan",
      electronicPublicationDate: "2023 Dec 12",
      electronicLocationId: "e12345",
      languages: ["eng"],
      publicationTypes: ["Journal Article"],
      doi: "10.1000/2",
    });
    expect(result.summaries[0]?.source.title).toBe("Title 2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
    const parameters = requestParameters(fetchMock.mock.calls[0]?.[1]);
    expect(parameters.get("id")).toBe("2,1,3");
    expect(parameters.get("retmode")).toBe("json");
    expect(parameters.get("version")).toBe("2.0");
    expect(events).toContainEqual(expect.objectContaining({ type: "response-bytes", endpoint: "esummary" }));
  });

  it("returns one summary or null and makes no request for an empty batch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => summaryResponse(["1"], { "1": summaryRecord("1") }));
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "summary-single-key", fetch: fetchMock });
    await expect(client.getSummary("1")).resolves.toMatchObject({ pmid: "1" });
    await expect(client.getManySummaries([])).resolves.toEqual({ summaries: [], missingPmids: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const missingClient = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "summary-missing-key",
      fetch: vi.fn<typeof fetch>(async () => summaryResponse(["9"], { "9": { uid: "9", error: "cannot get document summary" } })),
    });
    await expect(missingClient.getSummary("9")).resolves.toBeNull();
  });

  it("batches requests and tolerates malformed optional fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const ids = requestParameters(init).get("id")?.split(",") ?? [];
      return summaryResponse(ids, Object.fromEntries(ids.map((id) => [id, summaryRecord(id, {
        authors: [null, { name: 42 }, { name: "Valid Author" }],
        lang: { malformed: true },
        pubtype: false,
        articleids: [{ idtype: "doi" }, { idtype: "pmc", value: "PMC123" }],
        history: [{ pubstatus: "received" }],
      })])));
    });
    const client = new PubMedClient({
      email: "a@example.test",
      tool: "tests",
      apiKey: "summary-batch-key",
      fetch: fetchMock,
      maxBatchSize: 2,
    });

    const result = await client.getManySummaries(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.summaries).toHaveLength(3);
    expect(result.summaries[0]).toMatchObject({
      authors: [{ name: "Valid Author" }],
      languages: [],
      publicationTypes: [],
      history: [],
      pmcid: "PMC123",
    });
    expect(result.summaries[0]?.identifiers).toContainEqual({ type: "pubmed", value: "1" });
  });

  it("rejects invalid envelopes and mismatched summary identities", async () => {
    const responses = [
      new Response("not-json"),
      new Response(JSON.stringify({ result: {} })),
      summaryResponse(["2"], { "2": summaryRecord("2") }),
      summaryResponse(["1", "1"], { "1": summaryRecord("1") }),
      summaryResponse(["1"], { "1": summaryRecord("2") }),
      summaryResponse(["1"], { "1": summaryRecord(" 1 ") }),
    ];
    for (const [index, response] of responses.entries()) {
      const client = new PubMedClient({
        email: "a@example.test",
        tool: "tests",
        apiKey: `summary-invalid-${index}`,
        fetch: vi.fn<typeof fetch>(async () => response),
      });
      await expect(client.getSummary("1")).rejects.toBeInstanceOf(InvalidResponseError);
    }
  });

  it("validates input and cancellation consistently with record retrieval", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new PubMedClient({ email: "a@example.test", tool: "tests", apiKey: "summary-validation-key", fetch: fetchMock });
    await expect(client.getSummary("01")).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.getManySummaries, client, ["1"])).rejects.toBeInstanceOf(ValidationError);
    await expect(Reflect.apply(client.getSummary, client, ["1", { includeLinkOuts: true }])).rejects.toBeInstanceOf(ValidationError);
    const controller = new AbortController();
    controller.abort();
    await expect(client.getManySummaries(["1"], { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("citation export", () => {
  const articleXml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Journal><ISSN>1234-5678</ISSN><JournalIssue><Volume>12</Volume><Issue>3</Issue><PubDate><Year>2024</Year></PubDate></JournalIssue><Title>Journal of Tests</Title><ISOAbbreviation>J Test</ISOAbbreviation></Journal><ArticleTitle>Safe Article</ArticleTitle><Pagination><MedlinePgn>10-19</MedlinePgn></Pagination><AuthorList><Author><LastName>Smith</LastName><ForeName>Jane</ForeName></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">1</ArticleId><ArticleId IdType="doi">10.1000/test</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
  const article = parsePubMedXml(articleXml).records[0];
  if (article?.kind !== "article") throw new Error("article fixture did not parse");

  const summary: PubMedSummary = {
    kind: "summary",
    uid: "2",
    pmid: "2",
    source: {},
    title: "Summary Article",
    authors: [{ name: "Doe J" }],
    journal: { title: "Summary Journal", volume: "2", pages: "5-7" },
    publicationDate: "2023 Mar",
    languages: ["eng"],
    publicationTypes: ["Journal Article"],
    identifiers: [{ type: "pubmed", value: "2" }, { type: "doi", value: "10.1000/summary" }],
    history: [],
    doi: "10.1000/summary",
  };

  it("serializes deterministic RIS", () => {
    expect(formatCitation(article, "ris")).toBe([
      "TY  - JOUR",
      "TI  - Safe Article",
      "AU  - Smith, Jane",
      "JF  - Journal of Tests",
      "JA  - J Test",
      "PY  - 2024",
      "VL  - 12",
      "IS  - 3",
      "SP  - 10",
      "EP  - 19",
      "SN  - 1234-5678",
      "DO  - 10.1000/test",
      "AN  - PMID:1",
      "UR  - https://pubmed.ncbi.nlm.nih.gov/1/",
      "ER  -",
    ].join("\n"));
  });

  it("serializes deterministic BibTeX and preserves batch order and duplicates", () => {
    const expected = [
      "@article{pubmed2,",
      "  author = {Doe, J},",
      "  title = {Summary Article},",
      "  journal = {Summary Journal},",
      "  year = {2023},",
      "  volume = {2},",
      "  pages = {5--7},",
      "  doi = {10.1000/summary},",
      "  pmid = {2},",
      "  url = {https://pubmed.ncbi.nlm.nih.gov/2/}",
      "}",
    ].join("\n");
    expect(formatCitation(summary, "bibtex")).toBe(expected);
    expect(formatCitations([summary, summary], "bibtex")).toBe(`${expected}\n\n${expected.replace("pubmed2,", "pubmed2-2,")}`);
    expect(formatCitations([], "ris")).toBe("");
  });

  it("keeps ESummary personal, suffixed, and collective authors valid in BibTeX", () => {
    const withAuthors: PubMedSummary = {
      ...summary,
      authors: [
        { name: "de Silva AB", type: "Author" },
        { name: "Smith J Jr", type: "Author" },
        { name: "Alpha and Beta Consortium", type: "CollectiveName" },
      ],
    };
    expect(formatCitation(withAuthors, "bibtex")).toContain(
      "author = {de Silva, AB and Smith, Jr, J and {Alpha and Beta Consortium}}",
    );

    const suffixed = parsePubMedXml(articleXml.replace("</ForeName>", "</ForeName><Suffix>Jr</Suffix>")).records[0];
    expect(suffixed).toBeDefined();
    expect(formatCitation(suffixed as typeof article, "ris")).toContain("AU  - Smith, Jane, Jr");
    expect(formatCitation(suffixed as typeof article, "bibtex")).toContain("author = {Smith, Jr, Jane}");
  });

  it("does not misclassify journal book reviews and uses electronic locators", () => {
    const bookReview: PubMedSummary = {
      ...summary,
      publicationTypes: ["Book Review"],
      journal: { title: "Review Journal" },
      electronicLocationId: "e42",
    };
    const ris = formatCitation(bookReview, "ris");
    expect(ris).toContain("TY  - JOUR");
    expect(ris).toContain("C7  - e42");
    const bibtex = formatCitation(bookReview, "bibtex");
    expect(bibtex).toContain("@article{pubmed2,");
    expect(bibtex).toContain("eid = {e42}");
  });

  it("emits whole books separately from parsed book chapters", () => {
    const { title: _title, journal: _journal, ...base } = summary;
    const wholeBook: PubMedSummary = {
      ...base,
      uid: "4",
      pmid: "4",
      publicationTypes: ["Book"],
      book: { title: "Whole Book", publisher: "Publisher" },
    };
    expect(formatCitation(wholeBook, "ris")).toContain("TY  - BOOK");
    expect(formatCitation(wholeBook, "bibtex")).toContain("@book{pubmed4,");
    expect(formatCitation(wholeBook, "bibtex")).toContain("title = {Whole Book}");

    const chapterXml = `<PubmedArticleSet><PubmedBookArticle><BookDocument><PMID>5</PMID><ArticleTitle>Chapter Five</ArticleTitle><Book><BookTitle>Collected Tests</BookTitle><Publisher><PublisherName>Test Press</PublisherName></Publisher></Book></BookDocument><PubmedBookData><ArticleIdList><ArticleId IdType="pubmed">5</ArticleId></ArticleIdList></PubmedBookData></PubmedBookArticle></PubmedArticleSet>`;
    const chapter = parsePubMedXml(chapterXml).records[0];
    if (chapter?.kind !== "book") throw new Error("book fixture did not parse");
    expect(formatCitation(chapter, "ris")).toContain("TY  - CHAP");
    const bibtex = formatCitation(chapter, "bibtex");
    expect(bibtex).toContain("@incollection{pubmed5,");
    expect(bibtex).toContain("booktitle = {Collected Tests}");
  });

  it("uses book-specific fields and neutralizes RIS and BibTeX injection", () => {
    const hostile: PubMedSummary = {
      ...summary,
      uid: "3",
      pmid: "3",
      title: "Unsafe\nER  - injected {title} \\ value",
      book: { title: "Test Book", publisher: "Publisher", location: "Place", edition: "2" },
    };
    const ris = formatCitation(hostile, "ris");
    expect(ris).toContain("TY  - CHAP");
    expect(ris).toContain("TI  - Unsafe ER - injected {title} \\ value");
    expect(ris.match(/^ER  -/gm)).toHaveLength(1);
    expect(ris).toContain("T2  - Test Book");

    const bibtex = formatCitation(hostile, "bibtex");
    expect(bibtex).toContain("@incollection{pubmed3,");
    expect(bibtex).toContain("Unsafe ER - injected \\{title\\} \\textbackslash{} value");
  });

  it("validates runtime formats and sources", () => {
    expect(() => formatCitation(summary, "csl" as CitationFormat)).toThrow(ValidationError);
    expect(() => Reflect.apply(formatCitation, undefined, [{ kind: "unknown" }, "ris"])).toThrow(ValidationError);
    expect(() => Reflect.apply(formatCitations, undefined, [{}, "ris"])).toThrow(ValidationError);
  });
});
