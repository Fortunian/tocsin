import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEventsQuery, parseEventsFilters } from "../../src/feed/query";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// EXPLAIN QUERY PLAN on the exact SQL /v1/events runs for order=desc, over
// 2,000 seeded advisories. The desc read walks the same indexes backwards.

const ECOSYSTEMS = ["node", "php", "npm", "PyPI", "Go", "crates.io"];
const LABELS = ["critical", "high", "medium", "low", "unknown"] as const;

async function planFor(query: string): Promise<{ sql: string; plan: string }> {
  const parsed = parseEventsFilters(new URL(`https://tocsin.test/v1/events?${query}`));
  if (!parsed.ok) throw new Error(parsed.error);
  const { sql, params } = buildEventsQuery(parsed.filters);
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return { sql, plan: results.map((r) => r.detail).join("\n") };
}

beforeAll(async () => {
  const rows: SeedRow[] = Array.from({ length: 2000 }, (_, i) => ({
    id: idFor("PQD", i),
    cursor: 200_001 + i,
    ecosystem: ECOSYSTEMS[i % ECOSYSTEMS.length],
    component: `pkg-fixture-${i % 50}`,
    label: LABELS[i % LABELS.length],
    exploited: i % 17 === 0,
  }));
  await seed(rows);
});

describe("order=desc query plans on 2,000 advisories", () => {
  it("emits ORDER BY cursor DESC", async () => {
    expect((await planFor("order=desc")).sql).toContain("ORDER BY cursor DESC LIMIT 51");
    expect((await planFor("order=asc")).sql).toContain("ORDER BY cursor LIMIT 51");
  });

  it("no filter walks the cursor index with no sort step", async () => {
    const { plan } = await planFor("order=desc");
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_advisories_cursor/);
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("ecosystem walks advisories(ecosystem, cursor) with no sort step", async () => {
    const { plan } = await planFor("order=desc&ecosystem=node");
    expect(plan).toContain("USING INDEX idx_advisories_ecosystem_cursor");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("exploited=true walks advisories(exploited, cursor) with no sort step", async () => {
    const { plan } = await planFor("order=desc&exploited=true");
    expect(plan).toContain("USING INDEX idx_advisories_exploited_cursor");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("min_severity=critical walks advisories(severity_label, cursor) with no sort step", async () => {
    const { plan } = await planFor("order=desc&min_severity=critical");
    expect(plan).toContain("USING INDEX idx_advisories_severity_cursor");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });
});
