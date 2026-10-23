import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DELIVERED_RETENTION_SQL,
  FAILED_RETENTION_SQL,
  SKIPPED_RETENTION_SQL,
} from "../../src/cron/deliveries-retention";
import { SWEEP_SQL, WEBHOOK_LISTS_SQL, buildEnqueueStatements } from "../../src/queue/enqueue";
import { DELIVERIES_LIST_SQL } from "../../src/routes/watchlists";
import { call, newKey } from "./keys-helpers.tcs-8";

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}
const BARE_SCAN = (table: string) => new RegExp(`SCAN ${table}(?! USING)`);
const STATUSES = ["pending", "sending", "delivered", "failed", "skipped"];

async function createList(key: string, name = "d"): Promise<string> {
  const res = await call("POST", "/v1/watchlists", { key, body: { name } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function seedRows(watchlistId: string, n: number, cursorBase: number): Promise<void> {
  const ins = env.DB.prepare(
    "INSERT INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, last_code, next_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < n; i++) {
    const status = STATUSES[i % STATUSES.length];
    const day = String(1 + (i % 28)).padStart(2, "0");
    const ts = `2026-0${1 + (i % 9)}-${day}T00:00:00.000Z`;
    stmts.push(ins.bind(watchlistId, `adv_${watchlistId}_${i}`, cursorBase + i, i % 6, status, status === "delivered" ? 200 : null, ts, status === "delivered" ? ts : null));
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
}

describe("deliveries table", () => {
  it("has the named columns and the (watchlist_id, advisory_id) primary key", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(deliveries)").all<{ name: string; pk: number }>();
    expect(results.map((r) => r.name)).toEqual(["watchlist_id", "advisory_id", "cursor", "attempt", "status", "last_code", "next_at", "delivered_at"]);
    expect(results.filter((r) => r.pk > 0).map((r) => r.name)).toEqual(["watchlist_id", "advisory_id"]);
    await env.DB.prepare("INSERT INTO deliveries (watchlist_id, advisory_id, cursor, next_at) VALUES ('wl_pk', 'adv_pk', 1, 'x')").run();
    const dup = await env.DB.prepare("INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, next_at) VALUES ('wl_pk', 'adv_pk', 2, 'y')").run();
    expect(dup.meta.changes).toBe(0);
  });
});

describe("GET /v1/watchlists/:id/deliveries", () => {
  it("lists the 100 newest deliveries by cursor with status, no-store", async () => {
    const { key } = await newKey();
    const id = await createList(key);
    await seedRows(id, 120, 9_000_000);

    const res = await call("GET", `/v1/watchlists/${id}/deliveries`, { key });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { deliveries: Array<{ advisory_id: string; cursor: number; status: string; next_at?: string | null }> };
    expect(body.deliveries).toHaveLength(100);
    expect(body.deliveries.map((d) => d.cursor)).toEqual(Array.from({ length: 100 }, (_, i) => 9_000_000 + 119 - i));
    for (const d of body.deliveries) {
      expect(STATUSES).toContain(d.status);
      if (d.status !== "pending") expect(d.next_at ?? null).toBeNull();
    }
    expect(body.deliveries.find((d) => d.status === "pending")!.next_at).toMatch(/^2026-/);
  });

  it("an empty list answers 200 with no deliveries", async () => {
    const { key } = await newKey();
    const id = await createList(key);
    const res = await call("GET", `/v1/watchlists/${id}/deliveries`, { key });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deliveries: [] });
  });

  it("another key's list answers 404 with 0 rows (wrong tenant)", async () => {
    const owner = await newKey();
    const other = await newKey();
    const id = await createList(owner.key);
    await seedRows(id, 5, 9_100_000);
    const res = await call("GET", `/v1/watchlists/${id}/deliveries`, { key: other.key });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("adv_");
  });

  it("DELETE /v1/watchlists/:id also deletes the list's deliveries; another key's DELETE removes none", async () => {
    const owner = await newKey();
    const other = await newKey();
    const id = await createList(owner.key);
    await seedRows(id, 7, 9_200_000);
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE watchlist_id = ?").bind(id).first<{ n: number }>())!.n;

    expect((await call("DELETE", `/v1/watchlists/${id}`, { key: other.key })).status).toBe(404);
    expect(await count()).toBe(7);

    expect((await call("DELETE", `/v1/watchlists/${id}`, { key: owner.key })).status).toBe(204);
    expect(await count()).toBe(0);
  });
});

describe("query plans on 5,000 deliveries and 1,000 watch lists", () => {
  beforeAll(async () => {
    const lists = env.DB.prepare(
      "INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at) VALUES (?, ?, 'p', '{}', 0, ?, '2026-10-01T00:00:00.000Z')",
    );
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 1000; i++) stmts.push(lists.bind(`wl_plan11_${String(i).padStart(4, "0")}`, `key_plan11_${i}`, i % 3 === 0 ? "webhook" : "poll"));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    for (let w = 0; w < 50; w++) await seedRows(`wl_plan11_${String(w).padStart(4, "0")}`, 100, 10_000_000 + w * 1000);
    await env.DB.prepare("ANALYZE").run();
  });

  it("seeded the volume", async () => {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE watchlist_id LIKE 'wl_plan11_%'").first<{ n: number }>();
    expect(r!.n).toBe(5000);
  });

  it("the sweep uses idx_deliveries_status_next_at", async () => {
    const p = await plan(SWEEP_SQL, "pending", "2026-05-01T00:00:00.000Z", 500);
    expect(p).toContain("idx_deliveries_status_next_at");
    expect(p).not.toMatch(BARE_SCAN("deliveries"));
  });

  it("the list route uses idx_deliveries_watchlist_cursor", async () => {
    const p = await plan(DELIVERIES_LIST_SQL, "wl_plan11_0007", "key_plan11_7", 100);
    expect(p).toContain("idx_deliveries_watchlist_cursor");
    expect(p).not.toMatch(BARE_SCAN("deliveries"));
    expect(p).not.toMatch(BARE_SCAN("watchlists"));
  });

  it("the enqueue insert and cursor update read advisories by an index, never a bare SCAN", async () => {
    const filters = [
      { ecosystems: [], components: [], runtimes: {}, min_severity: null, exploited_only: false },
      { ecosystems: ["npm"], components: [], runtimes: {}, min_severity: null, exploited_only: false },
      { ecosystems: [], components: ["pkg-fixture-1"], runtimes: {}, min_severity: "high", exploited_only: true },
    ] as const;
    for (const f of filters) {
      const s = buildEnqueueStatements({ ...f, ecosystems: [...f.ecosystems], components: [...f.components] }, "wl_plan11_0007", 0, 100, "2026-01-01T00:00:00.000Z", "2026-10-23T00:00:00.000Z");
      const ins = await plan(s.insertSql, ...s.insertParams);
      const cur = await plan(s.cursorSql, ...s.cursorParams);
      for (const p of [ins, cur]) {
        expect(p).toMatch(/advisories USING (COVERING )?INDEX/);
        expect(p).not.toMatch(BARE_SCAN("advisories"));
      }
      expect(cur).not.toMatch(BARE_SCAN("watchlists"));
    }
  });

  it("the webhook-list read uses idx_watchlists_delivery", async () => {
    const p = await plan(WEBHOOK_LISTS_SQL, "wl_plan11_0100", 1000);
    expect(p).toContain("idx_watchlists_delivery");
    expect(p).not.toMatch(BARE_SCAN("watchlists"));
  });

  it("the three retention deletes use their status indexes", async () => {
    const d = await plan(DELIVERED_RETENTION_SQL, "2026-03-01T00:00:00.000Z", 5000);
    expect(d).toContain("idx_deliveries_status_delivered_at");
    expect(d).not.toMatch(BARE_SCAN("deliveries"));
    for (const sql of [FAILED_RETENTION_SQL, SKIPPED_RETENTION_SQL]) {
      const p = await plan(sql, "2026-03-01T00:00:00.000Z", 5000);
      expect(p).toContain("idx_deliveries_status_next_at");
      expect(p).not.toMatch(BARE_SCAN("deliveries"));
    }
  });
});
