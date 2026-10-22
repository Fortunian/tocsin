import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ADVISORIES_BY_CVE_SQL, ADVISORY_BY_ID_SQL, CVE_PAGE_CAP } from "../../src/routes/advisory";
import { SITEMAP_CHUNK_SQL, SITEMAP_MAX_SQL } from "../../src/routes/sitemap";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// EXPLAIN QUERY PLAN on the advisory-page and sitemap reads, over 2,000 advisories.

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

beforeAll(async () => {
  const rows: SeedRow[] = Array.from({ length: 2000 }, (_, i) => ({
    id: idFor("APQ", i),
    cursor: 340_001 + i,
    component: `pkg-fixture-${i % 50}`,
    cve: `CVE-2026-${50000 + (i % 1000)}`,
  }));
  await seed(rows);
  await env.DB.prepare("ANALYZE").run();
});

describe("advisory page query plans on 2,000 advisories", () => {
  it("the page read is one primary-key search", async () => {
    const p = await plan(ADVISORY_BY_ID_SQL, idFor("APQ", 7));
    expect(p).toMatch(/SEARCH advisories USING INDEX sqlite_autoindex_advisories_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN advisories/);
  });

  it("the CVE read uses idx_advisories_cve_primary and is capped", async () => {
    const p = await plan(ADVISORIES_BY_CVE_SQL, "CVE-2026-50007", CVE_PAGE_CAP);
    expect(p).toContain("idx_advisories_cve_primary");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
    expect(ADVISORIES_BY_CVE_SQL).toMatch(/LIMIT \?$/);
  });

  it("the sitemap reads walk idx_advisories_cursor with no sort step", async () => {
    const max = await plan(SITEMAP_MAX_SQL);
    expect(max).toContain("idx_advisories_cursor");
    const chunk = await plan(SITEMAP_CHUNK_SQL, 340_000, 365_000);
    expect(chunk).toMatch(/SEARCH advisories USING INDEX idx_advisories_cursor \(cursor>\? AND cursor<\?\)/);
    expect(chunk).not.toContain("TEMP B-TREE");
  });
});
