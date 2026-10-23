import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { SEND_COUNTER_DRY_RUN_SQL, SEND_COUNTER_RETENTION_SQL } from "../../src/cron/send-counters-retention";
import { REFUND_SQL, RESERVE_INSERT_SQL, RESERVE_UPDATE_SQL, SNAPSHOT_SQL } from "../../src/mail/send-caps";

// TCS-83: every statement on send_counters, on 5,000 seeded rows, reads by
// the primary key or by idx_send_counters_created_at, never by a bare scan.

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

const BARE_SCAN = /SCAN send_counters(?! USING)/;
const BY_PK = /SEARCH send_counters USING (COVERING )?INDEX sqlite_autoindex_send_counters_1 \(window_key=\?\)|SEARCH send_counters USING PRIMARY KEY/;
const BY_CREATED = /(SEARCH|SCAN) send_counters USING (COVERING )?INDEX idx_send_counters_created_at/;
const KEYS = ["ip:192.0.2.7:600000", "em:fixture-hash:600000", "day:2041-01-01"];
const NOW = "2041-01-01T00:00:00.000Z";

beforeAll(async () => {
  const ins = env.DB.prepare("INSERT INTO send_counters (window_key, n, created_at) VALUES (?, ?, ?)");
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 5000; i++) {
    stmts.push(ins.bind(`ip:198.51.100.${i % 250}:${590000 + i}`, i % 10, new Date(Date.UTC(2040, 11, 1) + i * 60_000).toISOString()));
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM send_counters").first<{ n: number }>();
  expect(n?.n).toBe(5000);
});

describe("send_counters statements", () => {
  it("P1: the reserve update reads and writes by the primary key", async () => {
    const p = await plan(RESERVE_UPDATE_SQL, ...KEYS, NOW, 10, 3, 500);
    expect(p).toMatch(BY_PK);
    expect(p).not.toMatch(BARE_SCAN);
  });

  it("P1b: the reserve insert scans nothing", async () => {
    const p = await plan(RESERVE_INSERT_SQL, ...KEYS, NOW);
    expect(p).not.toMatch(BARE_SCAN);
  });

  it("P2: the snapshot read and the refund use the primary key", async () => {
    for (const sql of [SNAPSHOT_SQL, REFUND_SQL]) {
      const p = await plan(sql, ...KEYS);
      expect(p, sql).toMatch(BY_PK);
      expect(p, sql).not.toMatch(BARE_SCAN);
    }
  });

  it("P3: the retention delete and the dry-run count use idx_send_counters_created_at", async () => {
    const del = await plan(SEND_COUNTER_RETENTION_SQL, NOW, 5000);
    expect(del).toMatch(BY_CREATED);
    expect(del).not.toMatch(BARE_SCAN);
    const count = await plan(SEND_COUNTER_DRY_RUN_SQL, NOW);
    expect(count).toMatch(BY_CREATED);
    expect(count).not.toMatch(BARE_SCAN);
  });

  it("P4: the 3 retention settings rows exist with their seed values", async () => {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'retention.send_counters_%'").all<{ key: string; value: string }>();
    expect(Object.fromEntries(results.map((r) => [r.key, r.value]))).toEqual({
      "retention.send_counters_days": "2",
      "retention.send_counters_batch": "5000",
      "retention.send_counters_dry_run": "0",
    });
  });
});
