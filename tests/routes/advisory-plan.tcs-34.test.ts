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
  const link = env.DB.prepare("INSERT INTO advisory_cves (cve, advisory_id) VALUES (?, ?)");
  const links = rows.map((r) => link.bind(r.cve as string, r.id));
  for (let i = 0; i < links.length; i += 500) await env.DB.batch(links.slice(i, i + 500));
  // No ANALYZE: the plans must hold on the default planner statistics.
});

describe("advisory page query plans on 2,000 advisories", () => {
  it("the page read is one primary-key search", async () => {
    const p = await plan(ADVISORY_BY_ID_SQL, idFor("APQ", 7));
    expect(p).toMatch(/SEARCH advisories USING INDEX sqlite_autoindex_advisories_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN advisories/);
  });

  it("the CVE read searches the advisory_cves primary key, then advisories by id, and is capped", async () => {
    const p = await plan(ADVISORIES_BY_CVE_SQL, "CVE-2026-50007", CVE_PAGE_CAP);
    expect(p).toMatch(/SEARCH c USING (COVERING )?INDEX sqlite_autoindex_advisory_cves_1 \(cve=\?\)/);
    expect(p).toMatch(/SEARCH a USING INDEX sqlite_autoindex_advisories_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN/);
    expect(ADVISORIES_BY_CVE_SQL).toMatch(/LIMIT \?$/);
  });

  it("the sitemap reads walk idx_advisories_cursor with no sort step", async () => {
    const max = await plan(SITEMAP_MAX_SQL);
    expect(max).toContain("idx_advisories_cursor");
    const chunk = await plan(SITEMAP_CHUNK_SQL, 340_000, 360_000);
    expect(chunk).toMatch(/SEARCH a USING INDEX idx_advisories_cursor \(cursor>\? AND cursor<\?\)/);
    expect(chunk).toMatch(/SEARCH c USING (COVERING )?INDEX idx_advisory_cves_advisory_id \(advisory_id=\?\)/);
    expect(chunk).not.toContain("TEMP B-TREE");
  });
});
