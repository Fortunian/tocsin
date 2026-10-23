// TCS-82 item 6 (comment 6373816984): failed deliveries rows are kept for the
// life of the list, like delivered rows. A failed row is the record that the
// pair was tried; if the daily job deleted it, a backfill that re-cursors the
// advisory would queue the pair again and POST it again. The daily job still
// deletes skipped rows past retention.deliveries_days.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { DELIVERY_RETENTION_AUDIT_KEY, runDeliveryRetention } from "../../src/cron/deliveries-retention";
import { DELIVERY_RETENTION_CRON } from "../../src/cron/run";
import { enqueueDeliveries } from "../../src/queue/enqueue";
import { call, newKey } from "../routes/keys-helpers.tcs-8";
import { FakeQueue, deliveriesOf, deliveryRow, envWith, nextCursor, seedAdvisory, seedList, setKnob, uid } from "../queue/helpers.tcs-11";

const DAY = 86_400_000;

async function insertRow(watchlistId: string, advisoryId: string, cursor: number, status: string, at: Date): Promise<void> {
  await env.DB.prepare("INSERT INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at) VALUES (?, ?, ?, 6, ?, ?)")
    .bind(watchlistId, advisoryId, cursor, status, at.toISOString())
    .run();
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("retention.deliveries_dry_run", "0");
});

describe("failed rows are kept for the life of the list", () => {
  it("a failed row 200 days old survives the daily job; a skipped row 200 days old is deleted; the audit has no failed field", async () => {
    const now = new Date("2034-06-15T04:41:00.000Z");
    const list = await seedList();
    const failed = uid("adv");
    const skipped = uid("adv");
    await insertRow(list.id, failed, 1, "failed", new Date(now.getTime() - 200 * DAY));
    await insertRow(list.id, skipped, 2, "skipped", new Date(now.getTime() - 200 * DAY));

    const a = await runDeliveryRetention(env, now);

    expect(await deliveryRow(list.id, failed)).toMatchObject({ status: "failed" });
    expect(await deliveryRow(list.id, skipped)).toBeNull();
    expect(a).not.toHaveProperty("failed");
    expect(a.skipped).toBeGreaterThanOrEqual(1);
    const audit = JSON.parse((await env.CURSORS.get(DELIVERY_RETENTION_AUDIT_KEY))!) as Record<string, unknown>;
    expect(audit).not.toHaveProperty("failed");
    expect(audit).toMatchObject({ ran_at: now.toISOString(), dry_run: false });
  });

  it("the dry run counts skipped rows only", async () => {
    const now = new Date("2035-06-15T04:41:00.000Z");
    const list = await seedList();
    await insertRow(list.id, uid("adv"), 1, "failed", new Date(now.getTime() - 200 * DAY));
    await setKnob("retention.deliveries_dry_run", "1");
    const a = await runDeliveryRetention(env, now);
    expect(a).toMatchObject({ dry_run: true });
    expect(a).not.toHaveProperty("failed");
    expect(typeof a.skipped).toBe("number");
  });

  it("through the daily cron (production entry), a re-cursor of the failed advisory past 90 days takes no new row and sends nothing", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const adv = await seedAdvisory({ component: comp });
    const now = new Date();
    await insertRow(list.id, adv.id, adv.cursor, "failed", new Date(now.getTime() - 200 * DAY));
    await env.DB.prepare("UPDATE watchlists SET cursor = ? WHERE id = ?").bind(adv.cursor, list.id).run();

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: DELIVERY_RETENTION_CRON, scheduledTime: now.getTime() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "failed" });

    // A backfill moves the advisory above the list cursor.
    await env.DB.prepare("UPDATE advisories SET cursor = ? WHERE id = ?").bind(nextCursor() + 7_000_000, adv.id).run();
    const q = new FakeQueue();
    await enqueueDeliveries(envWith(q), now);
    expect(q.forList(list.id)).toEqual([]);
    expect(await deliveriesOf(list.id)).toHaveLength(1);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "failed" });
  });

  it("DELETE /v1/watchlists/:id deletes the list's failed rows", async () => {
    const { key } = await newKey();
    const created = await call("POST", "/v1/watchlists", { key, body: { name: "fk" } });
    const { id } = (await created.json()) as { id: string };
    const adv = uid("adv");
    await insertRow(id, adv, 1, "failed", new Date("2026-01-01T00:00:00.000Z"));
    const del = await call("DELETE", `/v1/watchlists/${id}`, { key });
    expect(del.status).toBe(204);
    expect(await deliveryRow(id, adv)).toBeNull();
  });
});
