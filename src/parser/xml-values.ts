import { ParseError } from "../errors.js";
import type { JsonValue, PartialDate } from "../types.js";

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function at(value: unknown, key: string): unknown {
  return object(value)?.[key];
}

export function list(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

export function decodeNumericReference(body: string): string {
  const hexadecimal = body.toLowerCase().startsWith("#x");
  const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (!Number.isSafeInteger(codePoint) || !isXmlCodePoint(codePoint)) throw new ParseError();
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    throw new ParseError();
  }
}

export function decodeEntities(value: string): string {
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

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value: string): string {
  return normalizeText(decodeEntities(value));
}

export function text(value: unknown): string | undefined {
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

export function attribute(value: unknown, name: string): string | undefined {
  return text(object(value)?.[`@${name}`]);
}

export function json(value: unknown): JsonValue {
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

export function partialDate(value: unknown): PartialDate | undefined {
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
