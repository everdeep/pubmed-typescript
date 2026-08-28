import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ParseError } from "./errors.js";
import type {
  AbstractSection,
  Affiliation,
  JsonObject,
  JsonValue,
  Keyword,
  MeshHeading,
  PartialDate,
  PubMedArticleRecord,
  PubMedAuthor,
  PubMedBookRecord,
  PubMedIdentifier,
  PubMedLink,
  PubMedRecord,
  PubMedWarning,
  PublicationDates,
  PublicationHistoryEntry,
} from "./types.js";

interface ParsedFragment {
  readonly name: string;
  readonly rawXml: string;
}

export interface ParsedPubMedXml {
  readonly records: readonly PubMedRecord[];
  readonly warnings: readonly PubMedWarning[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: false,
});

function markupEnd(xml: string, start: number): number {
  if (xml.startsWith("<!--", start)) {
    const end = xml.indexOf("-->", start + 4);
    if (end < 0) throw new ParseError();
    return end + 3;
  }
  if (xml.startsWith("<![CDATA[", start)) {
    const end = xml.indexOf("]]>", start + 9);
    if (end < 0) throw new ParseError();
    return end + 3;
  }
  if (xml.startsWith("<?", start)) {
    const end = xml.indexOf("?>", start + 2);
    if (end < 0) throw new ParseError();
    return end + 2;
  }

  let quote: string | undefined;
  let subsetDepth = 0;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      subsetDepth += 1;
    } else if (character === "]" && subsetDepth > 0) {
      subsetDepth -= 1;
    } else if (character === ">" && subsetDepth === 0) {
      return index + 1;
    }
  }
  throw new ParseError();
}

function tagDetails(token: string): { readonly kind: "start" | "end" | "other"; readonly name?: string; readonly selfClosing?: boolean } {
  if (token.startsWith("<!--") || token.startsWith("<![") || token.startsWith("<?") || /^<!DOCTYPE/i.test(token)) {
    return { kind: "other" };
  }
  const endMatch = /^<\/\s*([^\s>]+)\s*>$/.exec(token);
  if (endMatch?.[1] !== undefined) return { kind: "end", name: endMatch[1] };
  const startMatch = /^<\s*([^\s/>]+)/.exec(token);
  if (startMatch?.[1] === undefined) return { kind: "other" };
  return { kind: "start", name: startMatch[1], selfClosing: /\/\s*>$/.test(token) };
}

function extractFragments(xml: string): readonly ParsedFragment[] {
  validateNumericReferences(xml);
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw new ParseError();

  const fragments: ParsedFragment[] = [];
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let childStart = -1;
  let childName = "";
  let position = 0;

  while (position < xml.length) {
    const start = xml.indexOf("<", position);
    if (start < 0) break;
    const end = markupEnd(xml, start);
    const details = tagDetails(xml.slice(start, end));
    position = end;
    if (details.kind === "other") continue;

    if (details.kind === "start") {
      const name = details.name;
      if (name === undefined) throw new ParseError();
      if (!rootSeen) {
        if (name !== "PubmedArticleSet") throw new ParseError("Expected a PubmedArticleSet root element");
        rootSeen = true;
        if (details.selfClosing === true) rootClosed = true;
        else stack.push(name);
        continue;
      }
      if (rootClosed || stack.length === 0) throw new ParseError();
      if (stack.length === 1) {
        childStart = start;
        childName = name;
      }
      if (details.selfClosing === true) {
        if (stack.length === 1) fragments.push({ name, rawXml: xml.slice(start, end) });
      } else {
        stack.push(name);
      }
      continue;
    }

    const name = details.name;
    const expected = stack.at(-1);
    if (name === undefined || expected !== name) throw new ParseError();
    if (stack.length === 2) {
      if (childStart < 0) throw new ParseError();
      fragments.push({ name: childName, rawXml: xml.slice(childStart, end) });
      childStart = -1;
      childName = "";
    }
    stack.pop();
    if (stack.length === 0) rootClosed = true;
  }

  if (!rootSeen || !rootClosed || stack.length !== 0) throw new ParseError();
  return fragments;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function at(value: unknown, key: string): unknown {
  return object(value)?.[key];
}

function list(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeNumericReference(body: string): string {
  const hexadecimal = body.toLowerCase().startsWith("#x");
  const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (!Number.isSafeInteger(codePoint) || !isXmlCodePoint(codePoint)) throw new ParseError();
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    throw new ParseError();
  }
}

function validateNumericReferencesIn(value: string): void {
  let position = 0;
  while (true) {
    const start = value.indexOf("&#", position);
    if (start < 0) return;
    const match = /^&#(?:x[0-9a-f]+|[0-9]+);/i.exec(value.slice(start));
    const body = match?.[0].slice(1, -1);
    if (match === null || body === undefined) throw new ParseError();
    decodeNumericReference(body);
    position = start + match[0].length;
  }
}

function validateNumericReferences(xml: string): void {
  let position = 0;
  while (position < xml.length) {
    const markupStart = xml.indexOf("<", position);
    const textEnd = markupStart < 0 ? xml.length : markupStart;
    validateNumericReferencesIn(xml.slice(position, textEnd));
    if (markupStart < 0) return;

    const markupFinish = markupEnd(xml, markupStart);
    const token = xml.slice(markupStart, markupFinish);
    if (!token.startsWith("<![CDATA[") && !token.startsWith("<!--") && !token.startsWith("<?")) {
      validateNumericReferencesIn(token);
    }
    position = markupFinish;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#[0-9]+);/gi, (_entity, body: string): string => {
    const named = body.toLowerCase();
    if (named === "lt") return "<";
    if (named === "gt") return ">";
    if (named === "quot") return '"';
    if (named === "apos") return "'";
    if (named === "amp") return "&";
    return decodeNumericReference(body);
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value: string): string {
  return normalizeText(decodeEntities(value));
}

function rawElementTexts(xml: string, elementName: string): readonly string[] {
  const results: string[] = [];
  let position = 0;
  while (position < xml.length) {
    const candidate = xml.indexOf("<", position);
    if (candidate < 0) break;
    const openingEnd = markupEnd(xml, candidate);
    const opening = tagDetails(xml.slice(candidate, openingEnd));
    if (opening.kind !== "start" || opening.name !== elementName) {
      position = openingEnd;
      continue;
    }
    if (opening.selfClosing === true) {
      results.push("");
      position = openingEnd;
      continue;
    }

    let innerPosition = openingEnd;
    let depth = 1;
    const parts: string[] = [];
    while (innerPosition < xml.length) {
      const start = xml.indexOf("<", innerPosition);
      if (start < 0) return results;
      parts.push(decodeEntities(xml.slice(innerPosition, start)));
      const end = markupEnd(xml, start);
      const token = xml.slice(start, end);
      if (token.startsWith("<![CDATA[")) parts.push(token.slice(9, -3));
      const details = tagDetails(token);
      if (details.kind === "start" && details.selfClosing !== true) depth += 1;
      if (details.kind === "end") depth -= 1;
      innerPosition = end;
      if (depth === 0) {
        results.push(normalizeText(parts.join("")));
        position = end;
        break;
      }
    }
    if (depth !== 0) break;
  }
  return results;
}

function rawElementText(xml: string, elementName: string): string | undefined {
  const result = rawElementTexts(xml, elementName)[0];
  return result === undefined || result === "" ? undefined : result;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const result = cleanText(String(value));
    return result === "" ? undefined : result;
  }
  if (Array.isArray(value)) {
    const result = cleanText(value.map((item) => text(item) ?? "").join(" "));
    return result === "" ? undefined : result;
  }
  const record = object(value);
  if (record === undefined) return undefined;
  const parts: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (!key.startsWith("@")) parts.push(text(child) ?? "");
  }
  const result = cleanText(parts.join(" "));
  return result === "" ? undefined : result;
}

function attribute(value: unknown, name: string): string | undefined {
  return text(object(value)?.[`@${name}`]);
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(json);
  const record = object(value);
  if (record === undefined) return null;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(record)) {
    if (child !== undefined) result[key] = json(child);
  }
  return result;
}

function partialDate(value: unknown): PartialDate | undefined {
  const source = object(value);
  if (source === undefined) return undefined;
  const result: {
    year?: string; month?: string; day?: string; season?: string; medlineDate?: string;
    hour?: string; minute?: string; second?: string;
  } = {};
  const keys = ["Year", "Month", "Day", "Season", "MedlineDate", "Hour", "Minute", "Second"] as const;
  const targets = ["year", "month", "day", "season", "medlineDate", "hour", "minute", "second"] as const;
  keys.forEach((key, index) => {
    const found = text(source[key]);
    const target = targets[index];
    if (found !== undefined && target !== undefined) result[target] = found;
  });
  return Object.keys(result).length === 0 ? undefined : result;
}

function affiliations(author: unknown): readonly Affiliation[] {
  return list(at(author, "AffiliationInfo")).map((item) => {
    const identifiers = list(at(item, "Identifier")).flatMap((identifier): readonly PubMedIdentifier[] => {
      const value = text(identifier);
      return value === undefined ? [] : [{ type: attribute(identifier, "Source") ?? "unknown", value, provenance: "citation" }];
    });
    return { text: text(at(item, "Affiliation")) ?? "", identifiers };
  }).filter((item) => item.text !== "" || item.identifiers.length > 0);
}

function authors(value: unknown): readonly PubMedAuthor[] {
  return list(at(value, "Author")).flatMap((author): readonly PubMedAuthor[] => {
    const collectiveName = text(at(author, "CollectiveName"));
    const identifiers = list(at(author, "Identifier")).flatMap((identifier) => {
      const identifierText = text(identifier);
      const source = attribute(identifier, "Source");
      return identifierText === undefined ? [] : [{ value: identifierText, ...(source === undefined ? {} : { source }) }];
    });
    const common = { affiliations: affiliations(author), identifiers };
    if (collectiveName !== undefined) return [{ type: "collective", name: collectiveName, ...common }];
    const lastName = text(at(author, "LastName"));
    const foreName = text(at(author, "ForeName"));
    const initials = text(at(author, "Initials"));
    const suffix = text(at(author, "Suffix"));
    const fullName = [foreName ?? initials, lastName, suffix].filter((part): part is string => part !== undefined).join(" ");
    if (fullName === "") return [];
    const orcid = identifiers.find((identifier) => identifier.source?.toLowerCase() === "orcid")?.value;
    return [{
      type: "personal",
      fullName,
      ...common,
      ...(lastName === undefined ? {} : { lastName }),
      ...(foreName === undefined ? {} : { foreName }),
      ...(initials === undefined ? {} : { initials }),
      ...(suffix === undefined ? {} : { suffix }),
      ...(attribute(author, "ValidYN") === undefined ? {} : { valid: attribute(author, "ValidYN") === "Y" }),
      ...(orcid === undefined ? {} : { orcid }),
    }];
  });
}

function abstracts(value: unknown, rawXml: string): readonly AbstractSection[] {
  const rawTexts = rawElementTexts(rawXml, "AbstractText");
  return list(at(value, "AbstractText")).flatMap((section, index): readonly AbstractSection[] => {
    const rawText = rawTexts[index];
    const sectionText = rawText === undefined || rawText === "" ? text(section) : rawText;
    if (sectionText === undefined) return [];
    const label = attribute(section, "Label");
    const category = attribute(section, "NlmCategory");
    return [{ text: sectionText, ...(label === undefined ? {} : { label }), ...(category === undefined ? {} : { category }) }];
  });
}

function meshHeadings(value: unknown): readonly MeshHeading[] {
  return list(at(value, "MeshHeading")).flatMap((heading): readonly MeshHeading[] => {
    const descriptorNode = at(heading, "DescriptorName");
    const descriptor = text(descriptorNode);
    if (descriptor === undefined) return [];
    const descriptorUi = attribute(descriptorNode, "UI");
    const descriptorMajor = attribute(descriptorNode, "MajorTopicYN");
    const qualifiers = list(at(heading, "QualifierName")).flatMap((qualifier) => {
      const name = text(qualifier);
      if (name === undefined) return [];
      const ui = attribute(qualifier, "UI");
      const major = attribute(qualifier, "MajorTopicYN");
      return [{ name, ...(ui === undefined ? {} : { ui }), ...(major === undefined ? {} : { majorTopic: major === "Y" }) }];
    });
    return [{ descriptor, qualifiers, ...(descriptorUi === undefined ? {} : { descriptorUi }), ...(descriptorMajor === undefined ? {} : { majorTopic: descriptorMajor === "Y" }) }];
  });
}

function keywords(value: unknown): readonly Keyword[] {
  return list(value).flatMap((keywordList) => {
    const owner = attribute(keywordList, "Owner");
    return list(at(keywordList, "Keyword")).flatMap((keyword): readonly Keyword[] => {
      const found = text(keyword);
      if (found === undefined) return [];
      const major = attribute(keyword, "MajorTopicYN");
      return [{ value: found, ...(owner === undefined ? {} : { owner }), ...(major === undefined ? {} : { majorTopic: major === "Y" }) }];
    });
  });
}

function identifiers(pmidNode: unknown, articleIds: unknown, provenance: "article-id" | "book"): readonly PubMedIdentifier[] {
  const result: PubMedIdentifier[] = [];
  const pmid = text(pmidNode);
  if (pmid !== undefined) result.push({ type: "pubmed", value: pmid, provenance: "citation" });
  for (const id of list(at(articleIds, "ArticleId"))) {
    const value = text(id);
    if (value !== undefined) result.push({ type: attribute(id, "IdType") ?? "unknown", value, provenance });
  }
  return result;
}

function conveniences(ids: readonly PubMedIdentifier[]): { readonly pmid?: string; readonly doi?: string; readonly pmcid?: string } {
  const find = (...types: readonly string[]): string | undefined => ids.find((id) => types.includes(id.type.toLowerCase()))?.value;
  const pmid = find("pubmed", "pmid");
  const doi = find("doi");
  const pmcid = find("pmc", "pmcid");
  return { ...(pmid === undefined ? {} : { pmid }), ...(doi === undefined ? {} : { doi }), ...(pmcid === undefined ? {} : { pmcid }) };
}

function canonicalLinks(ids: readonly PubMedIdentifier[]): readonly PubMedLink[] {
  const values = conveniences(ids);
  const links: PubMedLink[] = [];
  if (values.pmid !== undefined && /^[1-9][0-9]*$/.test(values.pmid)) {
    links.push({ url: `https://pubmed.ncbi.nlm.nih.gov/${values.pmid}/`, type: "pubmed", provenance: "canonical" });
  }
  if (values.doi !== undefined) {
    links.push({ url: `https://doi.org/${encodeURIComponent(values.doi)}`, type: "doi", provenance: "canonical" });
  }
  if (values.pmcid !== undefined && /^PMC[1-9][0-9]*$/i.test(values.pmcid)) {
    links.push({ url: `https://pmc.ncbi.nlm.nih.gov/articles/${values.pmcid.toUpperCase()}/`, type: "pmc", provenance: "canonical" });
  }
  return links;
}

function dates(citation: unknown, article: unknown, pubmedData: unknown): PublicationDates {
  const history: PublicationHistoryEntry[] = list(at(at(pubmedData, "History"), "PubMedPubDate")).flatMap((entry) => {
    const date = partialDate(entry);
    return date === undefined ? [] : [{ status: attribute(entry, "PubStatus") ?? "unknown", date }];
  });
  const articleDates = list(at(article, "ArticleDate"));
  const electronic = partialDate(articleDates.find((entry) => (attribute(entry, "DateType") ?? "").toLowerCase() === "electronic"));
  const journalPubDate = partialDate(at(at(at(article, "Journal"), "JournalIssue"), "PubDate"));
  const pubModel = attribute(article, "PubModel")?.toLowerCase();
  const print = pubModel?.includes("print") === true ? journalPubDate : undefined;
  const completed = partialDate(at(citation, "DateCompleted"));
  const revised = partialDate(at(citation, "DateRevised"));
  return {
    history,
    ...(completed === undefined ? {} : { completed }),
    ...(revised === undefined ? {} : { revised }),
    ...(electronic === undefined ? {} : { electronic }),
    ...(print === undefined ? {} : { print }),
  };
}

function parseArticle(root: Record<string, unknown>, rawXml: string): PubMedArticleRecord {
  const citation = at(root, "MedlineCitation");
  const article = at(citation, "Article");
  const pubmedData = at(root, "PubmedData");
  const baseIds = identifiers(at(citation, "PMID"), at(pubmedData, "ArticleIdList"), "article-id");
  const citationIds: PubMedIdentifier[] = [
    ...list(at(article, "ELocationID")).flatMap((identifier): readonly PubMedIdentifier[] => {
      const value = text(identifier);
      return value === undefined ? [] : [{ type: attribute(identifier, "EIdType") ?? "elocation", value, provenance: "citation" }];
    }),
    ...list(at(citation, "OtherID")).flatMap((identifier): readonly PubMedIdentifier[] => {
      const value = text(identifier);
      return value === undefined ? [] : [{ type: attribute(identifier, "Source") ?? "other", value, provenance: "citation" }];
    }),
  ];
  const [firstId, ...remainingIds] = baseIds;
  const ids = firstId === undefined ? citationIds : [firstId, ...citationIds, ...remainingIds];
  const values = conveniences(ids);
  const journalNode = at(article, "Journal");
  const issueNode = at(journalNode, "JournalIssue");
  const journalTitle = text(at(journalNode, "Title"));
  const isoAbbreviation = text(at(journalNode, "ISOAbbreviation"));
  const issn = text(at(journalNode, "ISSN"));
  const issnType = attribute(at(journalNode, "ISSN"), "IssnType");
  const volume = text(at(issueNode, "Volume"));
  const issue = text(at(issueNode, "Issue"));
  const pagination = text(at(at(article, "Pagination"), "MedlinePgn"));
  const pubDate = partialDate(at(issueNode, "PubDate"));
  const title = rawElementText(rawXml, "ArticleTitle") ?? text(at(article, "ArticleTitle"));
  const vernacularTitle = text(at(article, "VernacularTitle"));
  const citationStatus = attribute(citation, "Status");
  const abstractNode = at(article, "Abstract");
  const abstractCopyright = text(at(abstractNode, "CopyrightInformation"));
  const journal = {
    ...(journalTitle === undefined ? {} : { title: journalTitle }),
    ...(isoAbbreviation === undefined ? {} : { isoAbbreviation }),
    ...(issn === undefined ? {} : { issn }),
    ...(issnType === undefined ? {} : { issnType }),
    ...(volume === undefined ? {} : { volume }),
    ...(issue === undefined ? {} : { issue }),
    ...(pagination === undefined ? {} : { pagination }),
    ...(pubDate === undefined ? {} : { pubDate }),
  };
  return {
    kind: "article",
    recordType: "PubmedArticle",
    rawXml,
    source: json(root) as JsonObject,
    identifiers: ids,
    links: canonicalLinks(ids),
    abstract: abstracts(abstractNode, rawXml),
    ...(abstractCopyright === undefined ? {} : { abstractCopyright }),
    authors: authors(at(article, "AuthorList")),
    languages: list(at(article, "Language")).flatMap((item) => text(item) ?? []),
    publicationTypes: list(at(at(article, "PublicationTypeList"), "PublicationType")).flatMap((item) => text(item) ?? []),
    keywords: keywords(at(citation, "KeywordList")),
    meshHeadings: meshHeadings(at(citation, "MeshHeadingList")),
    dates: dates(citation, article, pubmedData),
    journal,
    ...values,
    ...(title === undefined ? {} : { title }),
    ...(vernacularTitle === undefined ? {} : { vernacularTitle }),
    ...(citationStatus === undefined ? {} : { citationStatus }),
  };
}

function parseBook(root: Record<string, unknown>, rawXml: string): PubMedBookRecord {
  const document = at(root, "BookDocument");
  const pubmedBookData = at(root, "PubmedBookData");
  const ids = identifiers(at(document, "PMID"), at(pubmedBookData, "ArticleIdList"), "book");
  const values = conveniences(ids);
  const bookNode = at(document, "Book");
  const publisher = at(bookNode, "Publisher");
  const bookTitle = text(at(bookNode, "BookTitle"));
  const collectionTitle = text(at(bookNode, "CollectionTitle"));
  const publisherName = text(at(publisher, "PublisherName"));
  const publisherLocation = text(at(publisher, "PublisherLocation"));
  const edition = text(at(bookNode, "Edition"));
  const title = rawElementText(rawXml, "ArticleTitle") ?? text(at(document, "ArticleTitle"));
  const abstractNode = at(document, "Abstract");
  const abstractCopyright = text(at(abstractNode, "CopyrightInformation"));
  return {
    kind: "book",
    recordType: "PubmedBookArticle",
    rawXml,
    source: json(root) as JsonObject,
    identifiers: ids,
    links: canonicalLinks(ids),
    abstract: abstracts(abstractNode, rawXml),
    ...(abstractCopyright === undefined ? {} : { abstractCopyright }),
    authors: authors(at(document, "AuthorList")),
    languages: list(at(document, "Language")).flatMap((item) => text(item) ?? []),
    publicationTypes: list(at(at(document, "PublicationTypeList"), "PublicationType")).flatMap((item) => text(item) ?? []),
    keywords: keywords(at(document, "KeywordList")),
    meshHeadings: [],
    dates: dates(document, document, pubmedBookData),
    book: {
      isbn: list(at(bookNode, "Isbn")).flatMap((item) => text(item) ?? []),
      ...(bookTitle === undefined ? {} : { title: bookTitle }),
      ...(collectionTitle === undefined ? {} : { collectionTitle }),
      ...(publisherName === undefined ? {} : { publisher: publisherName }),
      ...(publisherLocation === undefined ? {} : { location: publisherLocation }),
      ...(edition === undefined ? {} : { edition }),
    },
    ...values,
    ...(title === undefined ? {} : { title }),
  };
}

function parseFragment(fragment: ParsedFragment): PubMedRecord {
  let parsed: unknown;
  try {
    parsed = parser.parse(fragment.rawXml) as unknown;
  } catch {
    throw new ParseError();
  }
  const document = object(parsed);
  const rootValue = document?.[fragment.name];
  const root = object(rootValue);
  if (fragment.name === "PubmedArticle") {
    if (root === undefined) throw new ParseError();
    return parseArticle(root, fragment.rawXml);
  }
  if (fragment.name === "PubmedBookArticle") {
    if (root === undefined) throw new ParseError();
    return parseBook(root, fragment.rawXml);
  }
  const source: JsonObject = root === undefined ? { value: json(rootValue) } : json(root) as JsonObject;
  return {
    kind: "unknown",
    recordType: fragment.name,
    rawXml: fragment.rawXml,
    source,
    identifiers: [],
    links: [],
    abstract: [],
    authors: [],
    languages: [],
    publicationTypes: [],
    keywords: [],
    meshHeadings: [],
    dates: { history: [] },
  };
}

/** Parse an entire PubmedArticleSet while retaining each direct child byte-for-byte. */
export function parsePubMedXml(xml: string): ParsedPubMedXml {
  const records = extractFragments(xml).map(parseFragment);
  const warnings = records.flatMap((record): readonly PubMedWarning[] => record.kind === "unknown"
    ? [{ code: "UNKNOWN_RECORD", message: `Unknown PubMed record type: ${record.recordType}`, recordType: record.recordType }]
    : []);
  return { records, warnings };
}
