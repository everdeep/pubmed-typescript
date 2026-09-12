import { XMLParser } from "fast-xml-parser";
import {
  AbortedError,
  CursorExpiredError,
  CursorInvalidError,
  InvalidResponseError,
  PaginationConsistencyError,
  SearchLimitError,
  ValidationError,
} from "./errors.js";
import { parsePubMedXml } from "./parser.js";
import { safeEvent } from "./rate-limiter.js";
import { parseESummaryJson } from "./summary.js";
import { Transport } from "./transport.js";
import type {
  BatchResult,
  PubMedClientOptions,
  PubMedLink,
  PubMedRecord,
  PubMedSummary,
  PubMedWarning,
  RequestOptions,
  SearchAllOptions,
  SearchBatch,
  SearchOptions,
  SearchQueryOptions,
  SearchTotalDriftDiagnostic,
  SummaryBatchResult,
  SummaryRequestOptions,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_BATCH_SIZE = 200;
const SEARCH_WINDOW = 10_000;
const CURSOR_TTL_MS = 8 * 60 * 60_000;
const CURSOR_FUTURE_SKEW_MS = 5 * 60_000;

interface CursorData {
  readonly v: 1;
  readonly webEnv: string;
  readonly queryKey: string;
  readonly total: number;
  readonly offset: number;
  readonly pageSize: number;
  readonly issuedAt: number;
}

interface SearchState {
  readonly total: number;
  readonly webEnv: string;
  readonly queryKey: string;
  readonly ids: readonly string[];
}

interface SearchPage {
  readonly batch: SearchBatch;
  readonly expectedPmids: readonly string[];
}

const linkParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
});

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function list(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const result = String(value).trim();
    return result === "" ? undefined : result;
  }
  const record = object(value);
  return record === undefined ? undefined : text(record["#text"]);
}

function positiveInteger(value: number, name: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new ValidationError(`${name} must be a positive integer${maximum === undefined ? "" : ` no greater than ${maximum}`}`);
  }
  return value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  const candidate = object(value);
  return typeof candidate?.aborted === "boolean" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function";
}

function validateRequestOptions(options: unknown, name: string): asserts options is RequestOptions {
  const candidate = object(options);
  if (candidate === undefined) throw new ValidationError(`${name} must be an object`);
  if (candidate.includeRawXml !== undefined && typeof candidate.includeRawXml !== "boolean") {
    throw new ValidationError("includeRawXml must be a boolean");
  }
  if (candidate.includeLinkOuts !== undefined && typeof candidate.includeLinkOuts !== "boolean") {
    throw new ValidationError("includeLinkOuts must be a boolean");
  }
  if (candidate.signal !== undefined && !isAbortSignal(candidate.signal)) {
    throw new ValidationError("signal must be an AbortSignal");
  }
}

function validateSummaryRequestOptions(options: unknown): asserts options is SummaryRequestOptions {
  const candidate = object(options);
  if (candidate === undefined) throw new ValidationError("summary request options must be an object");
  if (candidate.includeRawXml !== undefined) {
    throw new ValidationError("includeRawXml is not supported for summary requests");
  }
  if (candidate.includeLinkOuts !== undefined) {
    throw new ValidationError("includeLinkOuts is not supported for summary requests");
  }
  if (candidate.signal !== undefined && !isAbortSignal(candidate.signal)) {
    throw new ValidationError("signal must be an AbortSignal");
  }
}

function validateAdapterShapes(value: unknown): void {
  const options = object(value);
  if (options === undefined) throw new ValidationError("PubMedClient options are required");
  if (options.cache !== undefined) {
    const cache = object(options.cache);
    if (
      cache === undefined ||
      typeof cache.get !== "function" ||
      typeof cache.set !== "function" ||
      (cache.delete !== undefined && typeof cache.delete !== "function")
    ) {
      throw new ValidationError("cache must provide get and set functions, and delete must be a function when provided");
    }
  }

  if (options.rateLimitCoordinator !== undefined) {
    const coordinator = object(options.rateLimitCoordinator);
    if (
      coordinator === undefined ||
      typeof coordinator.acquire !== "function" ||
      (coordinator.cooldown !== undefined && typeof coordinator.cooldown !== "function")
    ) {
      throw new ValidationError("rateLimitCoordinator must provide an acquire function, and cooldown must be a function when provided");
    }
  }

  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new ValidationError("onEvent must be a function");
  }
}

function validateQueryOptions(options: SearchQueryOptions | SearchAllOptions): void {
  validateRequestOptions(options, "search options");
  if (typeof options.query !== "string" || options.query.trim() === "") throw new ValidationError("query is required");
  if (options.pageSize !== undefined) positiveInteger(options.pageSize, "pageSize", MAX_BATCH_SIZE);
  if (options.sort !== undefined && (typeof options.sort !== "string" || options.sort.trim() === "")) {
    throw new ValidationError("sort must be a non-empty string");
  }
}

function validatePmid(pmid: string): string {
  if (typeof pmid !== "string" || !/^[1-9][0-9]*$/.test(pmid)) throw new ValidationError("PMIDs must contain only digits and may not begin with zero");
  return pmid;
}

function encodeCursor(cursor: CursorData): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorData {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const data = object(parsed);
    if (
      data?.v !== 1 || typeof data.webEnv !== "string" || data.webEnv === "" ||
      typeof data.queryKey !== "string" || data.queryKey === "" ||
      typeof data.total !== "number" || !Number.isSafeInteger(data.total) || data.total < 1 ||
      typeof data.offset !== "number" || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.offset >= data.total ||
      typeof data.pageSize !== "number" || !Number.isSafeInteger(data.pageSize) || data.pageSize < 1 || data.pageSize > MAX_BATCH_SIZE ||
      typeof data.issuedAt !== "number" || !Number.isSafeInteger(data.issuedAt) || data.issuedAt < 0 ||
      data.issuedAt > Date.now() + CURSOR_FUTURE_SKEW_MS
    ) throw new CursorInvalidError();
    if (Date.now() - data.issuedAt > CURSOR_TTL_MS) throw new CursorExpiredError();
    return {
      v: 1,
      webEnv: data.webEnv,
      queryKey: data.queryKey,
      total: data.total,
      offset: data.offset,
      pageSize: data.pageSize,
      issuedAt: data.issuedAt,
    };
  } catch (error) {
    if (error instanceof CursorExpiredError || error instanceof CursorInvalidError) throw error;
    throw new CursorInvalidError();
  }
}

function stringLeaves(value: unknown): readonly string[] {
  const found: string[] = [];
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0 && found.length < 100 && visited < 1_000) {
    const current = pending.pop();
    visited += 1;
    if (typeof current === "string") {
      const normalized = current.trim();
      if (normalized !== "") found.push(normalized);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        if (pending.length >= 1_000) break;
        pending.push(item);
      }
      continue;
    }
    const record = object(current);
    if (record === undefined) continue;
    for (const key in record) {
      if (pending.length >= 1_000) break;
      if (Object.prototype.hasOwnProperty.call(record, key)) pending.push(record[key]);
    }
  }
  return found;
}

function searchErrorMessages(value: unknown): readonly string[] {
  const root = object(value);
  const result = object(root?.esearchresult);
  return [root?.error, root?.ERROR, root?.errorlist, result?.error, result?.ERROR, result?.errorlist]
    .flatMap(stringLeaves);
}

function isExpiredHistoryMessage(message: string): boolean {
  const historyReference = /(?:history|webenv|query(?:[\s_-]*key|\s*#))/i;
  const unavailableReference = /(?:expired|invalid|unknown|missing|not\s+found|not\s+available|does\s+not\s+exist|cannot\s+find|could\s+not\s+find|unable\s+to\s+(?:find|obtain))/i;
  return historyReference.test(message) && unavailableReference.test(message);
}

function parseSearchResponse(body: string, cursorContext = false): SearchState {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new InvalidResponseError("PubMed returned invalid search metadata");
  }
  if (cursorContext && searchErrorMessages(value).some(isExpiredHistoryMessage)) {
    throw new CursorExpiredError();
  }
  const result = object(object(value)?.esearchresult);
  const countText = result?.count;
  const queryKeyValue = result?.querykey;
  const rawIds = result?.idlist;
  if (
    typeof countText !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(countText) ||
    !Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) ||
    typeof queryKeyValue !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(queryKeyValue)
  ) {
    throw new InvalidResponseError("PubMed returned invalid search metadata");
  }
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) throw new InvalidResponseError("PubMed returned invalid search metadata");
  const webEnv = typeof result?.webenv === "string" ? result.webenv : "";
  const queryKey = queryKeyValue;
  const ids = rawIds;
  if (count > 0 && (webEnv === "" || !/^[1-9][0-9]*$/.test(queryKey) || ids.length === 0)) {
    throw new InvalidResponseError("PubMed did not return complete search history metadata");
  }
  return { total: count, webEnv, queryKey, ids };
}

function validateSearchState(state: SearchState, expectedIds: number, offset = 0): void {
  if (
    state.total < offset + state.ids.length ||
    state.ids.length !== expectedIds ||
    new Set(state.ids).size !== state.ids.length
  ) {
    throw new InvalidResponseError("PubMed returned an incomplete search ID page");
  }
}

function parseExpectedFetch(body: string, expectedPmids: readonly string[]): ReturnType<typeof parsePubMedXml> {
  // Shared decoders retain XML; each caller projects its own output after coalescing.
  const parsed = parsePubMedXml(body, { includeRawXml: true });
  const expected = new Set(expectedPmids);
  const seen = new Set<string>();
  for (const record of parsed.records) {
    if (record.pmid === undefined) {
      if (record.kind !== "unknown") {
        throw new InvalidResponseError("PubMed returned a recognized record without a PMID");
      }
      if (/^error(?:list)?$/i.test(record.recordType)) {
        throw new InvalidResponseError("PubMed returned an error response instead of requested records");
      }
      continue;
    }
    if (!expected.has(record.pmid) || seen.has(record.pmid)) {
      throw new InvalidResponseError("PubMed returned records that did not match the requested PMIDs");
    }
    seen.add(record.pmid);
  }
  return parsed;
}

function safeHttpLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseLinkOutResponse(xml: string): ReadonlyMap<string, readonly PubMedLink[]> {
  let parsed: unknown;
  try {
    parsed = linkParser.parse(xml) as unknown;
  } catch {
    throw new InvalidResponseError("PubMed returned invalid LinkOut metadata");
  }
  const root = object(object(parsed)?.eLinkResult) ?? object(object(parsed)?.ELinkResult);
  if (root === undefined) throw new InvalidResponseError("PubMed returned invalid LinkOut metadata");
  const result = new Map<string, PubMedLink[]>();
  const idUrlLists = [
    ...list(root.IdUrlList),
    ...list(root.LinkSet).flatMap((linkSet) => list(object(linkSet)?.IdUrlList)),
  ];
  for (const idUrlList of idUrlLists) {
    for (const idSet of list(object(idUrlList)?.IdUrlSet)) {
      const id = text(object(idSet)?.Id);
      if (id === undefined) continue;
      const links = result.get(id) ?? [];
      for (const objectUrl of list(object(idSet)?.ObjUrl)) {
        const node = object(objectUrl);
        const rawUrl = text(node?.Url);
        const url = rawUrl === undefined ? undefined : safeHttpLink(rawUrl);
        if (url === undefined) continue;
        const providerNode = object(node?.Provider);
        const name = text(providerNode?.Name);
        const abbreviation = text(providerNode?.NameAbbr);
        const providerId = text(providerNode?.Id);
        links.push({
          url,
          type: "linkout",
          provenance: "ncbi-linkout",
          ...((name ?? abbreviation ?? providerId) === undefined ? {} : {
            provider: {
              ...(name === undefined ? {} : { name }),
              ...(abbreviation === undefined ? {} : { abbreviation }),
              ...(providerId === undefined ? {} : { id: providerId }),
            },
          }),
        });
      }
      result.set(id, links);
    }
  }
  return result;
}

function withLinks(record: PubMedRecord, extra: readonly PubMedLink[]): PubMedRecord {
  if (extra.length === 0) return record;
  return { ...record, links: [...record.links, ...extra] };
}

export class PubMedClient {
  readonly #transport: Transport;
  readonly #maxBatchSize: number;
  readonly #includeRawXml: boolean;
  readonly #totalDriftPolicy: "error" | "warn";
  readonly #onEvent: PubMedClientOptions["onEvent"];

  public constructor(options: PubMedClientOptions) {
    if (typeof options !== "object" || options === null) throw new ValidationError("PubMedClient options are required");
    validateAdapterShapes(options);
    if (options.includeRawXml !== undefined && typeof options.includeRawXml !== "boolean") {
      throw new ValidationError("includeRawXml must be a boolean");
    }
    this.#includeRawXml = options.includeRawXml ?? false;
    if (options.totalDriftPolicy !== undefined && options.totalDriftPolicy !== "error" && options.totalDriftPolicy !== "warn") {
      throw new ValidationError('totalDriftPolicy must be "error" or "warn"');
    }
    this.#totalDriftPolicy = options.totalDriftPolicy ?? "warn";
    if (typeof options.email !== "string" || options.email.trim() === "") throw new ValidationError("email is required");
    if (typeof options.tool !== "string" || options.tool.trim() === "") throw new ValidationError("tool is required");
    if (options.apiKey !== undefined && (typeof options.apiKey !== "string" || options.apiKey.trim() === "")) {
      throw new ValidationError("apiKey must be a non-empty string");
    }
    const timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs");
    const maxAttempts = positiveInteger(options.maxAttempts ?? 4, "maxAttempts");
    const maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 25 * 1024 * 1024, "maxResponseBytes");
    const maxQueuedRequests = positiveInteger(options.maxQueuedRequests ?? 1_000, "maxQueuedRequests");
    this.#maxBatchSize = positiveInteger(options.maxBatchSize ?? MAX_BATCH_SIZE, "maxBatchSize", MAX_BATCH_SIZE);
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new ValidationError("A Fetch API implementation is required");
    this.#onEvent = options.onEvent;
    this.#transport = new Transport({
      email: options.email.trim(),
      tool: options.tool.trim(),
      fetch: fetchImplementation,
      timeoutMs,
      maxAttempts,
      maxResponseBytes,
      maxQueuedRequests,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.rateLimitCoordinator === undefined ? {} : { rateLimitCoordinator: options.rateLimitCoordinator }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
  }

  public async get(pmid: string, options: RequestOptions = {}): Promise<PubMedRecord | null> {
    validatePmid(pmid);
    const batch = await this.getMany([pmid], options);
    return batch.records.find((record) => record.pmid === pmid) ?? null;
  }

  public async getMany(pmids: readonly string[], options: RequestOptions = {}): Promise<BatchResult> {
    if (!Array.isArray(pmids)) throw new ValidationError("pmids must be an array");
    validateRequestOptions(options, "request options");
    if (options.signal?.aborted === true) throw new AbortedError();
    const input = pmids.map(validatePmid);
    const unique = [...new Set(input)];
    const received: PubMedRecord[] = [];
    const warnings: PubMedWarning[] = [];

    for (let offset = 0; offset < unique.length; offset += this.#maxBatchSize) {
      const chunk = unique.slice(offset, offset + this.#maxBatchSize);
      const parsed = await this.#transport.request(
        "efetch",
        { id: chunk.join(","), retmode: "xml" },
        { key: "efetch-records-v1", decode: (body) => parseExpectedFetch(body, chunk) },
        options.signal === undefined ? {} : { signal: options.signal },
      );
      received.push(...parsed.records);
      warnings.push(...parsed.warnings);
      for (const warning of parsed.warnings) {
        safeEvent(this.#onEvent, { type: "parse-warning", code: warning.code, ...(warning.recordType === undefined ? {} : { recordType: warning.recordType }) });
      }
    }

    const byPmid = new Map<string, PubMedRecord>();
    const unknown: PubMedRecord[] = [];
    for (const record of received) {
      if (record.pmid === undefined) unknown.push(record);
      else if (!byPmid.has(record.pmid)) byPmid.set(record.pmid, record);
    }
    let ordered: readonly PubMedRecord[] = input.flatMap((pmid) => byPmid.get(pmid) ?? []);
    if (unknown.length > 0) ordered = [...ordered, ...unknown];
    if (!(options.includeRawXml ?? this.#includeRawXml)) {
      // Do not mutate records shared with other in-flight callers.
      ordered = ordered.map(({ rawXml, ...record }) => record);
    }
    if (options.includeLinkOuts === true && ordered.length > 0) ordered = await this.#enrich(ordered, options.signal);
    if (options.signal?.aborted) throw new AbortedError();
    return {
      records: ordered,
      missingPmids: input.filter((pmid) => !byPmid.has(pmid)),
      warnings,
    };
  }

  public async getSummary(pmid: string, options: SummaryRequestOptions = {}): Promise<PubMedSummary | null> {
    validatePmid(pmid);
    const batch = await this.getManySummaries([pmid], options);
    return batch.summaries[0] ?? null;
  }

  public async getManySummaries(pmids: readonly string[], options: SummaryRequestOptions = {}): Promise<SummaryBatchResult> {
    if (!Array.isArray(pmids)) throw new ValidationError("pmids must be an array");
    validateSummaryRequestOptions(options);
    if (options.signal?.aborted === true) throw new AbortedError();
    const input = pmids.map(validatePmid);
    const unique = [...new Set(input)];
    const received: PubMedSummary[] = [];

    for (let offset = 0; offset < unique.length; offset += this.#maxBatchSize) {
      const chunk = unique.slice(offset, offset + this.#maxBatchSize);
      const summaries = await this.#transport.request(
        "esummary",
        { id: chunk.join(","), retmode: "json", version: "2.0" },
        { key: "esummary-summaries-v1", decode: (body) => parseESummaryJson(body, chunk) },
        options.signal === undefined ? {} : { signal: options.signal },
      );
      received.push(...summaries);
    }

    if (options.signal?.aborted) throw new AbortedError();
    const byPmid = new Map(received.map((summary) => [summary.pmid, summary]));
    return {
      summaries: input.flatMap((pmid) => byPmid.get(pmid) ?? []),
      missingPmids: input.filter((pmid) => !byPmid.has(pmid)),
    };
  }

  public async search(options: SearchOptions): Promise<SearchBatch> {
    validateRequestOptions(options, "search options");
    if ("cursor" in options) {
      if (typeof options.cursor !== "string" || options.cursor === "") throw new ValidationError("cursor must be a non-empty string");
      return (await this.#searchCursorPage(options.cursor, options)).batch;
    }
    validateQueryOptions(options);
    return (await this.#searchQueryPage(options)).batch;
  }

  public async *searchAll(options: SearchAllOptions): AsyncIterable<SearchBatch> {
    validateRequestOptions(options, "searchAll options");
    validateQueryOptions(options);
    if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 0) throw new ValidationError("maxResults must be a non-negative integer");
    const requestedPageSize = positiveInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, "pageSize", MAX_BATCH_SIZE);
    if (options.maxResults === 0) return;
    const pageSize = Math.min(requestedPageSize, options.maxResults);
    const queryOptions: SearchQueryOptions = {
      query: options.query,
      pageSize,
      ...(options.sort === undefined ? {} : { sort: options.sort }),
      ...(options.includeRawXml === undefined ? {} : { includeRawXml: options.includeRawXml }),
      ...(options.includeLinkOuts === undefined ? {} : { includeLinkOuts: options.includeLinkOuts }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const state = await this.#fetchInitialSearchState(queryOptions, pageSize);
    const target = Math.min(options.maxResults, state.total);
    if (target > SEARCH_WINDOW) throw new SearchLimitError();
    let page = await this.#materializeInitialSearchPage(state, queryOptions, pageSize);
    let processed = 0;
    while (processed < target) {
      if (page.expectedPmids.length === 0) throw new InvalidResponseError("PubMed search paging made no progress");
      yield page.batch;
      processed += page.expectedPmids.length;
      if (processed >= target) return;
      if (page.batch.nextCursor === null) throw new InvalidResponseError("PubMed search ended before the requested result count");
      page = await this.#searchCursorPage(
        page.batch.nextCursor,
        options,
        target - processed,
      );
    }
  }

  async #searchQueryPage(options: SearchQueryOptions): Promise<SearchPage> {
    validateQueryOptions(options);
    const pageSize = positiveInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, "pageSize", MAX_BATCH_SIZE);
    const state = await this.#fetchInitialSearchState(options, pageSize);
    return this.#materializeInitialSearchPage(state, options, pageSize);
  }

  async #fetchInitialSearchState(options: SearchQueryOptions, pageSize: number): Promise<SearchState> {
    return this.#transport.request(
      "esearch",
      {
        term: options.query,
        retmode: "json",
        usehistory: "y",
        retstart: "0",
        retmax: String(pageSize),
        ...(options.sort === undefined ? {} : { sort: options.sort }),
      },
      {
        key: "esearch-initial-v1",
        decode: (body) => {
          const parsed = parseSearchResponse(body);
          validateSearchState(parsed, Math.min(pageSize, parsed.total));
          return parsed;
        },
      },
      { cache: false, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
  }

  async #materializeInitialSearchPage(
    state: SearchState,
    options: SearchQueryOptions,
    pageSize: number,
  ): Promise<SearchPage> {
    if (state.total === 0) {
      return {
        batch: { records: [], missingPmids: [], warnings: [], total: 0, nextCursor: null },
        expectedPmids: [],
      };
    }
    const batch = await this.getMany(state.ids, options);
    const offset = state.ids.length;
    return {
      batch: {
        ...batch,
        total: state.total,
        nextCursor: offset < state.total
          ? encodeCursor({ v: 1, webEnv: state.webEnv, queryKey: state.queryKey, total: state.total, offset, pageSize, issuedAt: Date.now() })
          : null,
      },
      expectedPmids: state.ids,
    };
  }

  async #searchCursorPage(cursorValue: string, options: RequestOptions, maxExpected?: number): Promise<SearchPage> {
    const { signal } = options;
    const cursor = decodeCursor(cursorValue);
    if (cursor.offset >= SEARCH_WINDOW) throw new SearchLimitError();
    const remainingWindow = SEARCH_WINDOW - cursor.offset;
    const requested = maxExpected === undefined ? cursor.pageSize : Math.min(cursor.pageSize, positiveInteger(maxExpected, "maxResults"));
    const retmax = Math.min(requested, cursor.total - cursor.offset, remainingWindow);
    const { state, diagnostic } = await this.#transport.request(
      "esearch",
      {
        term: `#${cursor.queryKey}`,
        WebEnv: cursor.webEnv,
        query_key: cursor.queryKey,
        retstart: String(cursor.offset),
        retmax: String(retmax),
        retmode: "json",
        usehistory: "y",
      },
      {
        key: `esearch-cursor-v2:${cursor.total}:${this.#totalDriftPolicy}`,
        decode: (body) => {
          const parsed = parseSearchResponse(body, true);
          // Never shrink the expected page length to fit a newly reported count.
          validateSearchState(parsed, retmax, cursor.offset);
          const diagnostic: SearchTotalDriftDiagnostic | undefined = parsed.total === cursor.total ? undefined : {
            reason: "total-changed",
            originalTotal: cursor.total,
            observedTotal: parsed.total,
            offset: cursor.offset,
            requestedIds: retmax,
            returnedIds: parsed.ids.length,
          };
          if (diagnostic !== undefined && this.#totalDriftPolicy === "error") {
            throw new PaginationConsistencyError(diagnostic);
          }
          return { state: parsed, diagnostic };
        },
      },
      { cache: false, ...(signal === undefined ? {} : { signal }) },
    );
    // Emit per caller, outside the coalesced decoder; expose only numeric metadata.
    if (diagnostic !== undefined) safeEvent(this.#onEvent, { type: "search-total-drift", ...diagnostic });
    const batch = await this.getMany(state.ids, options);
    const offset = cursor.offset + state.ids.length;
    return {
      batch: {
        ...batch,
        total: cursor.total,
        nextCursor: offset < cursor.total ? encodeCursor({ ...cursor, offset }) : null,
        ...(diagnostic === undefined ? {} : { diagnostics: [{ ...diagnostic }] }),
      },
      expectedPmids: state.ids,
    };
  }

  async #enrich(records: readonly PubMedRecord[], signal?: AbortSignal): Promise<readonly PubMedRecord[]> {
    const ids = [...new Set(records.flatMap((record) => record.pmid ?? []))];
    const links = new Map<string, PubMedLink[]>();
    for (let offset = 0; offset < ids.length; offset += this.#maxBatchSize) {
      const chunk = ids.slice(offset, offset + this.#maxBatchSize);
      const parsed = await this.#transport.request(
        "elink",
        { id: chunk.join(","), cmd: "llinks", retmode: "xml" },
        { key: "elink-linkouts-v1", decode: parseLinkOutResponse },
        signal === undefined ? {} : { signal },
      );
      for (const [id, found] of parsed) links.set(id, [...(links.get(id) ?? []), ...found]);
    }
    return records.map((record) => record.pmid === undefined ? record : withLinks(record, links.get(record.pmid) ?? []));
  }
}
