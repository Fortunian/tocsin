import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_RETENTION_AUDIT_KEY, runDeliveryRetention } from "../../src/cron/deliveries-retention";
import { DELIVERY_RETENTION_CRON, RETENTION_CRON, runCron } from "../../src/cron/run";
import worker from "../../src/index";
import { deliveryRow, insertDelivery, setKnob, uid } from "../queue/helpers.tcs-11";

const DAY = 86_400_000;

// Each test works in its own era (a fixed `now` far apart), so a run in one
// test deletes none of the rows another test still asserts on.
async function row(status: string, at: Date): Promise<{ w: string; a: string }> {
  const w = uid("wlret");
  const a = uid("advret");
  const iso = at.toISOString();
  await insertDelivery({ watchlist_id: w, advisory_id: a, cursor: 1, status, next_at: iso, delivered_at: status === "delivered" ? iso : null });
  return { w, a };
}
const gone = async (r: { w: string; a: string }) => (await deliveryRow(r.w, r.a)) === null;

async function audit(): Promise<Record<string, unknown>> {
  const raw = await env.CURSORS.get(DELIVERY_RETENTION_AUDIT_KEY);
  if (raw === null) throw new Error("no audit record");
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("retention.deliveries_days", "90");
  await setKnob("retention.deliveries_batch", "5000");
  await setKnob("retention.deliveries_dry_run", "0");
});

describe("runDeliveryRetention", () => {
  it("deletes delivered and failed rows older than 90 days; keeps 89-day rows and pending rows", async () => {
    const now = new Date("2032-06-15T04:41:00.000Z");
    const del91 = await row("delivered", new Date(now.getTime() - 91 * DAY));
    const del89 = await row("delivered", new Date(now.getTime() - 89 * DAY));
    const fail91 = await row("failed", new Date(now.getTime() - 91 * DAY));
    const skip91 = await row("skipped", new Date(now.getTime() - 91 * DAY));
    const pend91 = await row("pending", new Date(now.getTime() - 91 * DAY));

    const a = await runDeliveryRetention(env, now);

    expect(await gone(del91)).toBe(true);
    expect(await gone(fail91)).toBe(true);
    expect(await gone(skip91)).toBe(true);
    expect(await gone(del89)).toBe(false);
    expect(await gone(pend91)).toBe(false);
    expect(a).toMatchObject({ dry_run: false, delivered: 1, failed: 1, skipped: 1, has_more: false });
    expect(await audit()).toMatchObject({ ran_at: now.toISOString(), dry_run: false, delivered: 1, failed: 1, skipped: 1 });
  });

  it("a dry run deletes nothing and records the counts", async () => {
    const now = new Date("2033-06-15T04:41:00.000Z");
    const del91 = await row("delivered", new Date(now.getTime() - 91 * DAY));
    await setKnob("retention.deliveries_dry_run", "1");

    const a = await runDeliveryRetention(env, now);

    expect(await gone(del91)).toBe(false);
    expect(a).toMatchObject({ dry_run: true });
    expect(a.delivered).toBeGreaterThanOrEqual(1);
    expect(await audit()).toMatchObject({ dry_run: true, delivered: a.delivered });
  });

  it("reads the window from retention.deliveries_days", async () => {
    const now = new Date("2034-06-15T04:41:00.000Z");
    const del11 = await row("delivered", new Date(now.getTime() - 11 * DAY));
    await setKnob("retention.deliveries_days", "10");
    await runDeliveryRetention(env, now);
    expect(await gone(del11)).toBe(true);
  });

  it("an out-of-range knob throws and deletes nothing", async () => {
    const now = new Date("2035-06-15T04:41:00.000Z");
    const del91 = await row("delivered", new Date(now.getTime() - 91 * DAY));
    await setKnob("retention.deliveries_days", "0");
    await expect(runDeliveryRetention(env, now)).rejects.toThrow(/out of range/);
    expect(await gone(del91)).toBe(false);
  });
});

describe("the daily cron", () => {
  it("DELIVERY_RETENTION_CRON is a daily trigger, separate from the monthly key retention", () => {
    expect(DELIVERY_RETENTION_CRON).toBe("41 4 * * *");
    expect(DELIVERY_RETENTION_CRON).not.toBe(RETENTION_CRON);
  });

  it("worker.scheduled with DELIVERY_RETENTION_CRON runs the deliveries retention and no ingest", async () => {
    const del91 = await row("delivered", new Date(Date.now() - 91 * DAY));
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM sources WHERE last_run_at IS NOT NULL").first<{ n: number }>();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: DELIVERY_RETENTION_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await gone(del91)).toBe(true);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM sources WHERE last_run_at IS NOT NULL").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("runCron routes it too", async () => {
    const del91 = await row("delivered", new Date(Date.now() - 91 * DAY));
    const ctx = createExecutionContext();
    await runCron(createScheduledController({ cron: DELIVERY_RETENTION_CRON, scheduledTime: Date.now() }), env, ctx, {});
    await waitOnExecutionContext(ctx);
    expect(await gone(del91)).toBe(true);
  });
});
