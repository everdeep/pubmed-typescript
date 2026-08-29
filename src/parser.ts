import { extractFragments } from "./parser/xml-framing.js";
import { parseFragment } from "./parser/record-mapping.js";
import type { PubMedRecord, PubMedWarning } from "./types.js";

export interface ParsedPubMedXml {
  readonly records: readonly PubMedRecord[];
  readonly warnings: readonly PubMedWarning[];
}

/** Parse an entire PubmedArticleSet while retaining each direct child byte-for-byte. */
export function parsePubMedXml(xml: string): ParsedPubMedXml {
  const records = extractFragments(xml).map(parseFragment);
  const warnings = records.flatMap((record): readonly PubMedWarning[] => record.kind === "unknown"
    ? [{ code: "UNKNOWN_RECORD", message: `Unknown PubMed record type: ${record.recordType}`, recordType: record.recordType }]
    : []);
  return { records, warnings };
}
