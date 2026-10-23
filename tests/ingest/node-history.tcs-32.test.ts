import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NODE_DEFAULTS, nodeRuntime, parseNodeFeed } from "../../src/ingest/node-runtime";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import { defaultRegistry, runIngesters } from "../../src/ingest/registry";
import migration0015 from "../../migrations/0015_node_history.sql?raw";
import distIndex from "../fixtures/node-eol/index.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { clearNodeLedger, markNodePostsRead, nodePostRow } from "./node-ledger-seed.tcs-69";
import { createRuntimeFake } from "./runtime-fake.tcs-6";

// Node feed history (TCS-32). The recorded feed (77 items, 48 of them
// "Security Release" posts back to 2015-12-01) through the production
// registry, with the node-runtime row as migration 0015 leaves it
// (max_posts 20, backfill_days 4000). Each post link answers a SYNTHETIC
// post: one CVE heading on line 4.x, fixed in v4.9.1 (a version of the
// recorded dist index, tests/fixtures/node-eol/index.json).
const FEED = NODE_DEFAULTS.feed_url;
const INDEX = NODE_DEFAULTS.dist_index_url;
const NOW = new Date("2026-10-23T01:00:00Z");
const POSTS = parseNodeFeed(feedXml)
  .filter((p) => p.title.toLowerCase().includes("security release"))
  .sort((a, b) => (a.published < b.published ? -1 : 1));

function post(i: number, fixed = "4.9.1"): string {
  return `<main><h2>Fixture issue ${i} (CVE-2015-${String(90000 + i)}) - (high)</h2>
<p>This vulnerability affects Node.js 4.x</p>
<h2>Downloads and release details</h2><ul><li>Node.js v${fixed}</li></ul></main>`;
}

function routes(over: Record<string, string> = {}): Record<string, string> {
  const r: Record<string, string> = { [FEED]: feedXml, [INDEX]: distIndex };
  POSTS.forEach((p, i) => (r[p.link] = post(i)));
  return { ...r, ...over };
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("real network call in a node-history test");
  }) as never);
});
afterAll(() => fetchSpy.mockRestore());

const coverage = async () => (await env.DB.prepare("SELECT coverage_since FROM sources WHERE id = 'node-runtime'").first<{ coverage_since: string | null }>())!.coverage_since;
const nodeRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'node-runtime'").first<{ n: number }>())!.n;

async function cron(r: Record<string, string>): Promise<{ status: string; posts: number }> {
  const fake = createRuntimeFake(r);
  fetchSpy.mockImplementation(fake.fetch as never);
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = 'node-runtime' THEN 1 ELSE 0 END").run();
  try {
    const [o] = await runIngesters(env, defaultRegistry, () => NOW);
    return { status: o.status, posts: fake.urls().filter((u) => u.includes("/blog/vulnerability/")).length };
  } finally {
    await env.DB.prepare("UPDATE sources SET enabled = 1").run();
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL, last_error = NULL WHERE id = 'node-runtime'").run();
  await env.CURSORS.delete(NODE_DIST_KEY);
  // TCS-69: an empty post ledger, where it was no KV cursor and no parser key.
  await clearNodeLedger();
});

describe("node-runtime history", () => {
  it("the fixture feed has 77 items and 48 Security Release posts; the oldest is inside 4000 days", () => {
    expect(parseNodeFeed(feedXml)).toHaveLength(77);
    expect(POSTS).toHaveLength(48);
    expect(NOW.getTime() - Date.parse(POSTS[0].published)).toBeLessThan(4000 * 86_400_000);
  });

  it("migration 0015 row: 3 runs of 20 read all 48 posts; coverage_since is set after run 3 and not before", async () => {
    const cfg = await env.DB.prepare("SELECT json_extract(config_json, '$.max_posts') AS m, json_extract(config_json, '$.backfill_days') AS d FROM sources WHERE id = 'node-runtime'").first<{ m: number; d: number }>();
    expect(cfg).toEqual({ m: 20, d: 4000 });

    const r1 = await cron(routes());
    expect(r1).toEqual({ status: "ok", posts: 20 });
    expect(await coverage()).toBeNull();
    const r2 = await cron(routes());
    // TCS-69: the walk goes on from the ledger: posts 20 to 39 open run 2.
    expect(r2).toEqual({ status: "ok", posts: 20 });
    expect(await coverage()).toBeNull();
    const r3 = await cron(routes());
    expect(r3).toEqual({ status: "ok", posts: 8 });
    expect(await nodeRows()).toBe(48);
    expect(await coverage()).toBe(POSTS[0].published);

    // The next run reads only the newest post again and keeps coverage_since.
    const r4 = await cron(routes());
    expect(r4.posts).toBe(1);
    expect(await coverage()).toBe(POSTS[0].published);
  });

  it("a box on the TCS-30 parser revision (\"2\") with every post read reads the history window again", async () => {
    // TCS-69: ok ledger rows read by parser revision 2, where it was a cursor at the newest post and parser key "2".
    await markNodePostsRead("2099-01-01T00:00:00Z", "2");
    const r = await cron(routes());
    expect(r).toEqual({ status: "ok", posts: 20 });
    expect(await nodePostRow(POSTS[19].link)).toMatchObject({ state: "ok", parser_rev: "3" });
    expect(await nodePostRow(POSTS[20].link)).toMatchObject({ state: "ok", parser_rev: "2" });
    expect(await nodeRows()).toBe(20);
  });

  it("a run cut by max_posts never sets coverage_since, even when it reaches far back", async () => {
    await nodeRuntime.run({ env, source: { id: "node-runtime", kind: "node-runtime", config: { max_posts: 47, backfill_days: 4000 }, coverage_since: null }, now: () => NOW, fetch: createRuntimeFake(routes()).fetch });
    expect(await coverage()).toBeNull();
    await nodeRuntime.run({ env, source: { id: "node-runtime", kind: "node-runtime", config: { max_posts: 47, backfill_days: 4000 }, coverage_since: null }, now: () => NOW, fetch: createRuntimeFake(routes()).fetch });
    expect(await coverage()).toBe(POSTS[0].published);
  });

  it("a window that does not reach the oldest post never sets coverage_since", async () => {
    await nodeRuntime.run({ env, source: { id: "node-runtime", kind: "node-runtime", config: { max_posts: 100, backfill_days: 1000 }, coverage_since: null }, now: () => NOW, fetch: createRuntimeFake(routes()).fetch });
    expect(await nodeRows()).toBeGreaterThan(0);
    expect(await coverage()).toBeNull();
  });

  it("an incomplete post older than retry_incomplete_days is reported and passed, so history never stalls", async () => {
    const old = POSTS[1];
    const r = await nodeRuntime.run({
      env,
      source: { id: "node-runtime", kind: "node-runtime", config: { max_posts: 100, backfill_days: 4000 }, coverage_since: null },
      now: () => NOW,
      fetch: createRuntimeFake(routes({ [old.link]: post(1, "4.99.99") })).fetch,
    });
    // TCS-69 round 2: the note of one post is a warning, never a run error.
    expect(r.errors).toEqual([]);
    expect((r.warnings ?? []).join("\n")).toMatch(/post incomplete, older than 365 days, not read again/);
    expect(await nodeRows()).toBe(47);
    expect(await nodePostRow(old.link)).toMatchObject({ state: "failed", next_check_at: null });
    expect(await nodePostRow(POSTS[47].link)).toMatchObject({ state: "ok" });
  });

  it("an old post that answers 404 is reported and passed; a recent one still fails the run", async () => {
    const fake = createRuntimeFake({ ...routes(), [POSTS[2].link]: { status: 404 } });
    const ctx = { env, source: { id: "node-runtime", kind: "node-runtime", config: { max_posts: 100, backfill_days: 4000 }, coverage_since: null }, now: () => NOW, fetch: fake.fetch };
    const r = await nodeRuntime.run(ctx);
    expect(r.errors).toEqual([]);
    expect((r.warnings ?? []).join("\n")).toContain("HTTP 404");
    expect(await nodeRows()).toBe(47);
    expect(await nodePostRow(POSTS[2].link)).toMatchObject({ state: "failed", next_check_at: null });
    expect(await nodePostRow(POSTS[47].link)).toMatchObject({ state: "ok" });

    // TCS-69: the newest post has no row (where the cursor was at post 46): a recent 404 throws and writes no row.
    await env.DB.prepare("DELETE FROM node_runtime_posts WHERE url = ?").bind(POSTS[47].link).run();
    const recent = createRuntimeFake({ ...routes(), [POSTS[47].link]: { status: 404 } });
    await expect(nodeRuntime.run({ ...ctx, fetch: recent.fetch })).rejects.toThrow(/HTTP 404/);
    expect(await nodePostRow(POSTS[47].link)).toBeNull();
  });

  it("migration 0015 never overwrites an edited max_posts", async () => {
    const update = migration0015.split(";").find((s) => s.includes("UPDATE sources"))!;
    try {
      await env.DB.prepare("UPDATE sources SET config_json = '{\"max_posts\":7}' WHERE id = 'node-runtime'").run();
      await env.DB.prepare(update).run();
      expect((await env.DB.prepare("SELECT config_json FROM sources WHERE id = 'node-runtime'").first<{ config_json: string }>())!.config_json).toBe('{"max_posts":7}');
      await env.DB.prepare("UPDATE sources SET config_json = '{}' WHERE id = 'node-runtime'").run();
      await env.DB.prepare(update).run();
      const c = JSON.parse((await env.DB.prepare("SELECT config_json FROM sources WHERE id = 'node-runtime'").first<{ config_json: string }>())!.config_json);
      expect(c).toEqual({ max_posts: 20, backfill_days: 4000, retry_incomplete_days: 365 });
    } finally {
      await env.DB.prepare("UPDATE sources SET config_json = '{\"max_posts\":20,\"backfill_days\":4000,\"retry_incomplete_days\":365}' WHERE id = 'node-runtime'").run();
    }
  });
});
