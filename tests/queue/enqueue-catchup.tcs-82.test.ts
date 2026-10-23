// TCS-82 item 1: catch-up after a cursor flood. A backfill can re-cursor tens
// of thousands of advisories a list already has a deliveries row for. The
// cursor must pass them in SQL, so the list reaches a new matching event in
// one run. Also: the per-run cap is the settings row webhooks.enqueue_per_list
// (1000, sent in sendBatch chunks of 100), and a list whose cursor lags more
// than webhooks.lag_alert_rows rows logs one alert line.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnqueueStatements, buildLagCountStatement, enqueueDeliveries } from "../../src/queue/enqueue";
import { FakeQueue, deliveriesOf, envWith, seedAdvisory, seedList, setKnob, uid } from "./helpers.tcs-11";

const NOW = new Date("2026-10-23T04:00:00.000Z");
const BARE_SCAN = (table: string) => new RegExp(`SCAN ${table}(?! USING)`);

// Records the size of each sendBatch call.
class CountingQueue extends FakeQueue {
  batches: number[] = [];
  override async sendBatch(msgs: Iterable<{ body: unknown; delaySeconds?: number }>): Promise<void> {
    const all = [...msgs];
    this.batches.push(all.length);
    await super.sendBatch(all);
  }
}

// Cursor ranges per test, far above the helpers' nextCursor() range.
let base = 100_000_000;
function nextBase(): number {
  base += 1_000_000;
  return base;
}

// n advisories of one component at cursors from+1..from+n, in one statement.
async function seedFlood(component: string, from: number, n: number, publishedAt = "2026-10-21T00:00:00Z"): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?1)
     INSERT INTO advisories (id, ecosystem, component, severity_label, published_at, modified_at, doc_json, cursor)
     SELECT 'tcs_flood_' || ?2 || '_' || i, 'npm', ?2, 'high', ?3, ?3, '{}', ?4 + i FROM s`,
  )
    .bind(n, component, publishedAt, from)
    .run();
}

// A delivered row for every advisory of the component (the flood was sent before the backfill).
async function markDelivered(listId: string, component: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at, delivered_at)
     SELECT ?1, id, cursor, 1, 'delivered', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z' FROM advisories WHERE component = ?2`,
  )
    .bind(listId, component)
    .run();
}

async function listCursor(id: string): Promise<number> {
  const r = await env.DB.prepare("SELECT cursor FROM watchlists WHERE id = ?").bind(id).first<{ cursor: number }>();
  return r!.cursor;
}

async function plan(sql: string, params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

function lagAlerts(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c: unknown[]) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((o: Record<string, unknown>) => o.alert === "lag");
}

const KNOBS = ["webhooks.enqueue_per_list", "webhooks.enqueue_scan_rows", "webhooks.lag_alert_rows"];
let saved: Array<{ key: string; value: string }> = [];
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  saved = (await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)").bind(...KNOBS).all<{ key: string; value: string }>()).results;
  vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Lists of earlier tests in this file stop taking part, so each test counts
  // only its own list (a paused list is not read by enqueue).
  await env.DB.prepare("UPDATE watchlists SET paused_at = '2026-10-01T00:00:00.000Z' WHERE paused_at IS NULL").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Put back what this test found, so no test sees another test's knob.
  await env.DB.prepare("DELETE FROM settings WHERE key IN (?, ?, ?)").bind(...KNOBS).run();
  for (const r of saved) await setKnob(r.key, r.value);
});

describe("enqueue catch-up over a cursor flood", () => {
  it("the knob rows come from the migrations: enqueue_per_list 1000, enqueue_scan_rows 100000, lag_alert_rows 5000", async () => {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('webhooks.enqueue_per_list', 'webhooks.enqueue_scan_rows', 'webhooks.lag_alert_rows') ORDER BY key",
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([
      { key: "webhooks.enqueue_per_list", value: "1000" },
      { key: "webhooks.enqueue_scan_rows", value: "100000" },
      { key: "webhooks.lag_alert_rows", value: "5000" },
    ]);
  });

  it("a 50,000-row flood of delivered advisories: one run reaches the new matching event", async () => {
    const comp = uid("flood");
    const list = await seedList({ filter: { components: [comp] } });
    const b = nextBase();
    await seedFlood(comp, b, 50_000);
    await markDelivered(list.id, comp);
    const fresh = await seedAdvisory({ component: comp, cursor: b + 50_001 });
    const q = new CountingQueue();

    const r = await enqueueDeliveries(envWith(q), NOW);

    const pending = (await deliveriesOf(list.id)).filter((d) => d.status === "pending");
    expect(pending.map((d) => d.advisory_id)).toEqual([fresh.id]);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([fresh.id]);
    expect(await listCursor(list.id)).toBe(fresh.cursor);
    expect(r).toMatchObject({ inserted: 1, sent: 1, lagging_lists: 0 });
    expect(lagAlerts(errSpy)).toEqual([]);
  });

  it("reads 1000 from the seeded enqueue_per_list row: 1000 fresh rows give 1000 pending rows in 10 sendBatch calls of 100", async () => {
    const comp = uid("big");
    const list = await seedList({ filter: { components: [comp] } });
    await seedFlood(comp, nextBase(), 1200);
    const q = new CountingQueue();

    const r = await enqueueDeliveries(envWith(q), NOW);

    const rows = await deliveriesOf(list.id);
    expect(rows).toHaveLength(1000);
    expect(rows.every((d) => d.status === "pending")).toBe(true);
    expect(q.batches).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    expect(q.forList(list.id)).toHaveLength(1000);
    expect(r).toMatchObject({ inserted: 1000, sent: 1000, send_errors: 0 });
    // The cursor stops at the 1000th row: rows 1001..1200 wait for the next run.
    expect(await listCursor(list.id)).toBe(rows[999].cursor);
    await enqueueDeliveries(envWith(q), NOW);
    expect(await deliveriesOf(list.id)).toHaveLength(1200);
  });

  it("a flood bigger than enqueue_scan_rows drains over 3 runs and never passes a fresh row", async () => {
    await setKnob("webhooks.enqueue_scan_rows", "1000");
    const comp = uid("scan");
    const list = await seedList({ filter: { components: [comp] } });
    const b = nextBase();
    await seedFlood(comp, b, 2500);
    await markDelivered(list.id, comp);
    // One advisory inside the flood has no deliveries row (fresh): cursor b+1500.
    const inside = `tcs_flood_${comp}_1500`;
    await env.DB.prepare("DELETE FROM deliveries WHERE watchlist_id = ? AND advisory_id = ?").bind(list.id, inside).run();
    const fresh = await seedAdvisory({ component: comp, cursor: b + 2501 });
    const q = new CountingQueue();

    await enqueueDeliveries(envWith(q), NOW);
    expect(await listCursor(list.id)).toBe(b + 1000);
    expect(q.forList(list.id)).toEqual([]);

    await enqueueDeliveries(envWith(q), NOW);
    expect(await listCursor(list.id)).toBe(b + 2000);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([inside]);

    await enqueueDeliveries(envWith(q), NOW);
    expect(await listCursor(list.id)).toBe(fresh.cursor);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([inside, fresh.id]);
  });

  it("enqueue_per_list 2 with 5 fresh rows inside a flood: run 1 inserts 2 and the cursor stops at the 2nd fresh row", async () => {
    await setKnob("webhooks.enqueue_per_list", "2");
    const comp = uid("cap");
    const list = await seedList({ filter: { components: [comp] } });
    const b = nextBase();
    await seedFlood(comp, b, 20);
    await markDelivered(list.id, comp);
    const freshIds = [3, 6, 9, 12, 15].map((i) => `tcs_flood_${comp}_${i}`);
    for (const id of freshIds) await env.DB.prepare("DELETE FROM deliveries WHERE watchlist_id = ? AND advisory_id = ?").bind(list.id, id).run();
    const q = new CountingQueue();

    await enqueueDeliveries(envWith(q), NOW);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual(freshIds.slice(0, 2));
    expect(await listCursor(list.id)).toBe(b + 6);

    await enqueueDeliveries(envWith(q), NOW);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual(freshIds.slice(0, 4));
    expect(await listCursor(list.id)).toBe(b + 12);

    await enqueueDeliveries(envWith(q), NOW);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual(freshIds);
    expect(await listCursor(list.id)).toBe(b + 20);
  });

  it("a row of another component is not matching: the cursor may pass it, and its own list still gets it", async () => {
    const comp = uid("mine");
    const other = uid("other");
    const list = await seedList({ filter: { components: [comp] } });
    const otherList = await seedList({ filter: { components: [other] } });
    const b = nextBase();
    await seedFlood(comp, b, 10);
    await markDelivered(list.id, comp);
    const theirs = await seedAdvisory({ component: other, cursor: b + 5_000 });
    const mine = await seedAdvisory({ component: comp, cursor: b + 6_000 });
    const q = new CountingQueue();

    await enqueueDeliveries(envWith(q), NOW);

    expect(await listCursor(list.id)).toBe(mine.cursor);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([mine.id]);
    expect(q.forList(otherList.id).map((m) => m.body.advisory_id)).toEqual([theirs.id]);
  });
});

describe("lag alert at webhooks.lag_alert_rows", () => {
  // enqueue_scan_rows 5 holds the cursor 5 rows into the flood each run.
  async function laggingList(floodRows: number): Promise<string> {
    await setKnob("webhooks.enqueue_per_list", "5");
    await setKnob("webhooks.enqueue_scan_rows", "5");
    const comp = uid("lag");
    const list = await seedList({ filter: { components: [comp] } });
    await seedFlood(comp, nextBase(), floodRows);
    await markDelivered(list.id, comp);
    return list.id;
  }

  it("lag 10 with lag_alert_rows 10: no alert line, lagging_lists 0", async () => {
    await setKnob("webhooks.lag_alert_rows", "10");
    const id = await laggingList(15);
    const r = await enqueueDeliveries(envWith(new CountingQueue()), NOW);
    expect(r.lagging_lists).toBe(0);
    expect(lagAlerts(errSpy)).toEqual([]);
    expect(await listCursor(id)).toBeGreaterThan(0);
  });

  it("lag 11 with lag_alert_rows 10: one alert line with the list id, lagging_lists 1", async () => {
    await setKnob("webhooks.lag_alert_rows", "10");
    const id = await laggingList(16);
    const r = await enqueueDeliveries(envWith(new CountingQueue()), NOW);
    expect(r.lagging_lists).toBe(1);
    const alerts = lagAlerts(errSpy);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ lane: "enqueue", alert: "lag", watchlist_id: id, lag_rows_at_least: 11, lag_alert_rows: 10 });
  });

  it("lag_alert_rows 0 turns the check off", async () => {
    await setKnob("webhooks.lag_alert_rows", "0");
    await laggingList(16);
    const r = await enqueueDeliveries(envWith(new CountingQueue()), NOW);
    expect(r.lagging_lists).toBe(0);
    expect(lagAlerts(errSpy)).toEqual([]);
  });
});

describe("EXPLAIN QUERY PLAN over the 50,000-row flood", () => {
  const filters = [
    { ecosystems: [], components: [], runtimes: {}, min_severity: null, exploited_only: false },
    { ecosystems: ["npm"], components: [], runtimes: {}, min_severity: null, exploited_only: false },
    { ecosystems: [], components: ["left-pad"], runtimes: {}, min_severity: "high" as const, exploited_only: false },
  ];

  it("the cursor statement, the insert and the lag count use an index, never a bare SCAN advisories", async () => {
    // Its own flood, so the test does not depend on the order of the tests above.
    await seedFlood(uid("explain"), nextBase(), 50_000);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories").first<{ n: number }>();
    expect(count!.n).toBeGreaterThanOrEqual(50_000);
    for (const f of filters) {
      const s = buildEnqueueStatements(f, "wl_plan82", 0, 1000, "2026-01-01T00:00:00.000Z", NOW.toISOString(), 100_000);
      const cursorPlan = await plan(s.cursorSql, s.cursorParams);
      const insertPlan = await plan(s.insertSql, s.insertParams);
      const lag = buildLagCountStatement(f, 0, 5001);
      const lagPlan = await plan(lag.sql, lag.params);
      for (const p of [cursorPlan, insertPlan, lagPlan]) {
        expect(p).toMatch(/USING (COVERING )?INDEX idx_advisories_/);
        expect(p).not.toMatch(BARE_SCAN("advisories"));
        expect(p).not.toMatch(BARE_SCAN("deliveries"));
        expect(p).not.toMatch(BARE_SCAN("d"));
      }
      expect(cursorPlan).toMatch(/SEARCH d USING (COVERING )?INDEX sqlite_autoindex_deliveries_1 \(watchlist_id=\? AND advisory_id=\?\)/);
      expect(insertPlan).toMatch(/SEARCH d USING (COVERING )?INDEX sqlite_autoindex_deliveries_1 \(watchlist_id=\? AND advisory_id=\?\)/);
    }
  });
});
