# @everdeep/pubmed

A strict TypeScript client for PubMed search and record retrieval through the NCBI E-utilities API. It supports Node.js 18+, ESM and CommonJS.

## Install

```bash
npm install @everdeep/pubmed
```

## Configure

NCBI asks API clients to identify themselves. `email` and `tool` are therefore required explicitly:

```ts
import { PubMedClient } from "@everdeep/pubmed";

const client = new PubMedClient({
  email: "research@example.org",
  tool: "literature-review-service",
  apiKey: "optional-ncbi-api-key",
});
```

The package does **not** read environment variables. It always uses the fixed NCBI endpoint at `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`; there is no custom base URL or generic E-utilities request method. A Fetch-compatible implementation can be passed as `fetch` for testing.

## Retrieve records

```ts
const record = await client.get("38601234"); // PubMedRecord | null

const batch = await client.getMany(["38601234", "38300001", "38601234"]);
console.log(batch.records);       // follows caller order and retains duplicates
console.log(batch.missingPmids);  // missing IDs in caller order
console.log(batch.warnings);
```

PMIDs must be non-zero numeric strings. `getMany()` deduplicates network retrieval, uses batches of at most 200 IDs, and reconstructs caller order. Cancellation rejects the whole operation with `AbortedError`; it never returns a normal-looking partial result.

## Retrieve summaries

Use ESummary when you need lightweight metadata without full XML records:

```ts
const summary = await client.getSummary("38601234"); // PubMedSummary | null

const batch = await client.getManySummaries([
  "38601234",
  "38300001",
  "38601234",
]);
console.log(batch.summaries);     // follows caller order and retains duplicates
console.log(batch.missingPmids);  // missing IDs in caller order
```

A summary includes normalized authors, journal or book metadata, publication dates, languages, publication types, identifiers, and DOI/PMCID conveniences when available. Its `source` property retains the validated JSON object returned for that UID so newer ESummary fields remain accessible. Optional malformed metadata is ignored, while invalid response envelopes or mismatched UIDs are rejected.

Summary retrieval uses the same validation, batching, cancellation, response limits, caching, and in-flight coalescing policy as record retrieval.

## Search

Native PubMed query syntax and sort values are passed to ESearch:

```ts
const first = await client.search({
  query: "CRISPR[Title] AND 2024[Date - Publication]",
  pageSize: 50,
  sort: "relevance",
});

if (first.nextCursor) {
  const second = await client.search({ cursor: first.nextCursor });
}
```

Cursors are versioned, base64url-encoded, unsigned, implementation-specific continuation state backed by NCBI search history. Treat them as untrusted values: they are validated when consumed but are not encrypted or authenticated, and their decoded shape is not a public API. They contain no client credentials. Cursors are temporary and can produce `CursorExpiredError`; malformed values produce `CursorInvalidError`.

### Count changes during pagination

NCBI can return HTTP 200 with valid IDs but a different total on a later page. By default, `search()` and `searchAll()` **continue retrieving valid pages**, returning count-drift diagnostics and emitting a `search-total-drift` event. The default `totalDriftPolicy` is `"warn"` (version 0.1.1 defaulted to `"error"`); no explicit opt-in or event handler is required. This is best-effort pagination, not a snapshot guarantee.

To stop on count changes, explicitly configure `totalDriftPolicy: "error"`. Strict mode throws `PaginationConsistencyError` (`code: "PAGINATION_INCONSISTENT"`, `retryable: false`) before fetching the changed page's records. This is a consistency signal, **not provider unavailability**. The client does not automatically retry or restart such searches.

With the default policy:

```ts
const client = new PubMedClient({ email, tool }); // totalDriftPolicy: "warn" by default
const first = await client.search({ query: "cancer", pageSize: 2 });
if (first.nextCursor) {
  const second = await client.search({ cursor: first.nextCursor });
  console.log(second.diagnostics); // safe count-drift metadata, when present
}
```

In both modes, `SearchBatch.total` and the pagination bound remain the **initial** total. Growth never extends the original target; shrinkage never silently shortens it. Continuations retain the original history reference and cursor expiry. Short, empty, oversized, duplicate-ID, or count-contradictory pages still fail before record retrieval, even in `"warn"` mode. The 10,000-ID retrieval window and `searchAll.maxResults` remain enforced.

Warn mode returns a `diagnostics` entry on each drifted page and emits a `search-total-drift` event. A consistency error exposes the same metadata through `.diagnostic` and `toJSON()`: `reason`, `originalTotal`, `observedTotal`, `offset`, `requestedIds`, and `returnedIds`. No queries, PMIDs, cursors, or history tokens are included. Record parse `warnings` remain separate.

Neither mode guarantees snapshot enumeration: equal counts do not prove stable membership or ordering, and page-local uniqueness does not detect cross-page duplicates or omissions. Warn mode accepts that risk; it does not silently deduplicate or claim complete results. Consumers should persist by PMID idempotently and inspect `missingPmids` and `diagnostics`. Consumers requiring a stop on count drift should select `"error"`, but that alone does not establish exact enumeration.

For progressive consumption, use `searchAll()`. `maxResults` is required so a caller must make the retrieval bound explicit:

```ts
for await (const batch of client.searchAll({
  query: "single cell[Title/Abstract]",
  maxResults: 1_000,
  pageSize: 100,
  includeLinkOuts: true,
})) {
  for (const record of batch.records) {
    console.log(record.pmid, record.title);
  }
}
```

PubMed ranking is retained. PubMed history retrieval has an approximately 10,000-record window. The client checks ESearch metadata and raises `SearchLimitError` before fetching any records when the requested result target exceeds that window, instead of silently truncating. Automatic date partitioning is intentionally not part of v1.

## Records

`PubMedRecord` is a readonly discriminated union:

- `kind: "article"` — `PubmedArticle`
- `kind: "book"` — `PubmedBookArticle`
- `kind: "unknown"` — a forward-compatible direct record type, retained with a warning

Records are plain JSON-safe values. They expose ordered identifiers and `pmid`, `doi`, and `pmcid` conveniences; safe plain-text titles; structured abstracts and container-level `abstractCopyright`; structured authors; affiliations and author identifiers; journal/book citation fields; partial calendar dates (never JavaScript `Date`); history; publication types; keywords; MeSH headings; and languages. The deprecated `AbstractSection.copyright` field is retained for source compatibility but is not populated.

```ts
if (record?.kind === "article") {
  console.log(record.journal?.title);
  console.log(record.dates.electronic?.year);
}
```

Every record includes `rawXml`, which is the exact direct-child XML fragment received from PubMed, without serialization or normalization. `source` retains parsed source data for fields not represented in the normalized surface.

## Citation export

Full article/book records and lightweight summaries can be serialized as RIS or BibTeX:

```ts
import { formatCitation, formatCitations } from "@everdeep/pubmed";

const ris = formatCitation(record, "ris");
const bibtex = formatCitation(summary, "bibtex");
const bibliography = formatCitations([record, summary], "bibtex");
```

`formatCitation()` accepts `PubMedArticleRecord`, `PubMedBookRecord`, or `PubMedSummary`. `formatCitations()` preserves caller order and duplicates, separates entries with one blank line, gives repeated BibTeX keys deterministic occurrence suffixes, and returns an empty string for an empty input. Article sources produce RIS `JOUR` / BibTeX `article` entries; book chapters produce RIS `CHAP` / BibTeX `incollection` entries; whole books produce RIS `BOOK` / BibTeX `book` entries.

Serialization is pure and deterministic. Fields use a fixed order, line breaks and control characters cannot inject RIS tags, and BibTeX-sensitive characters are escaped. Only available normalized metadata is emitted; this is a safe interchange export, not a citation-style or bibliography-rendering engine.

## Links and LinkOut

Canonical HTTPS links for PubMed, DOI, and PMC are generated from source identifiers. Per-call LinkOut enrichment is opt-in:

```ts
const record = await client.get("38601234", { includeLinkOuts: true });
```

LinkOut URLs are returned with provider/provenance metadata. The client never dereferences them and discards schemes other than HTTP and HTTPS.

## Caching

No persistent or memory cache is enabled implicitly. Supply an async adapter, or opt into the bounded helper:

```ts
import { MemoryCache, PubMedClient } from "@everdeep/pubmed";

const cache = new MemoryCache({
  maxEntries: 500,
  maxBytes: 25 * 1024 * 1024,
  ttlMs: 5 * 60_000,
});
const client = new PubMedClient({ email, tool, cache });
```

Eligible successful EFetch, ESummary, and ELink response bodies are cached. History-bearing ESearch requests bypass cache reads and writes because their continuation metadata can become stale; equivalent in-flight searches are still coalesced. Successful cache writes are bounded, asynchronous best effort and never delay API responses. `MemoryCache` defaults to 500 entries and 25 MiB; its byte limit counts the UTF-8 bytes of both keys and values, and entries larger than the limit are skipped. Cache and in-flight coalescing keys are hashed and credential-free. Equivalent in-flight requests are always coalesced; canceling one subscriber does not cancel another subscriber.

Custom cache adapters must be objects with async `get` and `set` functions; `delete`, when provided, must also be a function. Custom rate-limit coordinators must provide an async `acquire` function; `cooldown`, when provided, must be a function. Invalid adapter shapes and non-function `onEvent` values throw `ValidationError` synchronously when `PubMedClient` is constructed. Constructor validation checks method shapes only and does not invoke adapters.

## Rate and transport policy

Conservative defaults:

| Setting | Default |
| --- | ---: |
| Search page size | 20 |
| Maximum search/fetch batch | 200 |
| Response body cap | 25 MiB |
| Limiter queue | 1,000 |
| Timeout per attempt | 30 seconds |
| Attempts, including the first | 4 |

A process-shared FIFO limiter stays below NCBI ceilings: approximately 2.8 requests/second without a key and 9 requests/second with a key (below NCBI's 3/10 limits). These rate ceilings cannot be raised. `RateLimitCoordinator` can add distributed coordination and receives only a non-reversible credential fingerprint, never the API key. HTTP 429 `Retry-After` pauses the shared and distributed bucket. Server-directed cooldowns are conservatively capped at five minutes; larger values publish that bounded cooldown and stop automatic retry rather than scheduling an excessive timer.

The client retries network failures, timeouts, HTTP 408, 429, and 5xx responses with exponential full jitter. Other 4xx responses and XML/JSON parse failures are not retried. Every request uses an `application/x-www-form-urlencoded` POST to a fixed NCBI endpoint; parameters and credentials are never placed in the URL. Response bodies are capped while streaming.

There is no default logging. An optional `onEvent` callback receives sanitized events for correlation IDs, cache hits/misses, in-flight coalescing, requests, response byte counts, retries, queue delays, cooldowns, parse warnings, tolerated search-total drift, and terminal failures. Each logical transport request gets a generated opaque correlation ID. A `request-coalesced` event links a joining request's ID to the shared operation's ID; IDs are not derived from request content. Request and retry events also carry correlation IDs when they belong to an HTTP operation. Terminal failures expose only a stable error code, not an error message.

Callback exceptions are ignored. Events and typed errors never include API keys, email addresses, queries, request bodies, raw responses, or internal cache keys. Event payloads contain only bounded operational metadata such as endpoint, status, attempt, timing, byte count, error code, search totals/page counts/offsets, and opaque correlation IDs.

## Errors

All library failures extend `PubMedError` and have stable `code` and `retryable` properties. Exported subclasses include:

- `ValidationError`
- `HttpError` and `RateLimitError`
- `TimeoutError` and `NetworkError`
- `ResponseTooLargeError` and `QueueFullError`
- `ParseError` and `InvalidResponseError`
- `PaginationConsistencyError` (count drift; includes safe `.diagnostic` metadata)
- `CursorExpiredError` and `CursorInvalidError`
- `AbortedError`
- `SearchLimitError`

Missing PMIDs are data (`null` or `missingPmids`), not exceptions.

## Development

```bash
npm test
npm run typecheck
npm run build
```

All normal tests mock Fetch and perform no live requests. To run the opt-in integration test, provide an identity explicitly:

```bash
PUBMED_LIVE=1 PUBMED_EMAIL=research@example.org npm run test:live
```
