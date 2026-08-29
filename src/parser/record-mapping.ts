import { XMLParser } from "fast-xml-parser";
import { ParseError } from "../errors.js";
import type {
  AbstractSection,
  Affiliation,
  JsonObject,
  Keyword,
  MeshHeading,
  PubMedArticleRecord,
  PubMedAuthor,
  PubMedBookRecord,
  PubMedIdentifier,
  PubMedLink,
  PubMedRecord,
  PublicationDates,
  PublicationHistoryEntry,
} from "../types.js";
import { rawElementText, rawElementTexts } from "./xml-framing.js";
import type { ParsedFragment } from "./xml-framing.js";
import { at, attribute, json, list, object, partialDate, text } from "./xml-values.js";

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

export function parseFragment(fragment: ParsedFragment): PubMedRecord {
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

