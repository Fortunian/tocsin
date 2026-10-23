import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron/run";
import { enqueueDeliveries, sweepDeliveries } from "../../src/queue/enqueue";
import { FakeQueue, deliveriesOf, envWith, insertDelivery, seedAdvisory, seedList, setKnob, uid } from "./helpers.tcs-11";

const NOW = new Date("2026-10-23T04:00:00.000Z");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueDeliveries", () => {
  it("run twice for the same advisory: one deliveries row and one queue message", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });
    const q = new FakeQueue();

    await enqueueDeliveries(envWith(q), NOW);
    await enqueueDeliveries(envWith(q), NOW);

    const rows = await deliveriesOf(list.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ advisory_id: adv.id, cursor: adv.cursor, attempt: 0, status: "pending", next_at: NOW.toISOString() });
    expect(q.forList(list.id)).toEqual([{ body: { watchlist_id: list.id, advisory_id: adv.id }, delaySeconds: undefined }]);
  });

  it("enqueue twice with the list cursor held back still sends one message (INSERT OR IGNORE is the gate)", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });
    const q = new FakeQueue();

    await enqueueDeliveries(envWith(q), NOW);
    // Move the list cursor back, as if the cursor write was lost.
    await env.DB.prepare("UPDATE watchlists SET cursor = 0 WHERE id = ?").bind(list.id).run();
    await enqueueDeliveries(envWith(q), NOW);

    expect(await deliveriesOf(list.id)).toHaveLength(1);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([adv.id]);
  });

  it("a poll list that matches the same advisory gets 0 rows and 0 messages", async () => {
    const comp = uid("comp");
    const list = await seedList({ delivery: "poll", filter: { components: [comp] } });
    await seedAdvisory({ component: comp });
    const q = new FakeQueue();

    await enqueueDeliveries(envWith(q), NOW);

    expect(await deliveriesOf(list.id)).toHaveLength(0);
    expect(q.forList(list.id)).toHaveLength(0);
  });

  it("an advisory at or below the list cursor, or in another ecosystem, gets 0 rows", async () => {
    const comp = uid("comp");
    const below = await seedAdvisory({ component: comp });
    const at = await seedAdvisory({ component: comp });
    const otherEco = await seedAdvisory({ component: comp, ecosystem: "PyPI" });
    const match = await seedAdvisory({ component: comp });
    const list = await seedList({ filter: { components: [comp], ecosystems: ["npm"] }, cursor: at.cursor });
    const q = new FakeQueue();

    await enqueueDeliveries(envWith(q), NOW);

    const ids = (await deliveriesOf(list.id)).map((r) => r.advisory_id);
    expect(ids).toEqual([match.id]);
    expect(ids).not.toContain(below.id);
    expect(ids).not.toContain(at.id);
    expect(ids).not.toContain(otherEco.id);
  });

  it("moves the list cursor to the highest enqueued advisory cursor", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    await seedAdvisory({ component: comp });
    const last = await seedAdvisory({ component: comp });
    const q = new FakeQueue();

    await enqueueDeliveries(envWith(q), NOW);

    const row = await env.DB.prepare("SELECT cursor FROM watchlists WHERE id = ?").bind(list.id).first<{ cursor: number }>();
    expect(row!.cursor).toBe(last.cursor);
    expect(q.forList(list.id)).toHaveLength(2);
  });

  it("a backfill that gives already-delivered advisories new cursors does not stall the list", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const a = await seedAdvisory({ component: comp });
    const b = await seedAdvisory({ component: comp });
    await setKnob("webhooks.enqueue_per_list", "2");
    const q = new FakeQueue();
    try {
      await enqueueDeliveries(envWith(q), NOW);
      // The backfill re-cursors both advisories above the list cursor.
      await env.DB.prepare("UPDATE advisories SET cursor = ? WHERE id = ?").bind(a.cursor + 1_000_000, a.id).run();
      await env.DB.prepare("UPDATE advisories SET cursor = ? WHERE id = ?").bind(b.cursor + 1_000_000, b.id).run();
      const c = await seedAdvisory({ component: comp, cursor: b.cursor + 2_000_000 });
      await enqueueDeliveries(envWith(q), NOW);
      await enqueueDeliveries(envWith(q), NOW);
      expect((await deliveriesOf(list.id)).map((r) => r.advisory_id)).toEqual([a.id, b.id, c.id]);
      expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([a.id, b.id, c.id]);
    } finally {
      await setKnob("webhooks.enqueue_per_list", "100");
    }
  });

  it("an advisory published long before the list was made gets a skipped row and no message (backfill)", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] }, createdAt: "2026-10-20T00:00:00.000Z" });
    const old = await seedAdvisory({ component: comp, publishedAt: "2019-01-01T00:00:00Z" });
    const fresh = await seedAdvisory({ component: comp, publishedAt: "2026-10-01T00:00:00Z" });
    const q = new FakeQueue();

    await enqueueDeliveries(envWith(q), NOW);

    const rows = await deliveriesOf(list.id);
    expect(rows.map((r) => [r.advisory_id, r.status])).toEqual([
      [old.id, "skipped"],
      [fresh.id, "pending"],
    ]);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([fresh.id]);
  });

  it("caps the rows per list at webhooks.enqueue_per_list and drains the rest next run", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    for (let i = 0; i < 3; i++) await seedAdvisory({ component: comp });
    await setKnob("webhooks.enqueue_per_list", "2");
    const q = new FakeQueue();
    try {
      await enqueueDeliveries(envWith(q), NOW);
      expect(await deliveriesOf(list.id)).toHaveLength(2);
      await enqueueDeliveries(envWith(q), NOW);
      expect(await deliveriesOf(list.id)).toHaveLength(3);
      expect(q.forList(list.id)).toHaveLength(3);
    } finally {
      await setKnob("webhooks.enqueue_per_list", "100");
    }
  });

  it("a failed queue send keeps the row pending for the sweep", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });
    const q = new FakeQueue();
    q.fail = true;

    const r = await enqueueDeliveries(envWith(q), NOW);

    expect(r.send_errors).toBeGreaterThan(0);
    expect((await deliveriesOf(list.id)).map((d) => [d.advisory_id, d.status])).toEqual([[adv.id, "pending"]]);
  });
});

describe("runCron ingest lane (production entry)", () => {
  it("runCron */10 with an empty registry creates the delivery row and sends the message", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });
    const q = new FakeQueue();
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();

    const ctx = createExecutionContext();
    await runCron(createScheduledController({ cron: "*/10 * * * *", scheduledTime: NOW.getTime() }), envWith(q), ctx, {});
    await waitOnExecutionContext(ctx);

    expect((await deliveriesOf(list.id)).map((r) => r.advisory_id)).toEqual([adv.id]);
    expect(q.forList(list.id).map((m) => m.body.advisory_id)).toEqual([adv.id]);
  });
});

describe("sweepDeliveries", () => {
  it("re-sends a pending row older than the grace once; not a fresh pending row, not a delivered row", async () => {
    const list = await seedList({ filter: { components: [uid("comp")] } });
    const stale = await seedAdvisory();
    const fresh = await seedAdvisory();
    const done = await seedAdvisory();
    const leased = await seedAdvisory();
    const failedRow = await seedAdvisory();
    const old = new Date(NOW.getTime() - 3600_000).toISOString();
    await insertDelivery({ watchlist_id: list.id, advisory_id: stale.id, cursor: stale.cursor, status: "pending", next_at: old });
    await insertDelivery({ watchlist_id: list.id, advisory_id: fresh.id, cursor: fresh.cursor, status: "pending", next_at: NOW.toISOString() });
    await insertDelivery({ watchlist_id: list.id, advisory_id: done.id, cursor: done.cursor, status: "delivered", next_at: old, delivered_at: old });
    await insertDelivery({ watchlist_id: list.id, advisory_id: leased.id, cursor: leased.cursor, status: "sending", next_at: old });
    await insertDelivery({ watchlist_id: list.id, advisory_id: failedRow.id, cursor: failedRow.cursor, status: "failed", next_at: old });
    const q = new FakeQueue();

    await sweepDeliveries(envWith(q), NOW);

    expect(q.forList(list.id).map((m) => m.body.advisory_id).sort()).toEqual([leased.id, stale.id].sort());
  });
});
