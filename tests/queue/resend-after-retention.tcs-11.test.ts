// TCS-11 round 2, finding 3: a delivered event is never sent again, even after
// the daily retention run and a backfill that gives the advisory a new, higher
// feed cursor (the #32 flood). Delivered rows live as long as their watch list;
// failed and skipped rows go after retention.deliveries_days; a deleted list
// (by DELETE or by key retention) takes its rows with it.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDeliveryRetention } from "../../src/cron/deliveries-retention";
import { runKeyRetention } from "../../src/cron/retention";
import { enqueueDeliveries, sweepDeliveries } from "../../src/queue/enqueue";
import { runQueue } from "../../src/queue/run";
import { FakeFetch, FakeQueue, deliveriesOf, deliveryRow, envWith, fakeBatch, nextCursor, seedAdvisory, seedList, uid } from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");
const DAY = 86_400_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function consumeAll(q: FakeQueue, f: FakeFetch, now: Date): Promise<void> {
  if (q.sent.length === 0) return;
  const batch = fakeBatch(q.sent.map((m) => m.body));
  const ctx = createExecutionContext();
  await runQueue(batch, envWith(new FakeQueue()), ctx, { fetch: f.fn, now: () => now });
  await waitOnExecutionContext(ctx);
}

describe("a delivered event after retention and a re-cursor", () => {
  it("deliver, run retention 200 days later, re-cursor the advisory, enqueue: 0 new rows, 0 POSTs", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });

    const q1 = new FakeQueue();
    await enqueueDeliveries(envWith(q1), T0);
    const f = new FakeFetch([200]);
    await consumeAll(q1, f, T0);
    expect(f.calls).toHaveLength(1);
    expect((await deliveryRow(list.id, adv.id))!.status).toBe("delivered");

    const later = new Date(T0.getTime() + 200 * DAY);
    await runDeliveryRetention(env, later);
    expect((await deliveryRow(list.id, adv.id))!.status).toBe("delivered");

    // The #32 flood: a backfill rewrites the advisory with a new, higher cursor.
    await env.DB.prepare("UPDATE advisories SET cursor = ? WHERE id = ?").bind(nextCursor() + 1_000_000, adv.id).run();

    const q2 = new FakeQueue();
    const r = await enqueueDeliveries(envWith(q2), later);
    expect(r.inserted).toBe(0);
    expect(q2.forList(list.id)).toHaveLength(0);
    const sq = new FakeQueue();
    await sweepDeliveries(envWith(sq), later);
    await consumeAll(q2, f, later);
    await consumeAll(sq, f, later);
    expect(f.calls).toHaveLength(1);
    expect(await deliveriesOf(list.id)).toHaveLength(1);
  });

  it("a re-cursored advisory never takes a new row even when the row is not delivered yet", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });
    await enqueueDeliveries(envWith(new FakeQueue()), T0);
    await env.DB.prepare("UPDATE advisories SET cursor = ? WHERE id = ?").bind(nextCursor() + 2_000_000, adv.id).run();
    const fresh = await seedAdvisory({ component: comp, cursor: nextCursor() + 3_000_000 });
    const q = new FakeQueue();
    const r = await enqueueDeliveries(envWith(q), T0);
    expect(r.inserted).toBe(1);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([fresh.id]);
  });
});

describe("retention keeps delivered rows of a live list", () => {
  it("deletes failed and skipped rows past the window, keeps delivered rows", async () => {
    const list = await seedList();
    const now = new Date("2031-03-01T04:41:00.000Z");
    const old = new Date(now.getTime() - 400 * DAY).toISOString();
    const rows = { delivered: uid("a"), failed: uid("a"), skipped: uid("a") };
    for (const [status, a] of Object.entries(rows)) {
      await env.DB.prepare("INSERT INTO deliveries (watchlist_id, advisory_id, cursor, status, next_at, delivered_at) VALUES (?, ?, 1, ?, ?, ?)")
        .bind(list.id, a, status, old, status === "delivered" ? old : null)
        .run();
    }
    await runDeliveryRetention(env, now);
    expect((await deliveryRow(list.id, rows.delivered))!.status).toBe("delivered");
    expect(await deliveryRow(list.id, rows.failed)).toBeNull();
    expect(await deliveryRow(list.id, rows.skipped)).toBeNull();
  });

  it("key retention deletes the deliveries of the lists it deletes", async () => {
    const keyId = uid("keyold");
    await env.DB.prepare("INSERT INTO api_keys (id, key_hash, plan, email, created_at, last_used_at) VALUES (?, ?, 'free', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')")
      .bind(keyId, `hash-${keyId}`, `${keyId}@example.test`)
      .run();
    const list = await seedList({ keyId });
    const a = uid("a");
    await env.DB.prepare("INSERT INTO deliveries (watchlist_id, advisory_id, cursor, status, next_at, delivered_at) VALUES (?, ?, 1, 'delivered', 'x', 'x')").bind(list.id, a).run();
    await runKeyRetention(env, new Date("2026-10-23T03:17:00.000Z"));
    expect(await env.DB.prepare("SELECT id FROM watchlists WHERE id = ?").bind(list.id).first()).toBeNull();
    expect(await deliveryRow(list.id, a)).toBeNull();
  });
});
