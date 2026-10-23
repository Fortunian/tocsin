import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_AUDIT_KEY, runKeyRetention } from "../../src/cron/retention";
import { RETENTION_CRON, runCron } from "../../src/cron/run";
import worker from "../../src/index";

const DAY = 86_400_000;

// Each test works in its own era (a fixed `now`), seeds its own keys with
// unique ids, and deletes what is left of them at the end, so a retention run
// in one test never meets another test's rows.
let seq = 0;
const mine: string[] = [];

async function key(lastUsed: Date, created: Date = lastUsed, lists = 0): Promise<string> {
  seq += 1;
  const id = `key_ret_${seq}_${crypto.randomUUID()}`;
  mine.push(id);
  await env.DB.prepare(
    "INSERT INTO api_keys (id, key_hash, plan, email, created_at, last_used_at) VALUES (?, ?, 'free', ?, ?, ?)",
  )
    .bind(id, `hash-fixture-${id}`, `${id}@example.test`, created.toISOString(), lastUsed.toISOString())
    .run();
  for (let i = 0; i < lists; i++) {
    await env.DB.prepare(
      "INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at) VALUES (?, ?, 'r', '{}', 0, 'poll', ?)",
    )
      .bind(`wl_${id}_${i}`, id, created.toISOString())
      .run();
  }
  return id;
}

async function exists(id: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM api_keys WHERE id = ?").bind(id).first()) !== null;
}
async function listCount(id: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE key_id = ?").bind(id).first<{ n: number }>())!.n;
}
async function setKnob(k: string, v: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v).run();
}
async function audit(): Promise<Record<string, unknown>> {
  const raw = await env.CURSORS.get(RETENTION_AUDIT_KEY);
  if (raw === null) throw new Error("no audit record");
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("retention.api_key_unused_days", "365");
  await setKnob("retention.api_keys_batch", "5000");
  await setKnob("retention.api_keys_dry_run", "0");
  for (const id of mine.splice(0)) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM watchlists WHERE key_id = ?").bind(id),
      env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id),
    ]);
  }
});

describe("runKeyRetention", () => {
  it("deletes a key unused for 366 days and its lists; keeps 364 days, at-cutoff, and old-but-recently-used keys and their lists", async () => {
    const now = new Date("2031-06-15T03:17:00.000Z");
    const old = await key(new Date(now.getTime() - 366 * DAY), new Date(now.getTime() - 500 * DAY), 2);
    const recent = await key(new Date(now.getTime() - 364 * DAY), new Date(now.getTime() - 364 * DAY), 1);
    const atCutoff = await key(new Date(now.getTime() - 365 * DAY), new Date(now.getTime() - 400 * DAY));
    const oldButUsed = await key(new Date(now.getTime() - 1 * DAY), new Date(now.getTime() - 400 * DAY), 1);

    await runKeyRetention(env, now);

    expect(await exists(old)).toBe(false);
    expect(await listCount(old)).toBe(0);
    expect(await exists(recent)).toBe(true);
    expect(await listCount(recent)).toBe(1);
    expect(await exists(atCutoff)).toBe(true);
    expect(await exists(oldButUsed)).toBe(true);
    expect(await listCount(oldButUsed)).toBe(1);

    const a = await audit();
    expect(a.dry_run).toBe(false);
    expect(a.keys).toBe(1);
    expect(a.watchlists).toBe(2);
    expect(a.has_more).toBe(false);
    expect(a.cutoff).toBe(new Date(now.getTime() - 365 * DAY).toISOString());
  });

  it("deletes nothing when retention.api_keys_dry_run = 1, and the audit shows the matched count", async () => {
    await setKnob("retention.api_keys_dry_run", "1");
    const now = new Date("2032-06-15T03:17:00.000Z");
    const a1 = await key(new Date(now.getTime() - 400 * DAY), undefined, 3);
    const a2 = await key(new Date(now.getTime() - 380 * DAY));

    await runKeyRetention(env, now);

    expect(await exists(a1)).toBe(true);
    expect(await listCount(a1)).toBe(3);
    expect(await exists(a2)).toBe(true);
    const a = await audit();
    expect(a.dry_run).toBe(true);
    expect(a.keys).toBe(2);
    expect(a.watchlists).toBe(3);
  });

  it("deletes at most retention.api_keys_batch keys per run, oldest first, and the audit says has_more", async () => {
    await setKnob("retention.api_keys_batch", "1");
    const now = new Date("2033-06-15T03:17:00.000Z");
    const oldest = await key(new Date(now.getTime() - 900 * DAY), undefined, 1);
    const older = await key(new Date(now.getTime() - 800 * DAY), undefined, 1);

    await runKeyRetention(env, now);

    expect(await exists(oldest)).toBe(false);
    expect(await listCount(oldest)).toBe(0);
    expect(await exists(older)).toBe(true);
    expect(await listCount(older)).toBe(1);
    const a = await audit();
    expect(a.keys).toBe(1);
    expect(a.watchlists).toBe(1);
    expect(a.has_more).toBe(true);
  });

  it("uses the retention.api_key_unused_days row, and refuses a value below 1 without deleting", async () => {
    const now = new Date("2034-06-15T03:17:00.000Z");
    await setKnob("retention.api_key_unused_days", "30");
    const k = await key(new Date(now.getTime() - 31 * DAY));
    await runKeyRetention(env, now);
    expect(await exists(k)).toBe(false);

    await setKnob("retention.api_key_unused_days", "0");
    const k2 = await key(new Date(now.getTime() - 1 * DAY));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runKeyRetention(env, now)).rejects.toThrow(/retention/);
    expect(await exists(k2)).toBe(true);
  });
});

describe("runCron dispatch", () => {
  it(`worker.scheduled with "${RETENTION_CRON}" runs key retention and no ingester`, async () => {
    expect(RETENTION_CRON).toBe("17 3 1 * *");
    const before = await env.DB.prepare("SELECT id, last_run_at FROM sources ORDER BY id").all();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
    const stale = await key(new Date(Date.now() - 400 * DAY), undefined, 1);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: RETENTION_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await exists(stale)).toBe(false);
    expect(await listCount(stale)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await env.DB.prepare("SELECT id, last_run_at FROM sources ORDER BY id").all();
    expect(after.results).toEqual(before.results);
  });

  it("the */10 ingest cron deletes no key", async () => {
    const stale = await key(new Date(Date.now() - 400 * DAY), undefined, 1);
    const ctx = createExecutionContext();
    await runCron(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx, {});
    await waitOnExecutionContext(ctx);
    expect(await exists(stale)).toBe(true);
    expect(await listCount(stale)).toBe(1);
  });
});
