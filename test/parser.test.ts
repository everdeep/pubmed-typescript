import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ParseError, parsePubMedXml } from "../src/index.js";

const fixtureUrl = new URL("./fixtures/pubmed.xml", import.meta.url);

describe("parsePubMedXml", () => {
  it("parses article, book, and unknown direct records without losing their XML", async () => {
    const xml = await readFile(fixtureUrl, "utf8");
    const parsed = parsePubMedXml(xml);
    expect(parsed.records).toHaveLength(4);

    const article = parsed.records[0];
    expect(article?.kind).toBe("article");
    if (article?.kind !== "article") throw new Error("expected article");
    expect(article.rawXml).toBe(xml.slice(xml.indexOf("<PubmedArticle data-note"), xml.indexOf("</PubmedArticle>") + "</PubmedArticle>".length));
    expect(article.title).toBe("A safe mixed title & result");
    expect(article.identifiers.map(({ type, value }) => [type, value])).toEqual([
      ["pubmed", "123"], ["pubmed", "123"], ["doi", "10.1000/test"], ["pmc", "PMC123"],
    ]);
    expect(article.pmid).toBe("123");
    expect(article.doi).toBe("10.1000/test");
    expect(article.pmcid).toBe("PMC123");
    expect(article.links.map((link) => link.type)).toEqual(["pubmed", "doi", "pmc"]);
    expect(article.abstract).toEqual([
      { text: "Why > what.", label: "BACKGROUND", category: "BACKGROUND" },
      { text: "It worked.", label: "RESULTS" },
    ]);
    expect(article.abstractCopyright).toBe("© 2024 Article Publisher");
    expect(article.abstract.every((section) => section.copyright === undefined)).toBe(true);
    expect(article.authors).toHaveLength(2);
    expect(article.authors[0]).toMatchObject({ type: "personal", fullName: "Jane Doe", orcid: "0000-0001-2345-6789" });
    expect(article.authors[1]).toMatchObject({ type: "collective", name: "Study Group" });
    expect(article.journal).toMatchObject({ title: "Journal of Tests", volume: "10", issue: "2", pagination: "1-9" });
    expect(article.dates).toMatchObject({ completed: { year: "2024", month: "01", day: "02" }, electronic: { year: "2023" } });
    expect(article.meshHeadings[0]).toMatchObject({ descriptor: "Tests", majorTopic: true });
    expect(JSON.parse(JSON.stringify(article))).toEqual(article);

    const book = parsed.records[1];
    expect(book?.kind).toBe("book");
    if (book?.kind !== "book") throw new Error("expected book");
    expect(book.title).toBe("Book chapter");
    expect(book.abstract).toEqual([{ text: "Book summary." }]);
    expect(book.abstractCopyright).toBe("© 2024 Book Publisher");
    expect(book.abstract.every((section) => section.copyright === undefined)).toBe(true);
    expect(book.book).toMatchObject({ title: "Handbook", publisher: "Publisher", isbn: ["978-1"] });

    const unknown = parsed.records[2];
    expect(unknown).toMatchObject({ kind: "unknown", recordType: "FuturePubmedRecord" });
    expect(unknown?.rawXml).toContain("future > data");
    expect(parsed.records[3]).toMatchObject({ kind: "unknown", recordType: "AnotherFuture", rawXml: "<AnotherFuture />" });
    expect(parsed.warnings).toEqual([
      { code: "UNKNOWN_RECORD", message: "Unknown PubMed record type: FuturePubmedRecord", recordType: "FuturePubmedRecord" },
      { code: "UNKNOWN_RECORD", message: "Unknown PubMed record type: AnotherFuture", recordType: "AnotherFuture" },
    ]);
  });

  it("decodes valid character references once and preserves CDATA literals", () => {
    const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>&#x1F600; &amp;#65; <![CDATA[&#xD800;]]></ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parsePubMedXml(xml).records[0]?.title).toBe("😀 &#65; &#xD800;");
  });

  it("rejects malformed framing and illegal numeric character references as ParseError", () => {
    expect(() => parsePubMedXml("<PubmedArticleSet><PubmedArticle></PubmedArticleSet>")).toThrow(ParseError);
    expect(() => parsePubMedXml("<OtherRoot />")).toThrow(ParseError);
    for (const reference of ["&#x110000;", "&#xD800;", "&#0;", "&#;", "&#x;"]) {
      const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>${reference}</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
      expect(() => parsePubMedXml(xml)).toThrow(ParseError);
    }
    expect(() => parsePubMedXml("<PubmedArticleSet><FutureRecord><Unused>&#xD800;</Unused></FutureRecord></PubmedArticleSet>"))
      .toThrow(ParseError);
  });
});
