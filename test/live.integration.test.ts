import { describe, expect, it } from "vitest";
import { PubMedClient } from "../src/index.js";

const live = process.env.PUBMED_LIVE === "1";

describe.skipIf(!live)("live PubMed integration", () => {
  it("searches and fetches one public record", async () => {
    const email = process.env.PUBMED_EMAIL;
    if (email === undefined || email.trim() === "") throw new Error("PUBMED_EMAIL is required for the live test");
    const client = new PubMedClient({ email, tool: "everdeep-pubmed-live-test", includeRawXml: true });
    const batch = await client.search({ query: "pubmed[Title]", pageSize: 1 });
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]?.rawXml).toContain("<PubmedArticle");
  });
});
