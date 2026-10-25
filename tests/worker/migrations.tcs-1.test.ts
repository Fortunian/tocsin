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
  "idx_advisories_nvd_pending",
];
const SOURCES = ["bun-runtime", "deno-runtime", "epss", "kev", "node-eol", "node-runtime", "nvd", "osv", "php-runtime", "python-runtime"];
// TCS-32: migration 0015 seeds the node-runtime history window; every other row keeps "{}".
// TCS-69: migration 0020 adds the node-runtime recheck knobs.
// TCS-38: migration 0024 writes the osv ecosystems list.
const SEEDED_CONFIG: Record<string, string> = {
  "node-runtime": '{"max_posts":20,"backfill_days":4000,"retry_incomplete_days":365,"pending_recheck_minutes":60,"pending_old_recheck_minutes":10080,"max_attempts":10,"retry_schedule_minutes":"60,360,1440,10080"}',
  osv: '{"ecosystems":["npm","PyPI","Go","Packagist","crates.io","RubyGems","Maven","NuGet","Hex","Pub","Alpine","Debian"]}',
};
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
  it("applies 0001..0032", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["0001_init.sql", "0002_seed_sources.sql", "0003_settings.sql", "0004_check_settings.sql", "0005_pypi_name_index.sql", "0006_site_settings.sql", "0007_nvd_pending_index.sql", "0008_published_at_index.sql", "0009_python_runtime_source.sql", "0010_advisory_cves.sql", "0011_python_runtime_records.sql", "0012_source_last_warning.sql", "0013_deno_bun_runtime_sources.sql", "0014_backfill.sql", "0015_node_history.sql", "0016_watchlists.sql", "0017_watchlist_limits.sql", "0018_watchlists_ip_rate.sql", "0019_key_confirm.sql", "0020_node_runtime_posts.sql", "0021_deliveries.sql", "0022_advisories_exploited_at.sql", "0023_watchlist_delivery_health.sql", "0024_osv_more_ecosystems.sql", "0025_webhooks_enqueue_catchup.sql", "0026_webhook_secret_enc.sql", "0027_dns_cache_seconds.sql", "0028_watchlist_dependencies.sql", "0029_send_counters.sql", "0030_mail_dkim.sql", "0031_mail_resend.sql", "0032_action_reports.sql"]);
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

  it("seeds the 10 sources, enabled with empty config (node-runtime: its 0015 history window; osv: its 0024 ecosystems), and a re-run adds no rows", async () => {
    const read = () =>
      env.DB.prepare("SELECT id, kind, enabled, config_json FROM sources WHERE enabled = 1 ORDER BY id").all<{
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
      expect(r.config_json).toBe(SEEDED_CONFIG[r.id] ?? "{}");
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
