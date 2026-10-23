import { exports, env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ledgerSql } from "../../src/ingest/ledgers";
import { NODE_DEFAULTS, NODE_PARSER_REV, nodeRuntime, parseNodeFeed } from "../../src/ingest/node-runtime";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import { POST_SQL } from "../../src/ingest/node-runtime-posts";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import type { IngestContext } from "../../src/ingest/types";
import migration0020 from "../../migrations/0020_node_runtime_posts.sql?raw";
import distIndex from "../fixtures/node-eol/index.json?raw";
import noUpdatesHtml from "../fixtures/node-runtime/2019-09-12-no-updates.html?raw";
import julyHtml from "../fixtures/node-runtime/2026-07-29.html?raw";
import preHtml from "../fixtures/node-runtime/2026-10-14-pre.html?raw";
import octHtml from "../fixtures/node-runtime/2026-10-21.html?raw";
import indexJuly from "../fixtures/node-runtime/index-since-2026-07.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { clearNodeLedger, nodePostRow, nodePostState, seedNodePosts } from "./node-ledger-seed.tcs-69";
import { createRuntimeFake, type FakeAnswer } from "./runtime-fake.tcs-6";

// TCS-69: the node-runtime post ledger (node_runtime_posts). The recorded feed
// (48 Security Release posts). The 2019 "no updates" post, the 2026-10-14
// pre-announcement, and the July and October posts are RECORDED pages
// (tests/fixtures/node-runtime/README*.md). Every other post answers a
// SYNTHETIC post as in node-history.tcs-32 (one CVE heading on 4.x, fixed in
// v4.9.1, a version of tests/fixtures/node-eol/index.json). Posts added to
// the feed in a test (`extra`) are SYNTHETIC (source: assumed, in-test edit).
const FEED = NODE_DEFAULTS.feed_url;
const INDEX = NODE_DEFAULTS.dist_index_url;
const BASE = "https://nodejs.org/en/blog/vulnerability/";
const NO_UPDATES = `${BASE}september-2019-openssl-no-updates`;
const OCT = `${BASE}october-2026-security-releases`;
const JULY = `${BASE}july-2026-security-releases`;
const NOW = Date.parse("2026-10-23T01:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const POSTS = parseNodeFeed(feedXml)
  .filter((p) => p.title.toLowerCase().includes("security release"))
  .sort((a, b) => (a.published < b.published ? -1 : 1));
const pubOf = (url: string) => POSTS.find((p) => p.link === url)!.published;
const iso = (ms: number) => new Date(ms).toISOString();
const NO_HEADINGS = "<main><h2>Summary</h2><p>Nothing to see.</p></main>";

function synthetic(i: number): string {
  return `<main><h2>Fixture issue ${i} (CVE-2015-${String(90000 + i)}) - (high)</h2>
<p>This vulnerability affects Node.js 4.x</p>
<h2>Downloads and release details</h2><ul><li>Node.js v4.9.1</li></ul></main>`;
}

interface Extra {
  link: string;
  published: string;
}

// One more "Security Releases" item in an in-test copy of the recorded feed.
function feedWith(extra: Extra[]): string {
  const items = extra.map((e) => `<item>\n<title><![CDATA[TCS-69 fixture Security Releases]]></title>\n<link>${e.link}</link>\n<pubDate>${new Date(e.published).toUTCString()}</pubDate>\n</item>\n`);
  return feedXml.replace("<item>", items.join("") + "<item>");
}

// The recorded July and October pages, the recorded no-updates page, a
// synthetic page for every other post; the dist index cut at 2026-07-01 plus
// v4.9.1 for the synthetic posts.
function routes(over: Record<string, FakeAnswer> = {}, extra: Extra[] = []): Record<string, FakeAnswer> {
  const versions = [...(JSON.parse(indexJuly) as unknown[]), ...(JSON.parse(distIndex) as unknown[])];
  const r: Record<string, FakeAnswer> = { [FEED]: extra.length > 0 ? feedWith(extra) : feedXml, [INDEX]: JSON.stringify(versions) };
  POSTS.forEach((p, i) => (r[p.link] = synthetic(i)));
  r[NO_UPDATES] = noUpdatesHtml;
  r[JULY] = julyHtml;
  r[OCT] = octHtml;
  return { ...r, ...over };
}

// Every feed post (plus `extra`) has an ok row, except the listed URLs.
async function readAllBut(...except: string[]): Promise<void> {
  await seedNodePosts(POSTS.filter((p) => !except.includes(p.link)).map((p) => ({ url: p.link, published: p.published, state: "ok" })));
}

const CONFIG = { max_posts: 20, backfill_days: 4000 };
function ctxAt(fetchFn: typeof fetch, now: number, config: Record<string, unknown> = CONFIG): IngestContext {
  return { env, source: { id: "node-runtime", kind: "node-runtime", config, coverage_since: null }, now: () => new Date(now), fetch: fetchFn };
}

let fetchSpy: MockInstance;
const noNetwork = (() => {
  throw new Error("real network call in a TCS-69 test");
}) as never;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(noNetwork);
});
afterAll(() => fetchSpy.mockRestore());

async function sourceRow() {
  return env.DB.prepare("SELECT last_run_at, last_ok_at, last_error, last_warning FROM sources WHERE id = 'node-runtime'").first<{
    last_run_at: string | null;
    last_ok_at: string | null;
    last_error: string | null;
    last_warning: string | null;
  }>();
}

// The production path: runIngesters over defaultRegistry with only node-runtime enabled.
async function viaRegistry(fetchFn: typeof fetch, now: number): Promise<SourceOutcome> {
  fetchSpy.mockImplementation(fetchFn as never);
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = 'node-runtime' THEN 1 ELSE 0 END").run();
  try {
    const [o] = await runIngesters(env, defaultRegistry, () => new Date(now));
    return o;
  } finally {
    fetchSpy.mockImplementation(noNetwork);
    await env.DB.prepare("UPDATE sources SET enabled = 1").run();
  }
}

const postReads = (urls: string[]) => urls.filter((u) => u.startsWith(BASE));

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL, last_run_at = NULL, last_ok_at = NULL, last_error = NULL, last_warning = NULL WHERE id = 'node-runtime'").run();
  await env.CURSORS.delete(NODE_DIST_KEY);
  await clearNodeLedger();
});

describe("migration 0020 (migration)", () => {
  it("migration: the table, its index and the 4 knobs exist; an edited knob is kept", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(node_runtime_posts)").all<{ name: string; pk: number }>()).results;
    expect(cols.map((c) => c.name)).toEqual(["url", "published", "state", "attempts", "last_error", "parser_rev", "next_check_at", "updated_at", "title"]);
    expect(cols.find((c) => c.name === "url")?.pk).toBe(1);
    const idx = (await env.DB.prepare("PRAGMA index_info(idx_node_runtime_posts_state_next)").all<{ name: string }>()).results;
    expect(idx.map((c) => c.name)).toEqual(["state", "next_check_at"]);
    await expect(
      env.DB.prepare("INSERT INTO node_runtime_posts (url, published, state, parser_rev, updated_at) VALUES ('x', 'x', 'done', '3', 'x')").run(),
    ).rejects.toThrow(/CHECK/);

    const cfg = async () => JSON.parse((await env.DB.prepare("SELECT config_json FROM sources WHERE id = 'node-runtime'").first<{ config_json: string }>())!.config_json);
    const seeded = await cfg();
    expect(seeded).toMatchObject({ pending_recheck_minutes: 60, pending_old_recheck_minutes: 10080, max_attempts: 10, retry_schedule_minutes: "60,360,1440,10080" });
    const update = migration0020.split(";").find((s) => s.includes("UPDATE sources"))!;
    try {
      await env.DB.prepare("UPDATE sources SET config_json = json_set(config_json, '$.pending_recheck_minutes', 15) WHERE id = 'node-runtime'").run();
      await env.DB.prepare(update).run();
      expect(await cfg()).toMatchObject({ pending_recheck_minutes: 15, max_attempts: 10 });
      await env.DB.prepare("UPDATE sources SET config_json = '{}' WHERE id = 'node-runtime'").run();
      await env.DB.prepare(update).run();
      expect(await cfg()).toEqual({ pending_recheck_minutes: 60, pending_old_recheck_minutes: 10080, max_attempts: 10, retry_schedule_minutes: "60,360,1440,10080" });
    } finally {
      await env.DB.prepare("UPDATE sources SET config_json = ? WHERE id = 'node-runtime'").bind(JSON.stringify(seeded)).run();
    }
  });

  it("config: a knob out of range throws before any fetch", async () => {
    const fake = createRuntimeFake(routes());
    await expect(nodeRuntime.run(ctxAt(fake.fetch, NOW, { pending_recheck_minutes: 0 }))).rejects.toThrow(/pending_recheck_minutes/);
    await expect(nodeRuntime.run(ctxAt(fake.fetch, NOW, { max_attempts: -1 }))).rejects.toThrow(/max_attempts/);
    await expect(nodeRuntime.run(ctxAt(fake.fetch, NOW, { retry_schedule_minutes: "60,0" }))).rejects.toThrow(/retry_schedule_minutes/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the recorded 2019 no-updates post (no updates)", () => {
  it("no updates: the post becomes empty with one warning and no error, and the next 2 runs never read it", async () => {
    expect(postReads([NO_UPDATES])).toHaveLength(1);
    await readAllBut(NO_UPDATES);
    const fake = createRuntimeFake(routes());
    const o1 = await viaRegistry(fake.fetch, NOW);
    expect(o1.status).toBe("ok");
    expect(await nodePostRow(NO_UPDATES)).toMatchObject({ state: "empty", attempts: 0, next_check_at: null, published: pubOf(NO_UPDATES), parser_rev: NODE_PARSER_REV });
    const row = await sourceRow();
    expect(row?.last_error).toBeNull();
    expect(row?.last_ok_at).toBe(iso(NOW));
    expect(row?.last_warning).toBe("september-2019-openssl-no-updates: no CVE headings, older than 365 days, not read again");

    for (const at of [NOW + 61 * MIN, NOW + 8 * DAY]) {
      const o = await viaRegistry(fake.fetch, at);
      expect(o.status).toBe("ok");
      expect(o.status === "ok" ? o.result.warnings : ["?"]).toBeUndefined();
    }
    expect(fake.count(NO_UPDATES)).toBe(1);
    expect(await nodePostState(NO_UPDATES)).toBe("empty");
  });
});

describe("pre-announcement (pre-announcement)", () => {
  it("pre-announcement: the recorded post is pending with no error; read 0 times at +59 min, once at +61 min, then ok with its advisories", async () => {
    await readAllBut(OCT);
    const pre = createRuntimeFake(routes({ [OCT]: preHtml }));
    const o1 = await viaRegistry(pre.fetch, NOW);
    expect(o1.status).toBe("ok");
    expect(await sourceRow()).toMatchObject({ last_error: null, last_ok_at: iso(NOW) });
    expect(await nodePostRow(OCT)).toMatchObject({ state: "pending", next_check_at: iso(NOW + 60 * MIN) });
    expect(pre.count(OCT)).toBe(1);

    const r2 = await nodeRuntime.run(ctxAt(pre.fetch, NOW + 59 * MIN));
    expect(r2.errors).toEqual([]);
    expect(pre.count(OCT)).toBe(1);
    expect(postReads(pre.urls())).toEqual([OCT]);

    const rel = createRuntimeFake(routes());
    const r3 = await nodeRuntime.run(ctxAt(rel.fetch, NOW + 61 * MIN));
    expect(r3.errors).toEqual([]);
    expect(postReads(rel.urls())).toEqual([OCT]);
    expect(r3.upserted).toBe(10);
    expect(await nodePostRow(OCT)).toMatchObject({ state: "ok", next_check_at: null });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'node-runtime'").first<{ n: number }>();
    expect(stored?.n).toBe(10);
  });

  it("pre-announcement old: a pre-announcement older than 365 days is read again after pending_old_recheck_minutes (10080)", async () => {
    const old = POSTS[3].link;
    await readAllBut(old);
    const fake = createRuntimeFake(routes({ [old]: preHtml }));
    const r = await nodeRuntime.run(ctxAt(fake.fetch, NOW));
    expect(r.errors).toEqual([]);
    expect(await nodePostRow(old)).toMatchObject({ state: "pending", next_check_at: iso(NOW + 10080 * MIN) });
    await nodeRuntime.run(ctxAt(fake.fetch, NOW + 10079 * MIN));
    expect(fake.count(old)).toBe(1);
    await nodeRuntime.run(ctxAt(fake.fetch, NOW + 10080 * MIN));
    expect(fake.count(old)).toBe(2);
  });
});

describe("recent post with no CVE heading (recent no CVE)", () => {
  // TCS-69 round 2: a warning per read (never a run error), the retry
  // schedule (1 h, 6 h, ...), then terminal empty at max_attempts.
  it("recent no CVE: a 10-day-old post with no CVE heading is failed with a warning and the backoff; after max_attempts reads it is terminal empty", async () => {
    const link = `${BASE}tcs-69-recent-no-cve`;
    const extra = [{ link, published: iso(NOW - 10 * DAY).replace(/\.\d{3}Z$/, "Z") }];
    await readAllBut();
    const fake = createRuntimeFake(routes({ [link]: NO_HEADINGS }, extra));
    const o1 = await viaRegistry(fake.fetch, NOW);
    expect(o1.status).toBe("ok");
    expect(await sourceRow()).toMatchObject({ last_error: null, last_ok_at: iso(NOW) });
    expect((await sourceRow())?.last_warning).toBe(`tcs-69-recent-no-cve: no CVE headings, read 1 of 10, read again after ${iso(NOW + 60 * MIN)}`);
    expect(await nodePostRow(link)).toMatchObject({ state: "failed", attempts: 1, next_check_at: iso(NOW + 60 * MIN), last_error: `${link}: no CVE headings` });

    const cfg = { ...CONFIG, max_attempts: 3 };
    const r2 = await nodeRuntime.run(ctxAt(fake.fetch, NOW + 61 * MIN, cfg));
    expect(r2.errors).toEqual([]);
    expect(await nodePostRow(link)).toMatchObject({ state: "failed", attempts: 2, next_check_at: iso(NOW + 61 * MIN + 360 * MIN) });
    await nodeRuntime.run(ctxAt(fake.fetch, NOW + 61 * MIN + 359 * MIN, cfg));
    expect(fake.count(link)).toBe(2);
    const r3 = await nodeRuntime.run(ctxAt(fake.fetch, NOW + 61 * MIN + 360 * MIN, cfg));
    expect(r3.errors).toEqual([]);
    expect(r3.warnings).toEqual(["tcs-69-recent-no-cve: no CVE headings, after 3 reads, not read again"]);
    expect(await nodePostRow(link)).toMatchObject({ state: "empty", attempts: 3, next_check_at: null });
    const r4 = await nodeRuntime.run(ctxAt(fake.fetch, NOW + 10 * DAY, cfg));
    expect(r4.errors).toEqual([]);
    expect(r4.warnings).toBeUndefined();
    expect(fake.count(link)).toBe(3);
  });
});

describe("pending attempt cap (pending cap)", () => {
  // TCS-69 round 2: a pre-announcement that never turns into a release is
  // terminal empty after max_attempts reads, with one warning.
  it("pending cap: a pre-announcement that is not the newest post is empty after max_attempts reads, then never read", async () => {
    const link = `${BASE}tcs-69-stale-pre`;
    const extra = [{ link, published: iso(NOW - 20 * DAY).replace(/\.\d{3}Z$/, "Z") }];
    await readAllBut();
    const fake = createRuntimeFake(routes({ [link]: preHtml }, extra));
    const cfg = { ...CONFIG, max_attempts: 3 };
    const r1 = await nodeRuntime.run(ctxAt(fake.fetch, NOW, cfg));
    expect(r1.warnings).toBeUndefined();
    expect(await nodePostRow(link)).toMatchObject({ state: "pending", attempts: 1, next_check_at: iso(NOW + 60 * MIN) });
    await nodeRuntime.run(ctxAt(fake.fetch, NOW + 60 * MIN, cfg));
    expect(await nodePostRow(link)).toMatchObject({ state: "pending", attempts: 2 });
    const r3 = await nodeRuntime.run(ctxAt(fake.fetch, NOW + 120 * MIN, cfg));
    expect(r3.errors).toEqual([]);
    expect(r3.warnings).toEqual(["tcs-69-stale-pre: pre-announcement with no release after 3 reads, not read again"]);
    expect(await nodePostRow(link)).toMatchObject({ state: "empty", attempts: 3, next_check_at: null });
    const r4 = await nodeRuntime.run(ctxAt(fake.fetch, NOW + 30 * DAY, cfg));
    expect(r4.warnings).toBeUndefined();
    expect(fake.count(link)).toBe(3);
  });

  it("pending cap: the newest feed post in state empty is still read each run, so its release is found; no new warning", async () => {
    await readAllBut(OCT);
    await seedNodePosts([{ url: OCT, published: pubOf(OCT), state: "empty", attempts: 10 }]);
    const pre = createRuntimeFake(routes({ [OCT]: preHtml }));
    const r1 = await nodeRuntime.run(ctxAt(pre.fetch, NOW));
    expect(pre.count(OCT)).toBe(1);
    expect(r1.warnings).toBeUndefined();
    expect(await nodePostState(OCT)).toBe("empty");
    const rel = createRuntimeFake(routes());
    const r2 = await nodeRuntime.run(ctxAt(rel.fetch, NOW + 10 * MIN));
    expect(r2.upserted).toBe(10);
    expect(await nodePostRow(OCT)).toMatchObject({ state: "ok", attempts: 0 });
  });
});

describe("through runIngesters (runIngesters)", () => {
  it("runIngesters: a run whose only outcomes are empty and pending leaves last_error NULL and moves last_ok_at", async () => {
    await env.DB.prepare("UPDATE sources SET last_error = 'old failure', last_ok_at = '2026-10-01T00:00:00.000Z' WHERE id = 'node-runtime'").run();
    // OCT is the newest feed post, so no ok row is read again in this run.
    await readAllBut(NO_UPDATES, OCT);
    const fake = createRuntimeFake(routes({ [OCT]: preHtml }));
    const o = await viaRegistry(fake.fetch, NOW);
    expect(postReads(fake.urls()).sort()).toEqual([NO_UPDATES, OCT].sort());
    expect(o.status).toBe("ok");
    expect(await sourceRow()).toMatchObject({ last_error: null, last_ok_at: iso(NOW), last_run_at: iso(NOW) });
    expect(await nodePostState(NO_UPDATES)).toBe("empty");
    expect(await nodePostState(OCT)).toBe("pending");
  });
});

describe("read selection (selection)", () => {
  it("out of order: a feed post older than every ok row and with no row is read once", async () => {
    const first = POSTS[0].link;
    await readAllBut(first);
    const f1 = createRuntimeFake(routes());
    const r1 = await nodeRuntime.run(ctxAt(f1.fetch, NOW));
    expect(r1.errors).toEqual([]);
    // The missing post, and the newest feed post (ok, read again).
    expect(postReads(f1.urls())).toEqual([first, OCT]);
    expect(await nodePostState(first)).toBe("ok");
    const f2 = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f2.fetch, NOW + 61 * MIN));
    expect(postReads(f2.urls())).toEqual([OCT]);
  });

  it("re-published: an ok row whose feed pubDate changed is read once and its published is updated", async () => {
    const p = POSTS[5];
    await readAllBut(p.link);
    await seedNodePosts([{ url: p.link, published: "2010-01-01T00:00:00Z", state: "ok" }]);
    const f1 = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f1.fetch, NOW));
    expect(postReads(f1.urls())).toEqual([p.link, OCT]);
    expect(await nodePostRow(p.link)).toMatchObject({ state: "ok", published: p.published });
    const f2 = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f2.fetch, NOW + 61 * MIN));
    expect(f2.count(p.link)).toBe(0);
  });

  it("parser_rev: an ok row read by parser revision 2 is read once", async () => {
    const p = POSTS[5];
    await readAllBut(p.link);
    await seedNodePosts([{ url: p.link, published: p.published, state: "ok", parser_rev: "2" }]);
    const f1 = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f1.fetch, NOW));
    expect(postReads(f1.urls())).toEqual([p.link, OCT]);
    expect(await nodePostRow(p.link)).toMatchObject({ state: "ok", parser_rev: NODE_PARSER_REV });
    const f2 = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f2.fetch, NOW + 61 * MIN));
    expect(f2.count(p.link)).toBe(0);
  });

  it("selection: empty, not-due pending, terminal failed and older ok rows are not read; a pending row due now is read (edge <=)", async () => {
    const [a, b, c, d] = [POSTS[1], POSTS[2], POSTS[3], POSTS[4]];
    await readAllBut();
    await seedNodePosts([
      { url: a.link, published: a.published, state: "empty" },
      { url: b.link, published: b.published, state: "pending", next_check_at: iso(NOW + MIN) },
      { url: c.link, published: c.published, state: "failed", attempts: 10, next_check_at: null },
      { url: d.link, published: d.published, state: "pending", next_check_at: iso(NOW) },
    ]);
    const fake = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(fake.fetch, NOW));
    expect(postReads(fake.urls())).toEqual([d.link, OCT]);
    expect(await nodePostState(d.link)).toBe("ok");
  });

  it("selection: a due failed row whose post left the feed is read by its stored URL and date", async () => {
    const gone = `${BASE}tcs-69-left-the-feed`;
    await readAllBut();
    await seedNodePosts([{ url: gone, published: "2026-10-10T00:00:00Z", state: "failed", attempts: 1, next_check_at: iso(NOW - MIN) }]);
    const fake = createRuntimeFake(routes({ [gone]: synthetic(99) }));
    const r = await nodeRuntime.run(ctxAt(fake.fetch, NOW));
    expect(r.errors).toEqual([]);
    expect(postReads(fake.urls())).toEqual([gone, OCT]);
    expect(await nodePostRow(gone)).toMatchObject({ state: "ok", published: "2026-10-10T00:00:00Z", next_check_at: null });
  });

  it("selection: a due row whose post left the feed keeps its stored title", async () => {
    const gone = `${BASE}tcs-69-left-with-title`;
    const extra = [{ link: gone, published: iso(NOW - 5 * DAY).replace(/\.\d{3}Z$/, "Z") }];
    await readAllBut();
    const f1 = createRuntimeFake(routes({ [gone]: NO_HEADINGS }, extra));
    await nodeRuntime.run(ctxAt(f1.fetch, NOW));
    const title = async () => (await env.DB.prepare("SELECT title FROM node_runtime_posts WHERE url = ?").bind(gone).first<{ title: string | null }>())?.title;
    expect(await title()).toBe("TCS-69 fixture Security Releases");
    // The next read: the post is no longer in the feed.
    const f2 = createRuntimeFake(routes({ [gone]: NO_HEADINGS }));
    await nodeRuntime.run(ctxAt(f2.fetch, NOW + 61 * MIN));
    expect(f2.count(gone)).toBe(1);
    expect(await nodePostRow(gone)).toMatchObject({ state: "failed", attempts: 2 });
    expect(await title()).toBe("TCS-69 fixture Security Releases");
  });

  it("selection: past the max_posts cap the due posts wait for the next run, no row is lost", async () => {
    const r1 = await nodeRuntime.run(ctxAt(createRuntimeFake(routes()).fetch, NOW, { ...CONFIG, max_posts: 30 }));
    expect(r1.deferred).toBe(18);
    expect(r1.incomplete).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM node_runtime_posts").first<{ n: number }>();
    expect(n?.n).toBe(30);
    const f2 = createRuntimeFake(routes());
    const r2 = await nodeRuntime.run(ctxAt(f2.fetch, NOW, { ...CONFIG, max_posts: 30 }));
    // 18 posts with no row, plus the newest feed post (first read in this run, so not twice).
    expect(postReads(f2.urls())).toHaveLength(18);
    expect(r2.deferred).toBeUndefined();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM node_runtime_posts").first<{ n: number }>())?.n).toBe(48);
  });
});

describe("coverage (coverage)", () => {
  // TCS-69 round 2: every feed post has a row with a known outcome, a failed
  // post with its backoff included, so the history is read (the reviewer's
  // walk: the December 2025 post must not hold coverage_since back for weeks).
  it("coverage: a failed row with its backoff counts as read; a feed post with no row holds coverage_since back", async () => {
    const p = POSTS[7];
    const cov = async () => (await env.DB.prepare("SELECT coverage_since FROM sources WHERE id = 'node-runtime'").first<{ coverage_since: string | null }>())!.coverage_since;
    await readAllBut(p.link, OCT);
    await nodeRuntime.run(ctxAt(createRuntimeFake(routes()).fetch, NOW, { ...CONFIG, max_posts: 1 }));
    expect(await nodePostRow(OCT)).toBeNull();
    expect(await cov()).toBeNull();
    await seedNodePosts([{ url: p.link, published: p.published, state: "failed", attempts: 2, next_check_at: iso(NOW + 30 * MIN) }]);
    const f2 = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f2.fetch, NOW));
    expect(f2.count(p.link)).toBe(0);
    expect(await nodePostRow(p.link)).toMatchObject({ state: "failed", next_check_at: iso(NOW + 30 * MIN) });
    // markCoverage stores the oldest advisory held (here: the synthetic post the first run read).
    expect(await cov()).not.toBeNull();
  });
});

describe("the empty classifier (negative list)", () => {
  // Each case: a post (recorded or synthetic) at a feed URL and date, and the state it must get.
  const cases: { name: string; link: string; published: string; html: string; state: string; error: boolean; warning: boolean }[] = [
    { name: "recorded 2019 no-updates post", link: NO_UPDATES, published: pubOf(NO_UPDATES), html: noUpdatesHtml, state: "empty", error: false, warning: true },
    { name: "no heading, 366 days old (edge)", link: `${BASE}tcs-69-366`, published: iso(NOW - 366 * DAY), html: NO_HEADINGS, state: "empty", error: false, warning: true },
    { name: "recorded 2026-10-14 pre-announcement", link: `${BASE}tcs-69-pre`, published: iso(NOW - 9 * DAY), html: preHtml, state: "pending", error: false, warning: false },
    { name: "unrated CVE heading", link: `${BASE}tcs-69-unrated`, published: iso(NOW - 400 * DAY), html: "<main><h2>Thing (CVE-2026-1234)</h2><p>x</p></main>", state: "ok", error: false, warning: true },
    {
      name: "CVE heading with no release lines",
      link: `${BASE}tcs-69-nolines`,
      published: iso(NOW - 400 * DAY),
      html: "<main><h2>Thing (CVE-2026-1235) - (high)</h2><p>This vulnerability affects all users</p></main>",
      state: "ok",
      error: false,
      warning: true,
    },
    { name: "no heading, 10 days old", link: `${BASE}tcs-69-10d`, published: iso(NOW - 10 * DAY), html: NO_HEADINGS, state: "failed", error: false, warning: true },
    { name: "no heading, 364 days old (edge)", link: `${BASE}tcs-69-364`, published: iso(NOW - 364 * DAY), html: NO_HEADINGS, state: "failed", error: false, warning: true },
    { name: "recorded July release post", link: JULY, published: pubOf(JULY), html: julyHtml, state: "ok", error: false, warning: false },
    { name: "recorded October release post", link: OCT, published: pubOf(OCT), html: octHtml, state: "ok", error: false, warning: false },
  ];

  it.each(cases)("negative list: $name -> $state", async ({ link, published, html, state, error, warning }) => {
    const inFeed = POSTS.some((p) => p.link === link);
    const pub = published.replace(/\.\d{3}Z$/, "Z");
    await readAllBut(link);
    const fake = createRuntimeFake(routes({ [link]: html }, inFeed ? [] : [{ link, published: pub }]));
    const r = await nodeRuntime.run(ctxAt(fake.fetch, NOW));
    expect(fake.count(link)).toBe(1);
    expect(await nodePostState(link)).toBe(state);
    // TCS-69 round 2: a post's note is never a run error.
    expect(r.errors.some((e) => e.includes(link)), "error").toBe(error);
    expect(r.errors).toEqual([]);
    expect((r.warnings ?? []).length > 0, "warning").toBe(warning);
  });
});

describe("query plans (EXPLAIN)", () => {
  it("EXPLAIN: on 500 rows the due read uses idx_node_runtime_posts_state_next and the known read the primary key, no full scan (no ANALYZE)", async () => {
    const states = ["ok", "empty", "pending", "failed"];
    await seedNodePosts(
      Array.from({ length: 500 }, (_, i) => ({
        url: `${BASE}tcs-69-explain-${i}`,
        published: iso(NOW - i * DAY),
        state: states[i % 4] as "ok",
        next_check_at: i % 4 >= 2 ? iso(NOW + (i % 7) * MIN) : null,
      })),
    );
    const plan = async (sql: string, ...binds: unknown[]) =>
      (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n");
    const due = await plan(POST_SQL.due, "pending", iso(NOW), 20);
    expect(due).toContain("idx_node_runtime_posts_state_next");
    expect(due).not.toMatch(/SCAN node_runtime_posts(?! USING)/);
    expect(due).not.toContain("TEMP B-TREE");
    const known = await plan(POST_SQL.known, JSON.stringify([`${BASE}tcs-69-explain-1`, `${BASE}tcs-69-explain-2`]));
    expect(known).toMatch(/SEARCH node_runtime_posts USING INDEX sqlite_autoindex_node_runtime_posts_1 \(url=\?\)/);
    expect(known).not.toMatch(/SCAN node_runtime_posts(?! USING)/);
    const grouped = await plan(ledgerSql("node_runtime_posts"));
    expect(grouped).toContain("idx_node_runtime_posts_state_next");
    expect(grouped).not.toMatch(/SCAN node_runtime_posts(?! USING)/);
  });
});

describe("GET /v1/status (status)", () => {
  it("status: node-runtime has ledger counts that match the seeded rows", async () => {
    await seedNodePosts([
      ...Array.from({ length: 4 }, (_, i) => ({ url: `${BASE}s-ok-${i}`, published: "2020-01-01T00:00:00Z", state: "ok" as const })),
      { url: `${BASE}s-empty`, published: "2019-09-12T17:00:15Z", state: "empty" },
      ...Array.from({ length: 2 }, (_, i) => ({ url: `${BASE}s-pending-${i}`, published: "2026-10-14T00:00:00Z", state: "pending" as const, next_check_at: iso(NOW + 60 * MIN) })),
      { url: `${BASE}s-retry`, published: "2026-10-13T00:00:00Z", state: "failed", attempts: 2, next_check_at: iso(NOW + 60 * MIN) },
      ...Array.from({ length: 3 }, (_, i) => ({ url: `${BASE}s-term-${i}`, published: "2016-01-01T00:00:00Z", state: "failed" as const, next_check_at: null })),
    ]);
    const res = await exports.default.fetch("https://tocsin.test/v1/status", { headers: { "CF-Connecting-IP": "198.51.100.69" } });
    expect(res.status).toBe(200);
    const node = ((await res.json()) as { sources: { id: string; ledger?: unknown }[] }).sources.find((s) => s.id === "node-runtime");
    expect(node?.ledger).toEqual({ ok: 4, empty: 1, pending: 2, failed_retrying: 1, failed_terminal: 3 });
  });
});
