import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEventsQuery } from "../../src/feed/query";
import { STATUS_CURSOR_SQL, STATUS_SOURCES_SQL } from "../../src/site/data";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// EXPLAIN QUERY PLAN on the reads the site runs, over 2,000 seeded advisories.

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

beforeAll(async () => {
  const rows: SeedRow[] = Array.from({ length: 2000 }, (_, i) => ({
    id: idFor("SPQ", i),
    cursor: 300_001 + i,
    component: `pkg-fixture-${i % 50}`,
  }));
  await seed(rows);
});

describe("site query plans on 2,000 advisories", () => {
  it("Latest walks idx_advisories_cursor backwards with no sort step", async () => {
    const { sql, params } = buildEventsQuery({ since: 0, limit: 10, ecosystem: [], component: [], min_severity: null, exploited: false, order: "desc" });
    const p = await plan(sql, ...params);
    expect(p).toMatch(/USING (COVERING )?INDEX idx_advisories_cursor/);
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("the newest cursor reads idx_advisories_cursor", async () => {
    const p = await plan(STATUS_CURSOR_SQL);
    expect(p).toContain("idx_advisories_cursor");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("the sources read is an 11-row table (10 ingesters plus the disabled mail row, TCS-94) and needs no index", async () => {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first<{ n: number }>();
    expect(n?.n).toBe(11);
    expect(STATUS_SOURCES_SQL).toContain("WHERE enabled = 1");
  });
});
