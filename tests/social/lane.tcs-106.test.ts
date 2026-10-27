import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron/run";
import { runSocialLane } from "../../src/cron/social";
import type { Ingester } from "../../src/ingest/types";
import { readFakeXCalls } from "../../src/social/fake";
import { callsFor, postsFor, resetSocial, seedAdvisory, setKnob } from "./helpers.tcs-106";

// TCS-106 lane: disabled and not-configured runs post nothing and move the
// watermark; the daily cap defers, never drops; runCron runs the lane.

async function watermark(): Promise<{ cursor: number; updated_at: string }> {
  return (await env.DB.prepare("SELECT cursor, updated_at FROM match_cursors WHERE lane = 'social:x'").first<{ cursor: number; updated_at: string }>())!;
}
async function maxCursor(): Promise<number> {
  return (await env.DB.prepare("SELECT MAX(cursor) AS m FROM advisories").first<{ m: number }>())!.m;
}
async function socialSource() {
  return env.DB.prepare("SELECT last_run_at, last_error FROM sources WHERE id = 'social-x'").first<{ last_run_at: string | null; last_error: string | null }>();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetSocial();
});
afterEach(() => vi.restoreAllMocks());

describe("runSocialLane", () => {
  it("L1: enabled=0 writes 0 rows, makes 0 calls and moves the watermark; turning it on later posts no backlog", async () => {
    await setKnob("social.x.enabled", "0");
    const a = await seedAdvisory();
    const r = await runSocialLane(env, new Date());
    expect(r.state).toBe("disabled");
    expect(await postsFor(a.id)).toHaveLength(0);
    expect(await readFakeXCalls(env.CURSORS)).toHaveLength(0);
    expect((await watermark()).cursor).toBe(await maxCursor());

    await setKnob("social.x.enabled", "1");
    await runSocialLane(env, new Date());
    expect(await postsFor(a.id)).toHaveLength(0);
    expect(await readFakeXCalls(env.CURSORS)).toHaveLength(0);
  });

  it("L2: no X client (secrets missing) writes 0 rows and records not_configured", async () => {
    const a = await seedAdvisory();
    const r = await runSocialLane(env, new Date(), () => null);
    expect(r.state).toBe("not_configured");
    expect(await postsFor(a.id)).toHaveLength(0);
    expect((await socialSource())?.last_error).toBe("not_configured");
    expect((await watermark()).cursor).toBe(await maxCursor());
  });

  it("L3: daily cap 2 with 3 qualifying advisories posts 2, keeps 1 pending, and posts the 3rd the next UTC day", async () => {
    await setKnob("social.x.daily_cap", "2");
    const now = new Date();
    const seeded = [await seedAdvisory(), await seedAdvisory(), await seedAdvisory()];
    const r = await runSocialLane(env, now);
    expect(r.posted).toBe(2);
    const statuses = await Promise.all(seeded.map(async (s) => (await postsFor(s.id))[0].status));
    expect(statuses.sort()).toEqual(["ok", "ok", "pending"]);

    // A second tick the same day: still over the cap, no call.
    await runSocialLane(env, new Date(now.getTime() + 1000));
    expect(await readFakeXCalls(env.CURSORS)).toHaveLength(2);

    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
    await runSocialLane(env, tomorrow);
    const after = await Promise.all(seeded.map(async (s) => (await postsFor(s.id))[0].status));
    expect(after).toEqual(["ok", "ok", "ok"]);
    expect(await readFakeXCalls(env.CURSORS)).toHaveLength(3);
    expect((await socialSource())?.last_error).toBeNull();
  });

  it("L4: a scan capped by social.x.scan_rows still posts the rows past the cap on the next tick", async () => {
    await setKnob("social.x.scan_rows", "2");
    const seeded = [await seedAdvisory(), await seedAdvisory(), await seedAdvisory()];
    await runSocialLane(env, new Date());
    await runSocialLane(env, new Date());
    for (const s of seeded) expect((await postsFor(s.id)).map((r) => r.status)).toEqual(["ok"]);
    expect(await readFakeXCalls(env.CURSORS)).toHaveLength(3);
  });
});

describe("runCron runs the lane (production entry, D2)", () => {
  it("C1: the */10 cron with a stub registry posts a qualifying advisory after the sweep", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE kind != 'social'").run();
    const a = await seedAdvisory();
    const ctx = createExecutionContext();
    const registry: Record<string, Ingester> = {};
    await runCron(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx, registry);
    await waitOnExecutionContext(ctx);
    expect(await callsFor(a.id)).toHaveLength(1);
    expect((await postsFor(a.id))[0].status).toBe("ok");
    expect((await socialSource())?.last_run_at).not.toBeNull();
  });
});
