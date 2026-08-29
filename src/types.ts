import type { PubMedErrorCode } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface PubMedIdentifier {
  readonly type: string;
  readonly value: string;
  readonly provenance: "citation" | "article-id" | "book";
}

export interface PubMedLink {
  readonly url: string;
  readonly type: "pubmed" | "doi" | "pmc" | "linkout";
  readonly provenance: "canonical" | "ncbi-linkout";
  readonly provider?: Readonly<{
    name?: string;
    abbreviation?: string;
    id?: string;
  }>;
}

export interface PartialDate {
  readonly year?: string;
  readonly month?: string;
  readonly day?: string;
  readonly season?: string;
  readonly medlineDate?: string;
  readonly hour?: string;
  readonly minute?: string;
  readonly second?: string;
}

export interface AbstractSection {
  readonly text: string;
  readonly label?: string;
  readonly category?: string;
  /** @deprecated Copyright applies to the full abstract; use BasePubMedRecord.abstractCopyright. */
  readonly copyright?: string;
}

export interface Affiliation {
  readonly text: string;
  readonly identifiers: readonly PubMedIdentifier[];
}

export interface AuthorIdentifier {
  readonly source?: string;
  readonly value: string;
}

export interface PersonalAuthor {
  readonly type: "personal";
  readonly lastName?: string;
  readonly foreName?: string;
  readonly initials?: string;
  readonly suffix?: string;
  readonly fullName: string;
  readonly valid?: boolean;
  readonly affiliations: readonly Affiliation[];
  readonly identifiers: readonly AuthorIdentifier[];
  readonly orcid?: string;
}

export interface CollectiveAuthor {
  readonly type: "collective";
  readonly name: string;
  readonly affiliations: readonly Affiliation[];
  readonly identifiers: readonly AuthorIdentifier[];
}

export type PubMedAuthor = PersonalAuthor | CollectiveAuthor;

export interface JournalCitation {
  readonly title?: string;
  readonly isoAbbreviation?: string;
  readonly issn?: string;
  readonly issnType?: string;
  readonly volume?: string;
  readonly issue?: string;
  readonly pagination?: string;
  readonly pubDate?: PartialDate;
}

export interface PublicationHistoryEntry {
  readonly status: string;
  readonly date: PartialDate;
}

export interface PublicationDates {
  readonly completed?: PartialDate;
  readonly revised?: PartialDate;
  readonly electronic?: PartialDate;
  readonly print?: PartialDate;
  readonly history: readonly PublicationHistoryEntry[];
}

export interface MeshHeading {
  readonly descriptor: string;
  readonly descriptorUi?: string;
  readonly majorTopic?: boolean;
  readonly qualifiers: readonly Readonly<{
    name: string;
    ui?: string;
    majorTopic?: boolean;
  }>[];
}

export interface Keyword {
  readonly value: string;
  readonly owner?: string;
  readonly majorTopic?: boolean;
}

export interface PubMedWarning {
  readonly code: "UNKNOWN_RECORD" | "PARSE_WARNING";
  readonly message: string;
  readonly recordType?: string;
}

export interface BasePubMedRecord {
  readonly kind: "article" | "book" | "unknown";
  readonly recordType: string;
  readonly rawXml: string;
  readonly source: JsonObject;
  readonly identifiers: readonly PubMedIdentifier[];
  readonly links: readonly PubMedLink[];
  readonly pmid?: string;
  readonly doi?: string;
  readonly pmcid?: string;
  readonly title?: string;
  readonly abstract: readonly AbstractSection[];
  readonly abstractCopyright?: string;
  readonly authors: readonly PubMedAuthor[];
  readonly languages: readonly string[];
  readonly publicationTypes: readonly string[];
  readonly keywords: readonly Keyword[];
  readonly meshHeadings: readonly MeshHeading[];
  readonly dates: PublicationDates;
}

export interface PubMedArticleRecord extends BasePubMedRecord {
  readonly kind: "article";
  readonly recordType: "PubmedArticle";
  readonly vernacularTitle?: string;
  readonly journal?: JournalCitation;
  readonly citationStatus?: string;
}

export interface PubMedBookRecord extends BasePubMedRecord {
  readonly kind: "book";
  readonly recordType: "PubmedBookArticle";
  readonly book?: Readonly<{
    title?: string;
    collectionTitle?: string;
    publisher?: string;
    location?: string;
    edition?: string;
    isbn: readonly string[];
  }>;
}

export interface UnknownPubMedRecord extends BasePubMedRecord {
  readonly kind: "unknown";
}

export type PubMedRecord = PubMedArticleRecord | PubMedBookRecord | UnknownPubMedRecord;

export interface PubMedSummaryAuthor {
  readonly name: string;
  readonly type?: string;
  readonly clusterId?: string;
}

export interface PubMedSummaryIdentifier {
  readonly type: string;
  readonly value: string;
  readonly numericType?: number;
}

export interface PubMedSummaryHistoryEntry {
  readonly status: string;
  readonly date: string;
}

export interface PubMedSummaryJournal {
  readonly title?: string;
  readonly abbreviation?: string;
  readonly issn?: string;
  readonly electronicIssn?: string;
  readonly volume?: string;
  readonly issue?: string;
  readonly pages?: string;
}

export interface PubMedSummaryBook {
  readonly title?: string;
  readonly name?: string;
  readonly chapter?: string;
  readonly edition?: string;
  readonly publisher?: string;
  readonly location?: string;
}

/** Lightweight metadata returned by the PubMed ESummary endpoint. */
export interface PubMedSummary {
  readonly kind: "summary";
  readonly uid: string;
  readonly pmid: string;
  /** The validated JSON object for this UID, retained for forward compatibility. */
  readonly source: JsonObject;
  readonly title?: string;
  readonly sortTitle?: string;
  readonly authors: readonly PubMedSummaryAuthor[];
  readonly lastAuthor?: string;
  readonly sortFirstAuthor?: string;
  readonly journal?: PubMedSummaryJournal;
  readonly book?: PubMedSummaryBook;
  readonly publicationDate?: string;
  readonly electronicPublicationDate?: string;
  readonly sortPublicationDate?: string;
  /** Electronic article locator, for example an article number instead of page range. */
  readonly electronicLocationId?: string;
  readonly sourceDate?: string;
  readonly documentDate?: string;
  readonly languages: readonly string[];
  readonly publicationTypes: readonly string[];
  readonly identifiers: readonly PubMedSummaryIdentifier[];
  readonly history: readonly PubMedSummaryHistoryEntry[];
  readonly doi?: string;
  readonly pmcid?: string;
  readonly recordStatus?: string;
  readonly publicationStatus?: string;
  readonly documentType?: string;
  readonly medium?: string;
  readonly edition?: string;
  readonly publisher?: string;
  readonly publisherLocation?: string;
  readonly reportNumber?: string;
  readonly availableFromUrl?: string;
}

export interface SummaryBatchResult {
  readonly summaries: readonly PubMedSummary[];
  readonly missingPmids: readonly string[];
}

export type CitationFormat = "ris" | "bibtex";
export type CitationSource = PubMedArticleRecord | PubMedBookRecord | PubMedSummary;

export interface BatchResult {
  readonly records: readonly PubMedRecord[];
  readonly missingPmids: readonly string[];
  readonly warnings: readonly PubMedWarning[];
}

export interface SearchBatch extends BatchResult {
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface RequestOptions {
  readonly includeLinkOuts?: boolean;
  readonly signal?: AbortSignal;
}

export interface SummaryRequestOptions {
  readonly signal?: AbortSignal;
}

export interface SearchQueryOptions extends RequestOptions {
  readonly query: string;
  readonly pageSize?: number;
  readonly sort?: string;
  readonly cursor?: never;
}

export interface SearchCursorOptions extends RequestOptions {
  readonly cursor: string;
  readonly query?: never;
}

export type SearchOptions = SearchQueryOptions | SearchCursorOptions;

export interface SearchAllOptions extends RequestOptions {
  readonly query: string;
  readonly maxResults: number;
  readonly pageSize?: number;
  readonly sort?: string;
}

export interface CacheAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Optional best-effort invalidation used when a cached endpoint body fails validation. */
  delete?(key: string): Promise<void>;
}

export interface RateLimitBucket {
  readonly host: string;
  readonly credentialFingerprint: string;
  readonly requestsPerSecond: number;
}

export interface RateLimitCoordinator {
  acquire(bucket: RateLimitBucket, signal?: AbortSignal): Promise<void>;
  cooldown?(bucket: RateLimitBucket, delayMs: number): Promise<void>;
}

export type PubMedEndpoint = "esearch" | "esummary" | "efetch" | "elink";

export type PubMedEvent =
  | Readonly<{ type: "correlation-id"; endpoint: PubMedEndpoint; correlationId: string }>
  | Readonly<{ type: "cache-hit" | "cache-miss"; endpoint: PubMedEndpoint; correlationId: string }>
  | Readonly<{ type: "request-coalesced"; endpoint: PubMedEndpoint; correlationId: string; sharedCorrelationId: string }>
  | Readonly<{ type: "response-bytes"; endpoint: PubMedEndpoint; correlationId: string; attempt: number; bytes: number }>
  | Readonly<{ type: "terminal-failure"; endpoint: PubMedEndpoint; correlationId: string; errorCode: PubMedErrorCode | "UNKNOWN_ERROR" }>
  | Readonly<{ type: "request"; endpoint: PubMedEndpoint; status: number; durationMs: number; attempt: number; correlationId?: string }>
  | Readonly<{ type: "retry"; endpoint: PubMedEndpoint; attempt: number; delayMs: number; reason: "network" | "timeout" | "http"; correlationId?: string }>
  | Readonly<{ type: "queue-delay"; delayMs: number }>
  | Readonly<{ type: "rate-cooldown"; delayMs: number }>
  | Readonly<{ type: "parse-warning"; code: PubMedWarning["code"]; recordType?: string }>;

export interface PubMedClientOptions {
  readonly email: string;
  readonly tool: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly cache?: CacheAdapter;
  readonly rateLimitCoordinator?: RateLimitCoordinator;
  readonly onEvent?: (event: PubMedEvent) => void;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxResponseBytes?: number;
  readonly maxQueuedRequests?: number;
  readonly maxBatchSize?: number;
}
