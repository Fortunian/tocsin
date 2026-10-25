import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_REPORT_RETENTION_AUDIT_KEY, runActionReportRetention } from "../../src/cron/action-reports-retention";
import { DELIVERY_RETENTION_CRON, runCron } from "../../src/cron/run";
import { setKnob, uid } from "../queue/helpers.tcs-11";
import { AUDIENCE, claimsFor, makeKey, seedJwks, sign } from "../routes/oidc-helpers.tcs-101";

// TCS-101: the daily job deletes action_reports rows older than
// badge.retention_days and always keeps the latest row per owner+repo+ref.
// Each test works in its own era (a fixed `now` far apart) and clears older
// eras first, so one run meets only its own test's rows.

const DAY = 86_400_000;

async function row(owner: string, latest: boolean, at: Date, ref = "refs/heads/main"): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO action_reports (owner, repo, ref, is_default, is_latest, affected, min_severity, run_id, reported_at) VALUES (?, 'widget', ?, 1, ?, 0, 'low', ?, ?) RETURNING id",
  )
    .bind(owner, ref, latest ? 1 : 0, uid("run"), at.toISOString())
    .first<{ id: number }>();
  return (r as { id: number }).id;
}
async function gone(id: number): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM action_reports WHERE id = ?").bind(id).first()) === null;
}
async function clearAll(): Promise<void> {
  await env.DB.prepare("DELETE FROM action_reports").run();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.CURSORS.delete(ACTION_REPORT_RETENTION_AUDIT_KEY);
  await clearAll();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("badge.retention_days", "90");
  await setKnob("badge.retention_batch", "5000");
  await setKnob("badge.retention_dry_run", "0");
});

describe("runActionReportRetention", () => {
  it("R1: deletes an old non-latest row; keeps the old latest row and a young non-latest row", async () => {
    const now = new Date("2061-03-10T04:41:00.000Z");
    const a = await row("acme-r1", true, new Date(now.getTime() - 200 * DAY));
    const b = await row("acme-r1", false, new Date(now.getTime() - 100 * DAY));
    const c = await row("acme-r1", false, new Date(now.getTime() - 10 * DAY));
    const audit = await runActionReportRetention(env, now);
    expect([await gone(a), await gone(b), await gone(c)]).toEqual([false, true, false]);
    expect(audit).toMatchObject({ dry_run: false, deleted: 1, has_more: false, cutoff: new Date(now.getTime() - 90 * DAY).toISOString() });
    expect(JSON.parse((await env.CURSORS.get(ACTION_REPORT_RETENTION_AUDIT_KEY)) as string)).toEqual(audit);
  });

  it("R2: a dry run reports deleted=1 and deletes nothing", async () => {
    const now = new Date("2062-03-10T04:41:00.000Z");
    await row("acme-r2", true, new Date(now.getTime() - 200 * DAY));
    const b = await row("acme-r2", false, new Date(now.getTime() - 100 * DAY));
    await setKnob("badge.retention_dry_run", "1");
    const audit = await runActionReportRetention(env, now);
    expect(audit).toMatchObject({ dry_run: true, deleted: 1 });
    expect(await gone(b)).toBe(false);
  });

  it("R3: batch=1 with 2 old rows deletes 1 and says has_more", async () => {
    const now = new Date("2063-03-10T04:41:00.000Z");
    const b1 = await row("acme-r3", false, new Date(now.getTime() - 100 * DAY));
    const b2 = await row("acme-r3", false, new Date(now.getTime() - 120 * DAY));
    await setKnob("badge.retention_batch", "1");
    const audit = await runActionReportRetention(env, now);
    expect(audit).toMatchObject({ deleted: 1, has_more: true });
    expect([await gone(b1), await gone(b2)].filter(Boolean)).toHaveLength(1);
  });

  it("R4: badge.retention_days=200 keeps a row 100 days old; days=0 throws and deletes nothing", async () => {
    const now = new Date("2064-03-10T04:41:00.000Z");
    const b = await row("acme-r4", false, new Date(now.getTime() - 100 * DAY));
    await setKnob("badge.retention_days", "200");
    await runActionReportRetention(env, now);
    expect(await gone(b)).toBe(false);
    await env.CURSORS.delete(ACTION_REPORT_RETENTION_AUDIT_KEY);
    await setKnob("badge.retention_days", "0");
    await expect(runActionReportRetention(env, now)).rejects.toThrow(/out of range/);
    expect(await gone(b)).toBe(false);
    expect(await env.CURSORS.get(ACTION_REPORT_RETENTION_AUDIT_KEY)).toBeNull();
  });

  it("R5: runCron with 41 4 * * * runs the job", async () => {
    const b = await row("acme-r5", false, new Date(Date.now() - 100 * DAY));
    const ctx = createExecutionContext();
    await runCron(createScheduledController({ cron: DELIVERY_RETENTION_CRON, scheduledTime: Date.now() }), env, ctx, {});
    await waitOnExecutionContext(ctx);
    expect(await gone(b)).toBe(true);
  });

  it("R6: a schedule-style report (default_branch null) after a default report; retention leaves the badge on the newest count", async () => {
    const now = new Date("2065-03-10T04:41:00.000Z");
    const key = await makeKey("kid-fixture-r6");
    await seedJwks([key]);
    const repo = "acme-r6/widget";
    const post = async (runId: string, affected: number, defaultBranch: string | null) =>
      exports.default.fetch(`https://${AUDIENCE}/v1/action/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await sign(key, claimsFor(repo, { run_id: runId }))}`, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.106" },
        body: JSON.stringify({ repository: repo, affected, min_severity: "low", default_branch: defaultBranch }),
      });
    expect((await post("r6-1", 0, "main")).status).toBe(200);
    expect((await post("r6-2", 5, null)).status).toBe(200);
    await env.DB.prepare("UPDATE action_reports SET reported_at = ? WHERE owner = 'acme-r6' AND run_id = 'r6-1'").bind(new Date(now.getTime() - 200 * DAY).toISOString()).run();
    await env.DB.prepare("UPDATE action_reports SET reported_at = ? WHERE owner = 'acme-r6' AND run_id = 'r6-2'").bind(new Date(now.getTime() - DAY).toISOString()).run();
    expect(await runActionReportRetention(env, now)).toMatchObject({ deleted: 1 });
    // One read only: the edge cache key ignores extra query params.
    const svg = await (await exports.default.fetch(`https://${AUDIENCE}/badge/acme-r6/widget.svg`, { headers: { "CF-Connecting-IP": "198.51.100.106" } })).text();
    expect(svg).toContain(">5 affected<");
    expect(svg).not.toContain(">unknown<");
  });
});

