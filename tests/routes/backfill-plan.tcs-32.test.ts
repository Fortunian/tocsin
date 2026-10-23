import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { COVERAGE_SQL, SOURCE_COVERAGE_SQL } from "../../src/check/coverage";
import { BACKFILL_GET_SQL, BACKFILL_UPSERT_SQL, OSV_COVERAGE_SQL, STORED_MODIFIED_SQL } from "../../src/routes/internal-import";

// EXPLAIN QUERY PLAN for every query on the backfill table (repo iron rule 2),
// on a seeded table: one row per enabled ecosystem plus 50 more rows.
async function plan(sql: string, ...args: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

describe("backfill query plans", () => {
  it("the PK read and the ON CONFLICT upsert use the primary key; the coverage reads are small full reads", async () => {
    const insert = env.DB.prepare("INSERT OR IGNORE INTO backfill (ecosystem, imported) VALUES (?, 1)");
    await env.DB.batch(["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems", ...Array.from({ length: 50 }, (_, i) => `tcs32-eco-${i}`)].map((e) => insert.bind(e)));
    await env.DB.prepare("ANALYZE").run();

    const get = await plan(BACKFILL_GET_SQL, "npm");
    expect(get).toMatch(/SEARCH backfill USING INDEX sqlite_autoindex_backfill_1 \(ecosystem=\?\)/);

    // An UPSERT's conflict target is the PK; its plan is the PK seek of the conflict check.
    const upsert = await plan(BACKFILL_UPSERT_SQL, "npm", "2026-10-23T00:00:00Z", 1, 0, 0, "a", 0, null, 0);
    expect(upsert).not.toMatch(/SCAN backfill/);

    const osv = await plan(OSV_COVERAGE_SQL, JSON.stringify(["npm", "PyPI"]));
    expect(osv).toMatch(/SEARCH sources USING INDEX sqlite_autoindex_sources_1 \(id=\?\)/);
    expect(osv.match(/SEARCH b USING INDEX sqlite_autoindex_backfill_1 \(ecosystem=\?\)/g)).toHaveLength(2);
    expect(osv).not.toMatch(/SCAN (b|backfill)\b/);

    // The stale check of one request: PK seeks on advisory_sources and advisories, driven by the id list.
    const stored = await plan(STORED_MODIFIED_SQL, JSON.stringify(["GHSA-aaaa-0000-0001", "GHSA-aaaa-0000-0002"]));
    expect(stored).toMatch(/SEARCH s USING (PRIMARY KEY|INDEX sqlite_autoindex_advisory_sources_1) \(source=\? AND source_id=\?\)/);
    expect(stored).toMatch(/SEARCH a USING INDEX sqlite_autoindex_advisories_1 \(id=\?\)/);
    expect(stored).not.toMatch(/SCAN (s|a)\b/);

    // backfill has one row per ecosystem and sources one row per source: bounded full reads.
    expect(await plan(COVERAGE_SQL)).toMatch(/SCAN backfill/);
    expect(await plan(SOURCE_COVERAGE_SQL)).toMatch(/SCAN sources/);
  });
});
