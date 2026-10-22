import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The setup file (tests/apply-migrations.ts) applies every file in
// migrations/ to this test file's fresh, isolated D1 before these tests run.

const TABLES = ["advisories", "advisory_sources", "sources"];
const INDEXES = [
  "idx_advisories_cursor",
  "idx_advisories_ecosystem_cursor",
  "idx_advisories_component_ecosystem",
  "idx_advisories_cve_primary",
  "idx_advisory_sources_advisory_id",
  "idx_advisories_pypi_name",
];
const SOURCES = ["epss", "kev", "node-runtime", "nvd", "osv", "php-runtime"];
const ECOSYSTEMS = ["node", "php", "npm", "PyPI", "Go", "crates.io"];

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

async function seedAdvisories(prefix: string, count: number, cursorBase: number): Promise<void> {
  const insert = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const eco = ECOSYSTEMS[i % ECOSYSTEMS.length];
    stmts.push(
      insert.bind(
        `${prefix}_${i}`,
        `CVE-2026-${10000 + i}`,
        eco,
        `pkg-fixture-${i % 50}`,
        "2026-10-20T00:00:00Z",
        "2026-10-20T00:00:00Z",
        "{}",
        cursorBase + i,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 500) {
    await env.DB.batch(stmts.slice(i, i + 500));
  }
}

describe("migrations on a fresh local D1", () => {
  it("applies 0001..0006", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["0001_init.sql", "0002_seed_sources.sql", "0003_settings.sql", "0004_check_settings.sql", "0005_pypi_name_index.sql", "0006_site_settings.sql"]);
  });

  it("creates the 3 tables and the 5 named indexes", async () => {
    const { results } = await env.DB.prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')",
    ).all<{ type: string; name: string }>();
    const tables = results.filter((r) => r.type === "table").map((r) => r.name);
    const indexes = results.filter((r) => r.type === "index").map((r) => r.name);
    for (const t of TABLES) expect(tables).toContain(t);
    for (const i of INDEXES) expect(indexes).toContain(i);
  });

  it("seeds the 6 sources, enabled with empty config, and a re-run adds no rows", async () => {
    const read = () =>
      env.DB.prepare("SELECT id, kind, enabled, config_json FROM sources ORDER BY id").all<{
        id: string;
        kind: string;
        enabled: number;
        config_json: string;
      }>();
    const first = await read();
    expect(first.results.map((r) => r.id)).toEqual(SOURCES);
    for (const r of first.results) {
      expect(r.kind).toBe(r.id);
      expect(r.enabled).toBe(1);
      expect(r.config_json).toBe("{}");
    }

    const seed = env.TEST_MIGRATIONS.find((m) => m.name === "0002_seed_sources.sql");
    expect(seed).toBeDefined();
    for (const q of seed!.queries) await env.DB.prepare(q).run();
    const again = await read();
    expect(again.results.map((r) => r.id)).toEqual(SOURCES);
  });

  it("serves the feed queries from an index on 2,000 seeded advisories", async () => {
    await seedAdvisories("tcs_explain", 2000, 1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories").first<{ n: number }>();
    expect(count?.n).toBe(2000);

    const byCursor = await plan("SELECT * FROM advisories WHERE cursor > ? ORDER BY cursor LIMIT 100", 1500);
    expect(byCursor).toContain("USING INDEX");
    expect(byCursor).not.toMatch(/SCAN advisories(?! USING)/);
    expect(byCursor).not.toContain("TEMP B-TREE");

    const byEcosystem = await plan(
      "SELECT * FROM advisories WHERE ecosystem = ? AND cursor > ? ORDER BY cursor LIMIT 100",
      "node",
      1500,
    );
    expect(byEcosystem).toContain("USING INDEX idx_advisories_ecosystem_cursor");
    expect(byEcosystem).not.toContain("TEMP B-TREE");
  });

  it("refuses two advisories with the same cursor", async () => {
    await seedAdvisories("tcs_unique_a", 1, 90001);
    await expect(seedAdvisories("tcs_unique_b", 1, 90001)).rejects.toThrow(/UNIQUE/);
  });
});
