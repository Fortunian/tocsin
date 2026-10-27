import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_RETENTION_CRON, runCron } from "../../src/cron/run";
import { runSocialRetention, SOCIAL_RETENTION_AUDIT_KEY } from "../../src/cron/social-retention";
import { setKnob, uid } from "./helpers.tcs-106";

// TCS-106 retention: terminal social_posts rows older than
// social.retention_days are archived to social_posts_archive, never silently
// deleted. Each test works in its own era (a fixed `now` far apart).

const DAY = 86_400_000;

async function row(status: string, at: Date): Promise<string> {
  const id = `tcs_${uid("ret")}`;
  await env.DB.prepare(
    "INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, first_attempt_at, posted_id, posted_at, text, created_at, updated_at) VALUES (?1, 'x', ?2, 1, ?3, ?3, ?4, ?5, 'retention fixture', ?3, ?3)",
  )
    .bind(id, status, at.toISOString(), status === "ok" ? `fake-${id}` : null, status === "ok" ? at.toISOString() : null)
    .run();
  return id;
}
async function live(id: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM social_posts WHERE advisory_id = ?").bind(id).first()) !== null;
}
async function archived(id: string): Promise<{ status: string; posted_id: string | null; archived_at: string } | null> {
  return env.DB.prepare("SELECT status, posted_id, archived_at FROM social_posts_archive WHERE advisory_id = ?").bind(id).first();
}
async function archiveCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM social_posts_archive").first<{ n: number }>())!.n;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM social_posts").run();
  await env.CURSORS.delete(SOCIAL_RETENTION_AUDIT_KEY);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("social.retention_days", "365");
  await setKnob("social.retention_batch", "5000");
  await setKnob("social.retention_dry_run", "0");
});

describe("runSocialRetention", () => {
  it("R1: an old ok row moves to the archive; an old pending row and a young ok row stay", async () => {
    const now = new Date("2071-03-10T04:41:00.000Z");
    const oldOk = await row("ok", new Date(now.getTime() - 400 * DAY));
    const oldPending = await row("pending", new Date(now.getTime() - 400 * DAY));
    const young = await row("ok", new Date(now.getTime() - 30 * DAY));
    const audit = await runSocialRetention(env, now);
    expect(await live(oldOk)).toBe(false);
    expect(await archived(oldOk)).toMatchObject({ status: "ok", posted_id: `fake-${oldOk}`, archived_at: now.toISOString() });
    expect(await live(oldPending)).toBe(true);
    expect(await live(young)).toBe(true);
    expect(await archived(young)).toBeNull();
    expect(audit).toMatchObject({ dry_run: false, archived: 1, has_more: false, cutoff: new Date(now.getTime() - 365 * DAY).toISOString() });
    expect(JSON.parse((await env.CURSORS.get(SOCIAL_RETENTION_AUDIT_KEY)) as string)).toEqual(audit);
  });

  it("R2: a dry run moves nothing and audits the count", async () => {
    const now = new Date("2072-03-10T04:41:00.000Z");
    await setKnob("social.retention_dry_run", "1");
    const a = await row("failed", new Date(now.getTime() - 400 * DAY));
    const before = await archiveCount();
    const audit = await runSocialRetention(env, now);
    expect(audit).toMatchObject({ dry_run: true, archived: 1 });
    expect(await live(a)).toBe(true);
    expect(await archiveCount()).toBe(before);
  });

  it("R3: a re-run is idempotent: the archive count does not change", async () => {
    const now = new Date("2073-03-10T04:41:00.000Z");
    await row("empty", new Date(now.getTime() - 400 * DAY));
    await runSocialRetention(env, now);
    const once = await archiveCount();
    const again = await runSocialRetention(env, now);
    expect(again.archived).toBe(0);
    expect(await archiveCount()).toBe(once);
  });

  it("R4: the batch knob caps one run and reports has_more", async () => {
    const now = new Date("2074-03-10T04:41:00.000Z");
    await setKnob("social.retention_batch", "2");
    const ids = [await row("ok", new Date(now.getTime() - 500 * DAY)), await row("ok", new Date(now.getTime() - 450 * DAY)), await row("ok", new Date(now.getTime() - 400 * DAY))];
    const audit = await runSocialRetention(env, now);
    expect(audit).toMatchObject({ archived: 2, has_more: true });
    expect(await Promise.all(ids.map(live))).toEqual([false, false, true]);
  });

  it("R5: the daily cron runs it", async () => {
    const old = await row("ok", new Date(Date.now() - 400 * DAY));
    const ctx = createExecutionContext();
    await runCron(createScheduledController({ cron: DELIVERY_RETENTION_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await live(old)).toBe(false);
    expect(await archived(old)).not.toBeNull();
  });
});
