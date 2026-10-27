import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSocialLane, SOCIAL_SQL } from "../../src/cron/social";
import { SOCIAL_RETENTION_SQL } from "../../src/cron/social-retention";
import { SOCIAL_STATUS_SQL } from "../../src/social/status";
import { getXClient, type XClientFactory } from "../../src/social/x";
import { callsFor, fakeMode, postsFor, resetSocial, seedAdvisory, uid } from "./helpers.tcs-106";

// TCS-106 dedup before spend: the row is written and claimed before the X
// call, a second tick never calls X, and every terminal state stays terminal.

const tick = () => runSocialLane(env, new Date());

afterEach(() => vi.restoreAllMocks());

describe("dedup and terminal states", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await resetSocial();
  });

  it("D1: two ticks for one advisory make exactly 1 fake call", async () => {
    const a = await seedAdvisory();
    await tick();
    await tick();
    expect(await callsFor(a.id)).toHaveLength(1);
    expect((await postsFor(a.id))[0]).toMatchObject({ status: "ok", attempts: 1 });
    expect((await postsFor(a.id))[0].posted_id).toMatch(/^fake-/);
  });

  it("D2: the row exists as sending with attempts 1 at the moment X is called", async () => {
    const a = await seedAdvisory();
    const seen: unknown[] = [];
    const wrapped: XClientFactory = (e, timeoutMs) => {
      const inner = getXClient(e, timeoutMs)!;
      return {
        async post(text) {
          seen.push(await env.DB.prepare("SELECT status, attempts FROM social_posts WHERE advisory_id = ?").bind(a.id).first());
          return inner.post(text);
        },
        remove: (id) => inner.remove(id),
      };
    };
    await runSocialLane(env, new Date(), wrapped);
    expect(seen).toEqual([{ status: "sending", attempts: 1 }]);
    expect((await postsFor(a.id))[0].status).toBe("ok");
  });

  it("D3: a 2xx with no id is empty and terminal; the next tick makes 0 calls", async () => {
    await fakeMode("empty");
    const a = await seedAdvisory();
    await tick();
    expect((await postsFor(a.id))[0]).toMatchObject({ status: "empty", attempts: 1, posted_id: null });
    await fakeMode("ok");
    await tick();
    expect(await callsFor(a.id)).toHaveLength(1);
    expect((await postsFor(a.id))[0].status).toBe("empty");
  });

  for (const mode of ["500", "429"] as const) {
    it(`D4 ${mode}: three ticks end failed at attempts 3; a 4th tick makes 0 calls`, async () => {
      await fakeMode(mode);
      const a = await seedAdvisory();
      await tick();
      expect((await postsFor(a.id))[0]).toMatchObject({ status: "pending", attempts: 1 });
      await tick();
      expect((await postsFor(a.id))[0]).toMatchObject({ status: "pending", attempts: 2 });
      await tick();
      expect((await postsFor(a.id))[0]).toMatchObject({ status: "failed", attempts: 3 });
      await tick();
      expect(await callsFor(a.id)).toHaveLength(3);
      expect((await postsFor(a.id))[0].error).toMatch(new RegExp(`^x answered ${mode}`));
    });
  }

  it("D5: a 403 is failed after 1 attempt; a network error is failed after 1 attempt", async () => {
    await fakeMode("403");
    const a = await seedAdvisory();
    await tick();
    await tick();
    expect((await postsFor(a.id))[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(await callsFor(a.id)).toHaveLength(1);

    await fakeMode("network");
    const b = await seedAdvisory();
    await tick();
    await tick();
    expect((await postsFor(b.id))[0]).toMatchObject({ status: "failed", attempts: 1, error: "network" });
    expect(await callsFor(b.id)).toHaveLength(1);
  });

  it("D6: a sending row past its lease ends failed/unknown_outcome with 0 calls", async () => {
    const id = `tcs_${uid("lease")}`;
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, first_attempt_at, text, created_at, updated_at) VALUES (?1, 'x', 'sending', 1, ?2, ?2, ?3, ?2, ?2)",
    )
      .bind(id, past, `lease fixture ${id}`)
      .run();
    await tick();
    expect((await postsFor(id))[0]).toMatchObject({ status: "failed", error: "unknown_outcome", attempts: 1 });
    expect(await callsFor(id)).toHaveLength(0);
  });

  it("D7: the stored error is at most 200 chars when X answers a 1,000-char body", async () => {
    await fakeMode("403", "e".repeat(1000));
    const a = await seedAdvisory();
    await tick();
    const [row] = await postsFor(a.id);
    expect(row.status).toBe("failed");
    expect(row.error!.startsWith("x answered 403: eee")).toBe(true);
    expect(row.error!.length).toBe(200);
  });
});

describe("query plans on 1,000 social_posts rows", () => {
  async function plan(sql: string, ...params: unknown[]): Promise<string> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    return results.map((r) => r.detail).join("\n");
  }

  beforeAll(async () => {
    await env.DB.prepare("DELETE FROM social_posts").run();
    const stmt = env.DB.prepare(
      "INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, first_attempt_at, posted_at, text, created_at, updated_at) VALUES (?1, 'x', ?2, 1, ?3, ?3, ?3, 'plan fixture', ?3, ?3)",
    );
    const statuses = ["ok", "ok", "ok", "failed", "empty", "pending", "sending"];
    for (let i = 0; i < 1000; i += 100) {
      await env.DB.batch(
        Array.from({ length: 100 }, (_, j) => {
          const n = i + j;
          return stmt.bind(`tcs_plan${String(n).padStart(22, "0")}`, statuses[n % statuses.length], new Date(Date.UTC(2025, 0, 1) + n * 3_600_000).toISOString());
        }),
      );
    }
    await env.DB.prepare("ANALYZE").run();
  });

  const NOW = "2026-10-27T00:00:00.000Z";
  const noScan = (p: string) => expect(p).not.toMatch(/SCAN social_posts(?! USING)/);

  it("P1: the dedup lookup uses ux_social_posts_advisory_channel", async () => {
    const p = await plan(SOCIAL_SQL.lookup, "tcs_plan0000000000000000000042", "x");
    expect(p).toContain("ux_social_posts_advisory_channel");
    noScan(p);
  });
  it("P2: the claim uses idx_social_posts_due", async () => {
    const p = await plan(SOCIAL_SQL.claim, "x", NOW, NOW, 10);
    expect(p).toContain("idx_social_posts_due");
    noScan(p);
  });
  it("P3: the stale-lease sweep uses idx_social_posts_due", async () => {
    const p = await plan(SOCIAL_SQL.sweep, NOW, NOW);
    expect(p).toContain("idx_social_posts_due");
    noScan(p);
  });
  it("P4: the daily cap count uses idx_social_posts_attempted", async () => {
    const p = await plan(SOCIAL_SQL.attemptedSince, "x", NOW);
    expect(p).toContain("idx_social_posts_attempted");
    noScan(p);
  });
  it("P5: posted_24h uses idx_social_posts_posted", async () => {
    const p = await plan(SOCIAL_STATUS_SQL.posted24h, NOW);
    expect(p).toContain("idx_social_posts_posted");
    noScan(p);
  });
  it("P6: the retention select uses idx_social_posts_retention", async () => {
    const p = await plan(SOCIAL_RETENTION_SQL.dryRun, NOW);
    expect(p).toContain("idx_social_posts_retention");
    noScan(p);
    const a = await plan(SOCIAL_RETENTION_SQL.archive, NOW, 100, NOW);
    expect(a).toContain("idx_social_posts_retention");
    noScan(a);
  });
  it("P7: the candidate scan uses idx_advisories_ecosystem_cursor", async () => {
    const p = await plan(SOCIAL_SQL.candidates, "node", 0, 200);
    expect(p).toContain("idx_advisories_ecosystem_cursor");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });
});
