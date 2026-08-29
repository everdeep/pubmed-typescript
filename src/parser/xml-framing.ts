import { XMLValidator } from "fast-xml-parser";
import { ParseError } from "../errors.js";
import { decodeEntities, decodeNumericReference, normalizeText } from "./xml-values.js";

export interface ParsedFragment {
  readonly name: string;
  readonly rawXml: string;
}

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

export function extractFragments(xml: string): readonly ParsedFragment[] {
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

export function rawElementTexts(xml: string, elementName: string): readonly string[] {
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

export function rawElementText(xml: string, elementName: string): string | undefined {
  const result = rawElementTexts(xml, elementName)[0];
  return result === undefined || result === "" ? undefined : result;
}
