import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEventsQuery, parseEventsFilters } from "../../src/feed/query";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// EXPLAIN QUERY PLAN on the exact SQL the /v1/events route runs, over 2,000
// seeded advisories, so the planner sees realistic statistics.

const ECOSYSTEMS = ["node", "php", "npm", "PyPI", "Go", "crates.io"];
const LABELS = ["critical", "high", "medium", "low", "unknown"] as const;

async function plan(sql: string, params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

function planFor(query: string): Promise<string> {
  const parsed = parseEventsFilters(new URL(`https://tocsin.test/v1/events?${query}`));
  if (!parsed.ok) throw new Error(parsed.error);
  const { sql, params } = buildEventsQuery(parsed.filters);
  return plan(sql, params);
}

beforeAll(async () => {
  const rows: SeedRow[] = Array.from({ length: 2000 }, (_, i) => ({
    id: idFor("PQN", i),
    cursor: 1 + i,
    ecosystem: ECOSYSTEMS[i % ECOSYSTEMS.length],
    component: `pkg-fixture-${i % 50}`,
    label: LABELS[i % LABELS.length],
    exploited: i % 17 === 0,
  }));
  await seed(rows);
});

describe("feed query plans on 2,000 advisories", () => {
  it("ecosystem + cursor uses advisories(ecosystem, cursor) with no sort step", async () => {
    const p = await planFor("ecosystem=node&since=1500&limit=100");
    expect(p).toContain("USING INDEX idx_advisories_ecosystem_cursor");
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("no filter uses the cursor index", async () => {
    const p = await planFor("since=1500");
    expect(p).toMatch(/USING (COVERING )?INDEX idx_advisories_cursor/);
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("exploited=true uses advisories(exploited, cursor)", async () => {
    const p = await planFor("exploited=true&since=10");
    expect(p).toContain("USING INDEX idx_advisories_exploited_cursor");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("min_severity uses advisories(severity_label, cursor)", async () => {
    const p = await planFor("min_severity=high&since=10");
    expect(p).toContain("USING INDEX idx_advisories_severity_cursor");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("component uses an index, never a bare scan", async () => {
    const p = await planFor("component=pkg-fixture-3&since=10");
    expect(p).toContain("USING INDEX");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });
});

describe("settings table (rate limit row)", () => {
  it("looks a key up through its primary key index", async () => {
    const p = await plan("SELECT value FROM settings WHERE key = ?", ["feed.anon_rate_per_minute"]);
    expect(p).toContain("USING INDEX sqlite_autoindex_settings_1");
  });

  it("seeds feed.anon_rate_per_minute = 60", async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind("feed.anon_rate_per_minute")
      .first<{ value: string }>();
    expect(row?.value).toBe("60");
  });
});
