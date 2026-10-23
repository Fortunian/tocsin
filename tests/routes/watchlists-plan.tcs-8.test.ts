import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { AUTH_SQL } from "../../src/middleware/auth";
import { KEY_RETENTION_SELECT_SQL } from "../../src/cron/retention";
import { CREATE_WATCHLIST_SQL, LIST_WATCHLISTS_SQL } from "../../src/routes/watchlists";
import { buildWatchlistEventsQuery } from "../../src/watchlists/query";

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

const ECOSYSTEMS = ["node", "php", "npm", "PyPI", "Go", "crates.io"];
const BARE_SCAN = (table: string) => new RegExp(`SCAN ${table}(?! USING)`);

// 2,000 keys, 2,000 watch lists (one per key) and 2,000 advisories.
beforeAll(async () => {
  const keys = env.DB.prepare(
    "INSERT INTO api_keys (id, key_hash, plan, email, created_at, last_used_at) VALUES (?, ?, 'free', ?, ?, ?)",
  );
  const lists = env.DB.prepare(
    "INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at) VALUES (?, ?, ?, '{}', 0, 'poll', ?)",
  );
  const adv = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor)
     VALUES (?, NULL, ?, ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)`,
  );
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 2000; i++) {
    const day = String(1 + (i % 28)).padStart(2, "0");
    const ts = `2025-0${1 + (i % 9)}-${day}T00:00:00.000Z`;
    stmts.push(keys.bind(`key_plan_${i}`, `hash-fixture-${i}`, `plan-${i}@example.test`, ts, ts));
    stmts.push(lists.bind(`wl_plan_${i}`, `key_plan_${i}`, `list ${i}`, ts));
    stmts.push(adv.bind(`plan_adv_${i}`, ECOSYSTEMS[i % ECOSYSTEMS.length], `pkg-fixture-${i % 50}`, 1 + i));
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  await env.DB.prepare("ANALYZE").run();
});

describe("query plans on 2,000 keys, 2,000 watch lists and 2,000 advisories", () => {
  it("seeded the volume", async () => {
    const r = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM api_keys) AS k, (SELECT COUNT(*) FROM watchlists) AS w, (SELECT COUNT(*) FROM advisories) AS a",
    ).first<{ k: number; w: number; a: number }>();
    expect(r).toEqual({ k: 2000, w: 2000, a: 2000 });
  });

  it("the auth key lookup uses idx_api_keys_key_hash", async () => {
    const p = await plan(AUTH_SQL, "hash-fixture-77");
    expect(p).toContain("USING INDEX idx_api_keys_key_hash");
    expect(p).not.toMatch(BARE_SCAN("api_keys"));
  });

  it("the list read and the create count use idx_watchlists_key_id", async () => {
    const list = await plan(LIST_WATCHLISTS_SQL, "key_plan_5");
    expect(list).toMatch(/USING (COVERING )?INDEX idx_watchlists_key_id/);
    expect(list).not.toMatch(BARE_SCAN("watchlists"));

    const create = await plan(CREATE_WATCHLIST_SQL, "wl_x", "key_plan_5", "n", "{}", "2026-10-23T00:00:00.000Z", "key_plan_5", 25);
    expect(create).toMatch(/USING (COVERING )?INDEX idx_watchlists_key_id/);
    expect(create).not.toMatch(BARE_SCAN("watchlists"));
    expect(create).not.toMatch(BARE_SCAN("advisories"));
  });

  it("the retention select uses idx_api_keys_last_used_at", async () => {
    const p = await plan(KEY_RETENTION_SELECT_SQL, "2025-03-01T00:00:00.000Z", 5000);
    expect(p).toContain("idx_api_keys_last_used_at");
    expect(p).not.toMatch(BARE_SCAN("api_keys"));
  });

  it("the watch list events query never does a bare SCAN of advisories", async () => {
    const variants = [
      { ecosystems: ["node"], components: [], runtimes: {}, min_severity: null, exploited_only: false },
      { ecosystems: [], components: Array.from({ length: 2000 }, (_, i) => `pkg-fixture-${i}`), runtimes: {}, min_severity: null, exploited_only: false },
      { ecosystems: ["php"], components: [], runtimes: { node: "24.0.0" }, min_severity: "high", exploited_only: true },
      { ecosystems: [], components: [], runtimes: {}, min_severity: null, exploited_only: false },
    ] as const;
    for (const f of variants) {
      const q = buildWatchlistEventsQuery({ ...f, ecosystems: [...f.ecosystems], components: [...f.components] }, 1000, 50);
      const p = await plan(q.sql, ...q.params);
      expect(p, JSON.stringify(f).slice(0, 80)).toContain("USING");
      expect(p).not.toMatch(BARE_SCAN("advisories"));
    }
  });
});

describe("plans seed", () => {
  it("has exactly one row: free with 25 lists, 1 webhook, 2000 components", async () => {
    const { results } = await env.DB.prepare("SELECT id, max_watchlists, webhooks, max_components FROM plans").all();
    expect(results).toEqual([{ id: "free", max_watchlists: 25, webhooks: 1, max_components: 2000 }]);
  });

  it("has the 4 named indexes", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const n of ["idx_api_keys_key_hash", "idx_api_keys_email", "idx_api_keys_last_used_at", "idx_watchlists_key_id"]) {
      expect(names).toContain(n);
    }
  });
});
