import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { KEY_RETENTION_DEPENDENCIES_SQL } from "../../src/cron/retention";
import {
  DEPENDENCY_COUNT_SQL,
  DEPENDENCY_DELETE_SQL,
  DEPENDENCY_DOCS_SQL,
  DEPENDENCY_MATCH_SQL,
  DEPENDENCY_WINDOW_SQL,
} from "../../src/watchlists/dependencies";

// TCS-37 query plans on 10,000 seeded watchlist_dependencies rows (200 lists
// of 50 dependencies), and the seed rows of migration 0028.

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

const BARE_SCAN = (table: string) => new RegExp(`SCAN ${table}(?! USING)`);
const ECOSYSTEMS = ["npm", "PyPI", "Go", "Maven", "crates.io"];

beforeAll(async () => {
  const lists = env.DB.prepare(
    "INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at) VALUES (?, ?, 'plan37', '{}', 0, 'webhook', '2026-10-20T00:00:00.000Z')",
  );
  const stmts: D1PreparedStatement[] = [];
  for (let l = 0; l < 200; l++) stmts.push(lists.bind(`wl_plan37_${l}`, `key_plan37_${l % 20}`));
  await env.DB.batch(stmts);
  // Multi-row inserts: one JSON parameter of 500 rows per statement.
  const rows: unknown[][] = [];
  for (let i = 0; i < 10_000; i++) {
    const eco = ECOSYSTEMS[i % ECOSYSTEMS.length];
    const name = `pkg-plan37-${i % 2500}`;
    rows.push([`wl_plan37_${i % 200}`, eco, name, eco, name, `1.0.${i}`]);
  }
  const insert = env.DB.prepare(
    `INSERT INTO watchlist_dependencies (watchlist_id, ecosystem, name, dep_ecosystem, dep_name, version)
     SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
     FROM json_each(?)`,
  );
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 500) inserts.push(insert.bind(JSON.stringify(rows.slice(i, i + 500))));
  await env.DB.batch(inserts);
  await env.DB.prepare("ANALYZE").run();
});

describe("query plans on 10,000 watchlist_dependencies rows", () => {
  it("seeded the volume", async () => {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist_dependencies WHERE watchlist_id LIKE 'wl_plan37_%'").first<{ n: number }>();
    expect(r?.n).toBe(10_000);
  });

  it("the match read uses idx_watchlist_dependencies_ecosystem_name and never scans the table", async () => {
    const keys = JSON.stringify([
      ["npm", "pkg-plan37-5"],
      ["PyPI", "pkg-plan37-6"],
      ["Go", "go"],
    ]);
    const p = await plan(DEPENDENCY_MATCH_SQL, keys);
    expect(p).toMatch(/USING (COVERING )?INDEX idx_watchlist_dependencies_ecosystem_name/);
    expect(p).not.toMatch(BARE_SCAN("watchlist_dependencies"));
    expect(p).not.toMatch(BARE_SCAN("w"));
    expect(p).not.toMatch(BARE_SCAN("watchlists"));
  });

  it("the replace DELETE and the count use idx_watchlist_dependencies_watchlist", async () => {
    const del = await plan(DEPENDENCY_DELETE_SQL, "wl_plan37_7", "key_plan37_7");
    expect(del).toMatch(/USING (COVERING )?INDEX idx_watchlist_dependencies_watchlist/);
    expect(del).not.toMatch(BARE_SCAN("watchlist_dependencies"));
    const count = await plan(DEPENDENCY_COUNT_SQL, "wl_plan37_7");
    expect(count).toMatch(/USING (COVERING )?INDEX idx_watchlist_dependencies_watchlist/);
    expect(count).not.toMatch(BARE_SCAN("watchlist_dependencies"));
  });

  it("the monthly key retention delete uses idx_watchlist_dependencies_watchlist", async () => {
    const p = await plan(KEY_RETENTION_DEPENDENCIES_SQL, "2001-01-01T00:00:00.000Z", 5000);
    expect(p).toMatch(/USING (COVERING )?INDEX idx_watchlist_dependencies_watchlist/);
    expect(p).not.toMatch(BARE_SCAN("watchlist_dependencies"));
  });

  it("the window read uses idx_advisories_cursor; the doc fetch is a primary key seek", async () => {
    const w = await plan(DEPENDENCY_WINDOW_SQL, 0, 2000);
    expect(w).toMatch(/USING INDEX idx_advisories_cursor/);
    expect(w).not.toMatch(BARE_SCAN("advisories"));
    const d = await plan(DEPENDENCY_DOCS_SQL, JSON.stringify(["tcs_A", "tcs_B"]));
    expect(d).toMatch(/USING INDEX sqlite_autoindex_advisories_1|USING PRIMARY KEY/);
    expect(d).not.toMatch(BARE_SCAN("advisories"));
  });
});

describe("migration 0028 rows", () => {
  it("the free plan allows 2,000 watched dependencies", async () => {
    const r = await env.DB.prepare("SELECT max_watch_dependencies FROM plans WHERE id = 'free'").first<{ max_watch_dependencies: number }>();
    expect(r?.max_watch_dependencies).toBe(2000);
  });

  it("the two settings rows and the match lane row exist", async () => {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('webhooks.dependency_scan_rows', 'webhooks.dependency_insert_chunk') ORDER BY key",
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([
      { key: "webhooks.dependency_insert_chunk", value: "500" },
      { key: "webhooks.dependency_scan_rows", value: "2000" },
    ]);
    const lane = await env.DB.prepare("SELECT lane FROM match_cursors WHERE lane = 'dependencies'").first<{ lane: string }>();
    expect(lane?.lane).toBe("dependencies");
  });
});
