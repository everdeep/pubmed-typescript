import { ValidationError } from "./errors.js";
import { extractFragments } from "./parser/xml-framing.js";
import { parseFragment } from "./parser/record-mapping.js";
import type { PubMedRecord, PubMedWarning } from "./types.js";

export interface ParsedPubMedXml {
  readonly records: readonly PubMedRecord[];
  readonly warnings: readonly PubMedWarning[];
}

export interface ParsePubMedXmlOptions {
  /** Include each direct child's exact source XML fragment. Default false. */
  readonly includeRawXml?: boolean;
}

/** Parse an entire PubmedArticleSet, optionally retaining exact source fragments. */
export function parsePubMedXml(xml: string, options: ParsePubMedXmlOptions = {}): ParsedPubMedXml {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ValidationError("parser options must be an object");
  }
  if (options.includeRawXml !== undefined && typeof options.includeRawXml !== "boolean") {
    throw new ValidationError("includeRawXml must be a boolean");
  }
  const records = extractFragments(xml).map((fragment) => {
    const record = parseFragment(fragment);
    if (options.includeRawXml === true) return record;
    const { rawXml, ...withoutRawXml } = record;
    return withoutRawXml;
  });
  const warnings = records.flatMap((record): readonly PubMedWarning[] => record.kind === "unknown"
    ? [{ code: "UNKNOWN_RECORD", message: `Unknown PubMed record type: ${record.recordType}`, recordType: record.recordType }]
    : []);
  return { records, warnings };
}
