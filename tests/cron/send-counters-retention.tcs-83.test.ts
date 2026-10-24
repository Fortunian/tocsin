import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_RETENTION_CRON, runCron } from "../../src/cron/run";
import { SEND_COUNTER_RETENTION_AUDIT_KEY, runSendCounterRetention } from "../../src/cron/send-counters-retention";
import { deliveryRow, insertDelivery, setKnob, uid } from "../queue/helpers.tcs-11";

// TCS-83: the daily job deletes send_counters rows older than
// retention.send_counters_days. Each test works in its own era (a fixed `now`
// far apart), so a run in one test deletes none of another test's rows.

const DAY = 86_400_000;

async function row(at: Date): Promise<string> {
  const key = `day:${uid("ret83")}`;
  await env.DB.prepare("INSERT INTO send_counters (window_key, n, created_at) VALUES (?, 1, ?)").bind(key, at.toISOString()).run();
  return key;
}
async function gone(key: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM send_counters WHERE window_key = ?").bind(key).first()) === null;
}
async function audit(): Promise<Record<string, unknown> | null> {
  const raw = await env.CURSORS.get(SEND_COUNTER_RETENTION_AUDIT_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.CURSORS.delete(SEND_COUNTER_RETENTION_AUDIT_KEY);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("retention.send_counters_days", "2");
  await setKnob("retention.send_counters_batch", "5000");
  await setKnob("retention.send_counters_dry_run", "0");
  await setKnob("retention.deliveries_days", "90");
});

describe("runSendCounterRetention", () => {
  it("R1: deletes rows 3 days old and keeps rows 1 day old (default window 2 days)", async () => {
    const now = new Date("2051-03-10T04:41:00.000Z");
    const old = await row(new Date(now.getTime() - 3 * DAY));
    const young = await row(new Date(now.getTime() - 1 * DAY));
    const a = await runSendCounterRetention(env, now);
    expect(await gone(old)).toBe(true);
    expect(await gone(young)).toBe(false);
    expect(a).toMatchObject({ dry_run: false, deleted: 1, has_more: false, cutoff: new Date(now.getTime() - 2 * DAY).toISOString() });
  });

  it("R2: retention.send_counters_days=5 keeps rows 3 days old", async () => {
    const now = new Date("2052-03-10T04:41:00.000Z");
    const old = await row(new Date(now.getTime() - 3 * DAY));
    await setKnob("retention.send_counters_days", "5");
    await runSendCounterRetention(env, now);
    expect(await gone(old)).toBe(false);
  });

  it("R3: a dry run deletes nothing and records the count", async () => {
    const now = new Date("2053-03-10T04:41:00.000Z");
    const old = await row(new Date(now.getTime() - 3 * DAY));
    await setKnob("retention.send_counters_dry_run", "1");
    const a = await runSendCounterRetention(env, now);
    expect(await gone(old)).toBe(false);
    expect(a.dry_run).toBe(true);
    expect(a.deleted).toBeGreaterThanOrEqual(1);
    expect(await audit()).toMatchObject({ dry_run: true, deleted: a.deleted });
  });

  it("R4: retention.send_counters_batch=2 deletes 2 of 5 old rows and says has_more", async () => {
    const now = new Date("2054-03-10T04:41:00.000Z");
    // Clear older eras' leftovers (R2, R3), so the batch only meets this test's rows.
    await env.DB.prepare("DELETE FROM send_counters WHERE created_at < ?").bind(new Date(now.getTime() - 30 * DAY).toISOString()).run();
    const keys = [];
    for (let i = 0; i < 5; i++) keys.push(await row(new Date(now.getTime() - (3 + i) * DAY)));
    await setKnob("retention.send_counters_batch", "2");
    const a = await runSendCounterRetention(env, now);
    expect(a).toMatchObject({ deleted: 2, has_more: true });
    let left = 0;
    for (const k of keys) if (!(await gone(k))) left += 1;
    expect(left).toBe(3);
    expect(await audit()).toMatchObject({ deleted: 2, has_more: true });
  });

  it("R5: the audit is written after the delete; days=0 throws, deletes nothing and writes no audit", async () => {
    const now = new Date("2055-03-10T04:41:00.000Z");
    const old = await row(new Date(now.getTime() - 3 * DAY));
    await setKnob("retention.send_counters_days", "0");
    await expect(runSendCounterRetention(env, now)).rejects.toThrow(/out of range/);
    expect(await gone(old)).toBe(false);
    expect(await audit()).toBeNull();
    await setKnob("retention.send_counters_days", "2");
    const a = await runSendCounterRetention(env, now);
    expect(await gone(old)).toBe(true);
    // Earlier eras' rows are older than this cutoff too, so the count is at least this test's row.
    expect(a.deleted).toBeGreaterThanOrEqual(1);
    expect(await audit()).toEqual(a);
    expect(await audit()).toMatchObject({ ran_at: now.toISOString(), dry_run: false });
  });
});

// TCS-82 narrowed the deliveries job to skipped rows: delivered and failed rows
// are each pair's record and are kept. So these fixtures use skipped rows.
describe("R6: the daily cron runs both retention jobs", () => {
  const ctl = () => createScheduledController({ cron: DELIVERY_RETENTION_CRON, scheduledTime: Date.now() });

  it("runCron with 41 4 * * * deletes an old send_counters row and an old skipped delivery", async () => {
    const old = await row(new Date(Date.now() - 3 * DAY));
    const w = uid("wl83");
    const a = uid("adv83");
    await insertDelivery({ watchlist_id: w, advisory_id: a, cursor: 1, status: "skipped", next_at: new Date(Date.now() - 91 * DAY).toISOString(), delivered_at: null });
    const ctx = createExecutionContext();
    await runCron(ctl(), env, ctx, {});
    await waitOnExecutionContext(ctx);
    expect(await gone(old)).toBe(true);
    expect(await deliveryRow(w, a)).toBeNull();
  });

  it("a throw in the deliveries job still runs the send-counter job, and runCron rejects", async () => {
    const old = await row(new Date(Date.now() - 3 * DAY));
    await setKnob("retention.deliveries_days", "0");
    await expect(runCron(ctl(), env, createExecutionContext(), {})).rejects.toThrow(/deliveries_days=0/);
    expect(await gone(old)).toBe(true);
  });

  it("a throw in the send-counter job still runs the deliveries job, and runCron rejects", async () => {
    const w = uid("wl83b");
    const a = uid("adv83b");
    await insertDelivery({ watchlist_id: w, advisory_id: a, cursor: 1, status: "skipped", next_at: new Date(Date.now() - 91 * DAY).toISOString(), delivered_at: null });
    await setKnob("retention.send_counters_days", "0");
    await expect(runCron(ctl(), env, createExecutionContext(), {})).rejects.toThrow(/send_counters_days=0/);
    expect(await deliveryRow(w, a)).toBeNull();
  });
});
