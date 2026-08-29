import { ValidationError } from "./errors.js";
import type { CitationFormat, CitationSource } from "./types.js";

interface CitationAuthor {
  readonly ris: string;
  readonly bibtex: string;
  readonly collective: boolean;
}

interface CitationData {
  readonly type: "article" | "chapter" | "book";
  readonly pmid?: string;
  readonly doi?: string;
  readonly title?: string;
  readonly containerTitle?: string;
  readonly containerAbbreviation?: string;
  readonly authors: readonly CitationAuthor[];
  readonly year?: string;
  readonly volume?: string;
  readonly issue?: string;
  readonly pages?: string;
  readonly articleNumber?: string;
  readonly publisher?: string;
  readonly publisherLocation?: string;
  readonly edition?: string;
  readonly serialNumbers: readonly string[];
  readonly url?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function values(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized === "" ? undefined : normalized;
}

function validPmid(value: unknown): string | undefined {
  const pmid = cleanText(value);
  return pmid !== undefined && /^[1-9][0-9]*$/.test(pmid) ? pmid : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const text = cleanText(value);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function yearFrom(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = cleanText(candidate);
    const year = value?.match(/(?:^|\D)((?:1[5-9]|20|21)[0-9]{2})(?:\D|$)/)?.[1];
    if (year !== undefined) return year;
  }
  return undefined;
}

function identifierValue(identifiers: unknown, ...types: readonly string[]): string | undefined {
  const expected = new Set(types.map((type) => type.toLowerCase()));
  for (const item of values(identifiers)) {
    const identifier = object(item);
    const type = cleanText(identifier?.type);
    const value = cleanText(identifier?.value);
    if (type !== undefined && value !== undefined && expected.has(type.toLowerCase())) return value;
  }
  return undefined;
}

function recordAuthors(value: unknown): readonly CitationAuthor[] {
  return values(value).flatMap((item): readonly CitationAuthor[] => {
    const author = object(item);
    if (author?.type === "collective") {
      const name = cleanText(author.name);
      return name === undefined ? [] : [{ ris: name, bibtex: name, collective: true }];
    }
    const lastName = cleanText(author?.lastName);
    const foreName = cleanText(author?.foreName) ?? cleanText(author?.initials);
    const suffix = cleanText(author?.suffix);
    const risStructured = [lastName, foreName, suffix]
      .filter((part) => part !== undefined && part !== "")
      .join(", ");
    const bibtexStructured = [lastName, suffix, foreName]
      .filter((part) => part !== undefined && part !== "")
      .join(", ");
    const fullName = cleanText(author?.fullName);
    const ris = risStructured === "" ? fullName : risStructured;
    const bibtex = bibtexStructured === "" ? fullName : bibtexStructured;
    return ris === undefined || bibtex === undefined ? [] : [{ ris, bibtex, collective: false }];
  });
}

function summaryBibTexName(name: string): string {
  if (name.includes(",")) return name;
  const parts = name.split(" ");
  const suffixPattern = /^(?:Jr\.?|Sr\.?|I{2,3}|IV)$/i;
  const possibleSuffix = parts.at(-1);
  const suffix = possibleSuffix !== undefined && suffixPattern.test(possibleSuffix) ? possibleSuffix : undefined;
  const initialsIndex = suffix === undefined ? parts.length - 1 : parts.length - 2;
  const initials = initialsIndex > 0 ? parts[initialsIndex] : undefined;
  const familyName = initials === undefined ? undefined : parts.slice(0, initialsIndex).join(" ");
  if (familyName === undefined || familyName === "") return name;
  return suffix === undefined ? `${familyName}, ${initials}` : `${familyName}, ${suffix}, ${initials}`;
}

function summaryAuthors(value: unknown): readonly CitationAuthor[] {
  return values(value).flatMap((item): readonly CitationAuthor[] => {
    const author = object(item);
    const name = cleanText(author?.name);
    if (name === undefined) return [];
    const authorType = cleanText(author?.type)?.toLowerCase() ?? "";
    const collective = authorType.includes("collective");
    return [{ ris: name, bibtex: collective ? name : summaryBibTexName(name), collective }];
  });
}

function recordYear(record: Record<string, unknown>, journal: Record<string, unknown> | undefined): string | undefined {
  const dates = object(record.dates);
  const publicationDate = object(journal?.pubDate);
  const electronic = object(dates?.electronic);
  const print = object(dates?.print);
  const completed = object(dates?.completed);
  return yearFrom(
    publicationDate?.year,
    publicationDate?.medlineDate,
    electronic?.year,
    electronic?.medlineDate,
    print?.year,
    print?.medlineDate,
    completed?.year,
    completed?.medlineDate,
  );
}

function canonicalRecordUrl(record: Record<string, unknown>, pmid: string | undefined): string | undefined {
  for (const item of values(record.links)) {
    const link = object(item);
    if (link?.type === "pubmed" && link.provenance === "canonical") {
      const url = safeUrl(link.url);
      if (url !== undefined) return url;
    }
  }
  return pmid === undefined ? undefined : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

function mapArticle(record: Record<string, unknown>): CitationData {
  const journal = object(record.journal);
  const pmid = validPmid(record.pmid) ?? validPmid(identifierValue(record.identifiers, "pubmed", "pmid"));
  const doi = cleanText(record.doi) ?? identifierValue(record.identifiers, "doi");
  const issn = cleanText(journal?.issn);
  const title = cleanText(record.title);
  const containerTitle = cleanText(journal?.title);
  const containerAbbreviation = cleanText(journal?.isoAbbreviation);
  const year = recordYear(record, journal);
  const volume = cleanText(journal?.volume);
  const issue = cleanText(journal?.issue);
  const pages = cleanText(journal?.pagination);
  const url = canonicalRecordUrl(record, pmid);
  return {
    type: "article",
    authors: recordAuthors(record.authors),
    serialNumbers: issn === undefined ? [] : [issn],
    ...(pmid === undefined ? {} : { pmid }),
    ...(doi === undefined ? {} : { doi }),
    ...(title === undefined ? {} : { title }),
    ...(containerTitle === undefined ? {} : { containerTitle }),
    ...(containerAbbreviation === undefined ? {} : { containerAbbreviation }),
    ...(year === undefined ? {} : { year }),
    ...(volume === undefined ? {} : { volume }),
    ...(issue === undefined ? {} : { issue }),
    ...(pages === undefined ? {} : { pages }),
    ...(url === undefined ? {} : { url }),
  };
}

function mapBook(record: Record<string, unknown>): CitationData {
  const book = object(record.book);
  const pmid = validPmid(record.pmid) ?? validPmid(identifierValue(record.identifiers, "pubmed", "pmid"));
  const doi = cleanText(record.doi) ?? identifierValue(record.identifiers, "doi");
  const recordTitle = cleanText(record.title);
  const bookTitle = cleanText(book?.title);
  const type = recordTitle === undefined ? "book" : "chapter";
  const title = recordTitle ?? bookTitle;
  const containerTitle = type === "chapter" ? bookTitle : undefined;
  const serialNumbers = values(book?.isbn).flatMap((item) => cleanText(item) ?? []);
  const year = recordYear(record, undefined);
  const publisher = cleanText(book?.publisher);
  const publisherLocation = cleanText(book?.location);
  const edition = cleanText(book?.edition);
  const url = canonicalRecordUrl(record, pmid);
  return {
    type,
    authors: recordAuthors(record.authors),
    serialNumbers,
    ...(pmid === undefined ? {} : { pmid }),
    ...(doi === undefined ? {} : { doi }),
    ...(title === undefined ? {} : { title }),
    ...(containerTitle === undefined ? {} : { containerTitle }),
    ...(year === undefined ? {} : { year }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(publisherLocation === undefined ? {} : { publisherLocation }),
    ...(edition === undefined ? {} : { edition }),
    ...(url === undefined ? {} : { url }),
  };
}

function mapSummary(summary: Record<string, unknown>): CitationData {
  const journal = object(summary.journal);
  const book = object(summary.book);
  const summaryTitle = cleanText(summary.title);
  const bookContainer = cleanText(book?.title) ?? cleanText(book?.name);
  const type = book === undefined ? "article" : summaryTitle === undefined ? "book" : "chapter";
  const title = type === "book" ? bookContainer : summaryTitle;
  const pmid = validPmid(summary.pmid) ?? validPmid(summary.uid);
  const doi = cleanText(summary.doi) ?? identifierValue(summary.identifiers, "doi");
  const serialNumbers = type !== "article"
    ? values(summary.identifiers).flatMap((item) => {
      const identifier = object(item);
      return cleanText(identifier?.type)?.toLowerCase() === "isbn" ? cleanText(identifier?.value) ?? [] : [];
    })
    : [cleanText(journal?.issn), cleanText(journal?.electronicIssn)].filter((value): value is string => value !== undefined);
  const availableUrl = safeUrl(summary.availableFromUrl);
  const canonicalUrl = pmid === undefined ? availableUrl : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  const journalTitle = cleanText(journal?.title);
  const journalAbbreviation = cleanText(journal?.abbreviation);
  const containerTitle = type === "chapter" ? bookContainer : type === "article" ? journalTitle : undefined;
  const year = yearFrom(summary.publicationDate, summary.electronicPublicationDate, summary.sortPublicationDate);
  const volume = cleanText(journal?.volume);
  const issue = cleanText(journal?.issue);
  const pages = cleanText(journal?.pages);
  const articleNumber = cleanText(summary.electronicLocationId);
  const publisher = cleanText(book?.publisher) ?? cleanText(summary.publisher);
  const publisherLocation = cleanText(book?.location) ?? cleanText(summary.publisherLocation);
  const edition = cleanText(book?.edition) ?? cleanText(summary.edition);
  return {
    type,
    authors: summaryAuthors(summary.authors),
    serialNumbers,
    ...(pmid === undefined ? {} : { pmid }),
    ...(doi === undefined ? {} : { doi }),
    ...(title === undefined ? {} : { title }),
    ...(containerTitle === undefined ? {} : { containerTitle }),
    ...(type === "article" && journalAbbreviation !== undefined ? { containerAbbreviation: journalAbbreviation } : {}),
    ...(year === undefined ? {} : { year }),
    ...(volume === undefined ? {} : { volume }),
    ...(issue === undefined ? {} : { issue }),
    ...(pages === undefined ? {} : { pages }),
    ...(articleNumber === undefined ? {} : { articleNumber }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(publisherLocation === undefined ? {} : { publisherLocation }),
    ...(edition === undefined ? {} : { edition }),
    ...(canonicalUrl === undefined ? {} : { url: canonicalUrl }),
  };
}

function citationData(source: unknown): CitationData {
  const record = object(source);
  if (record?.kind === "article") return mapArticle(record);
  if (record?.kind === "book") return mapBook(record);
  if (record?.kind === "summary") return mapSummary(record);
  throw new ValidationError("citation source must be a PubMed article, book record, or summary");
}

function addRis(lines: string[], tag: string, value: string | undefined): void {
  if (value !== undefined) lines.push(`${tag}  - ${value}`);
}

function pageParts(pages: string | undefined): Readonly<{ start?: string; end?: string }> {
  if (pages === undefined) return {};
  const match = pages.match(/^(.+?)[-–—](.+)$/);
  return match?.[1] === undefined || match[2] === undefined
    ? { start: pages }
    : { start: match[1].trim(), end: match[2].trim() };
}

function formatRis(data: CitationData): string {
  const risType = data.type === "article" ? "JOUR" : data.type === "chapter" ? "CHAP" : "BOOK";
  const lines = [`TY  - ${risType}`];
  addRis(lines, "TI", data.title);
  for (const author of data.authors) addRis(lines, "AU", author.ris);
  addRis(lines, data.type === "article" ? "JF" : "T2", data.containerTitle);
  if (data.type === "article") addRis(lines, "JA", data.containerAbbreviation);
  addRis(lines, "PY", data.year);
  addRis(lines, "VL", data.volume);
  addRis(lines, "IS", data.issue);
  const pages = pageParts(data.pages);
  addRis(lines, "SP", pages.start);
  addRis(lines, "EP", pages.end);
  addRis(lines, "C7", data.articleNumber);
  addRis(lines, "ET", data.edition);
  addRis(lines, "PB", data.publisher);
  addRis(lines, "CY", data.publisherLocation);
  for (const serialNumber of data.serialNumbers) addRis(lines, "SN", serialNumber);
  addRis(lines, "DO", data.doi);
  addRis(lines, "AN", data.pmid === undefined ? undefined : `PMID:${data.pmid}`);
  addRis(lines, "UR", data.url);
  lines.push("ER  -");
  return lines.join("\n");
}

function escapeBibTex(value: string): string {
  let escaped = "";
  for (const character of value) {
    switch (character) {
      case "\\": escaped += "\\textbackslash{}"; break;
      case "{": escaped += "\\{"; break;
      case "}": escaped += "\\}"; break;
      case "#": case "$": case "%": case "&": case "_": escaped += `\\${character}`; break;
      case "~": escaped += "\\textasciitilde{}"; break;
      case "^": escaped += "\\textasciicircum{}"; break;
      default: escaped += character;
    }
  }
  return escaped;
}

function bibKey(data: CitationData): string {
  if (data.pmid !== undefined) return `pubmed${data.pmid}`;
  const basis = data.doi ?? data.title ?? data.containerTitle ?? "citation";
  const slug = basis.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "").slice(0, 48);
  return slug === "" ? "citation" : slug;
}

function addBib(fields: Array<readonly [string, string]>, name: string, value: string | undefined): void {
  if (value !== undefined) fields.push([name, value]);
}

function bibTexAuthors(authors: readonly CitationAuthor[]): string | undefined {
  if (authors.length === 0) return undefined;
  return authors.map((author) => {
    const escaped = escapeBibTex(author.bibtex);
    return author.collective ? `{${escaped}}` : escaped;
  }).join(" and ");
}

function formatBibTex(data: CitationData, key = bibKey(data)): string {
  const fields: Array<readonly [string, string]> = [];
  const renderedAuthors = bibTexAuthors(data.authors);
  if (renderedAuthors !== undefined) fields.push(["author", renderedAuthors]);
  addBib(fields, "title", data.title);
  addBib(fields, data.type === "article" ? "journal" : "booktitle", data.containerTitle);
  addBib(fields, "year", data.year);
  addBib(fields, "volume", data.volume);
  addBib(fields, "number", data.issue);
  addBib(fields, "pages", data.pages?.replace(/[-–—]+/g, "--"));
  addBib(fields, "eid", data.articleNumber);
  addBib(fields, "edition", data.edition);
  addBib(fields, "publisher", data.publisher);
  addBib(fields, "address", data.publisherLocation);
  addBib(fields, data.type === "article" ? "issn" : "isbn", data.serialNumbers.length === 0 ? undefined : data.serialNumbers.join(", "));
  addBib(fields, "doi", data.doi);
  addBib(fields, "pmid", data.pmid);
  addBib(fields, "url", data.url);
  const rendered = fields.map(([name, value]) => `  ${name} = {${name === "author" ? value : escapeBibTex(value)}}`).join(",\n");
  const entryType = data.type === "article" ? "article" : data.type === "chapter" ? "incollection" : "book";
  return `@${entryType}{${key},${rendered === "" ? "" : `\n${rendered}`}\n}`;
}

/** Formats one PubMed article, book record, or summary as deterministic RIS or BibTeX. */
export function formatCitation(source: CitationSource, format: CitationFormat): string {
  const data = citationData(source);
  if (format === "ris") return formatRis(data);
  if (format === "bibtex") return formatBibTex(data);
  throw new ValidationError('citation format must be "ris" or "bibtex"');
}

/** Formats citations in caller order, separated by one blank line. */
export function formatCitations(sources: readonly CitationSource[], format: CitationFormat): string {
  if (!Array.isArray(sources)) throw new ValidationError("citation sources must be an array");
  if (format !== "ris" && format !== "bibtex") throw new ValidationError('citation format must be "ris" or "bibtex"');
  const data = sources.map(citationData);
  if (format === "ris") return data.map(formatRis).join("\n\n");
  const keyOccurrences = new Map<string, number>();
  return data.map((citation) => {
    const baseKey = bibKey(citation);
    const occurrence = (keyOccurrences.get(baseKey) ?? 0) + 1;
    keyOccurrences.set(baseKey, occurrence);
    return formatBibTex(citation, occurrence === 1 ? baseKey : `${baseKey}-${occurrence}`);
  }).join("\n\n");
}
