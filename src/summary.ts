import { InvalidResponseError } from "./errors.js";
import type {
  JsonObject,
  PubMedSummary,
  PubMedSummaryAuthor,
  PubMedSummaryBook,
  PubMedSummaryHistoryEntry,
  PubMedSummaryIdentifier,
  PubMedSummaryJournal,
} from "./types.js";

const PMID_PATTERN = /^[1-9][0-9]*$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "" ? undefined : normalized;
}

function items(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringItems(value: unknown): readonly string[] {
  return items(value).flatMap((item) => scalarText(item) ?? []);
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  // This object came directly from JSON.parse, so its complete value graph is JSON-safe.
  // Retaining it avoids a second, recursive traversal of server-controlled nesting.
  return value as JsonObject;
}

function authors(value: unknown): readonly PubMedSummaryAuthor[] {
  return items(value).flatMap((item): readonly PubMedSummaryAuthor[] => {
    const author = object(item);
    const name = scalarText(author?.name);
    if (name === undefined) return [];
    const type = scalarText(author?.authtype);
    const clusterId = scalarText(author?.clusterid);
    return [{
      name,
      ...(type === undefined ? {} : { type }),
      ...(clusterId === undefined ? {} : { clusterId }),
    }];
  });
}

function identifiers(value: unknown, pmid: string): readonly PubMedSummaryIdentifier[] {
  const found = items(value).flatMap((item): readonly PubMedSummaryIdentifier[] => {
    const identifier = object(item);
    const type = scalarText(identifier?.idtype);
    const identifierValue = scalarText(identifier?.value);
    if (type === undefined || identifierValue === undefined) return [];
    const numericType = identifier?.idtypen;
    return [{
      type,
      value: identifierValue,
      ...(typeof numericType === "number" && Number.isSafeInteger(numericType) ? { numericType } : {}),
    }];
  });
  return found.some((identifier) => ["pubmed", "pmid"].includes(identifier.type.toLowerCase()))
    ? found
    : [{ type: "pubmed", value: pmid }, ...found];
}

function history(value: unknown): readonly PubMedSummaryHistoryEntry[] {
  return items(value).flatMap((item): readonly PubMedSummaryHistoryEntry[] => {
    const entry = object(item);
    const status = scalarText(entry?.pubstatus);
    const date = scalarText(entry?.date);
    return status === undefined || date === undefined ? [] : [{ status, date }];
  });
}

function journal(record: Record<string, unknown>): PubMedSummaryJournal | undefined {
  const title = scalarText(record.fulljournalname);
  const abbreviation = scalarText(record.source);
  const issn = scalarText(record.issn);
  const electronicIssn = scalarText(record.essn);
  const volume = scalarText(record.volume);
  const issue = scalarText(record.issue);
  const pages = scalarText(record.pages);
  if ((title ?? abbreviation ?? issn ?? electronicIssn ?? volume ?? issue ?? pages) === undefined) return undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(abbreviation === undefined ? {} : { abbreviation }),
    ...(issn === undefined ? {} : { issn }),
    ...(electronicIssn === undefined ? {} : { electronicIssn }),
    ...(volume === undefined ? {} : { volume }),
    ...(issue === undefined ? {} : { issue }),
    ...(pages === undefined ? {} : { pages }),
  };
}

function book(record: Record<string, unknown>): PubMedSummaryBook | undefined {
  const title = scalarText(record.booktitle);
  const name = scalarText(record.bookname);
  const chapter = scalarText(record.chapter);
  const edition = scalarText(record.edition);
  const publisher = scalarText(record.publishername);
  const location = scalarText(record.publisherlocation);
  if ((title ?? name ?? chapter ?? edition ?? publisher ?? location) === undefined) return undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(name === undefined ? {} : { name }),
    ...(chapter === undefined ? {} : { chapter }),
    ...(edition === undefined ? {} : { edition }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(location === undefined ? {} : { location }),
  };
}

function mapSummary(record: Record<string, unknown>, pmid: string): PubMedSummary {
  const mappedIdentifiers = identifiers(record.articleids, pmid);
  const findIdentifier = (...types: readonly string[]): string | undefined =>
    mappedIdentifiers.find((identifier) => types.includes(identifier.type.toLowerCase()))?.value;
  const title = scalarText(record.title);
  const sortTitle = scalarText(record.sorttitle);
  const lastAuthor = scalarText(record.lastauthor);
  const sortFirstAuthor = scalarText(record.sortfirstauthor);
  const publicationDate = scalarText(record.pubdate);
  const electronicPublicationDate = scalarText(record.epubdate);
  const sortPublicationDate = scalarText(record.sortpubdate);
  const electronicLocationId = scalarText(record.elocationid);
  const sourceDate = scalarText(record.srcdate);
  const documentDate = scalarText(record.docdate);
  const recordStatus = scalarText(record.recordstatus);
  const publicationStatus = scalarText(record.pubstatus);
  const documentType = scalarText(record.doctype);
  const medium = scalarText(record.medium);
  const edition = scalarText(record.edition);
  const publisher = scalarText(record.publishername);
  const publisherLocation = scalarText(record.publisherlocation);
  const reportNumber = scalarText(record.reportnumber);
  const availableFromUrl = scalarText(record.availablefromurl);
  const doi = findIdentifier("doi");
  const pmcid = findIdentifier("pmc", "pmcid");
  const mappedJournal = journal(record);
  const mappedBook = book(record);

  return {
    kind: "summary",
    uid: pmid,
    pmid,
    source: toJsonObject(record),
    authors: authors(record.authors),
    languages: stringItems(record.lang),
    publicationTypes: stringItems(record.pubtype),
    identifiers: mappedIdentifiers,
    history: history(record.history),
    ...(title === undefined ? {} : { title }),
    ...(sortTitle === undefined ? {} : { sortTitle }),
    ...(lastAuthor === undefined ? {} : { lastAuthor }),
    ...(sortFirstAuthor === undefined ? {} : { sortFirstAuthor }),
    ...(mappedJournal === undefined ? {} : { journal: mappedJournal }),
    ...(mappedBook === undefined ? {} : { book: mappedBook }),
    ...(publicationDate === undefined ? {} : { publicationDate }),
    ...(electronicPublicationDate === undefined ? {} : { electronicPublicationDate }),
    ...(sortPublicationDate === undefined ? {} : { sortPublicationDate }),
    ...(electronicLocationId === undefined ? {} : { electronicLocationId }),
    ...(sourceDate === undefined ? {} : { sourceDate }),
    ...(documentDate === undefined ? {} : { documentDate }),
    ...(doi === undefined ? {} : { doi }),
    ...(pmcid === undefined ? {} : { pmcid }),
    ...(recordStatus === undefined ? {} : { recordStatus }),
    ...(publicationStatus === undefined ? {} : { publicationStatus }),
    ...(documentType === undefined ? {} : { documentType }),
    ...(medium === undefined ? {} : { medium }),
    ...(edition === undefined ? {} : { edition }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(publisherLocation === undefined ? {} : { publisherLocation }),
    ...(reportNumber === undefined ? {} : { reportNumber }),
    ...(availableFromUrl === undefined ? {} : { availableFromUrl }),
  };
}

/** Parses and validates an ESummary JSON response for a known request batch. */
export function parseESummaryJson(body: string, expectedPmids: readonly string[]): readonly PubMedSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new InvalidResponseError("PubMed returned invalid summary metadata", { cause: error });
  }

  const result = object(object(parsed)?.result);
  const rawUids = result?.uids;
  if (result === undefined || !Array.isArray(rawUids)) {
    throw new InvalidResponseError("PubMed returned invalid summary metadata");
  }

  const expected = new Set(expectedPmids);
  const seen = new Set<string>();
  const summaries: PubMedSummary[] = [];
  for (const rawUid of rawUids) {
    if (typeof rawUid !== "string" || !PMID_PATTERN.test(rawUid) || !expected.has(rawUid) || seen.has(rawUid)) {
      throw new InvalidResponseError("PubMed returned summaries that did not match the requested PMIDs");
    }
    const record = object(result[rawUid]);
    if (record === undefined || record.uid !== rawUid) {
      throw new InvalidResponseError("PubMed returned summaries that did not match the requested PMIDs");
    }
    seen.add(rawUid);
    // ESummary represents some missing/deleted PMIDs as UID-scoped error objects.
    if (scalarText(record.error) !== undefined) continue;
    summaries.push(mapSummary(record, rawUid));
  }
  if (Object.keys(result).some((key) => PMID_PATTERN.test(key) && !seen.has(key))) {
    throw new InvalidResponseError("PubMed returned summaries that did not match the requested PMIDs");
  }
  return summaries;
}
