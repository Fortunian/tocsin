import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NODE_DEFAULTS, parseNodeFeed, parseNodeSecurityPost } from "../../src/ingest/node-runtime";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import distIndex from "../fixtures/node-eol/index.json?raw";
import noUpdatesHtml from "../fixtures/node-runtime/2019-09-12-no-updates.html?raw";
import pre2019Html from "../fixtures/node-runtime/2019-12-18-pre.html?raw";
import incompleteHtml from "../fixtures/node-runtime/2026-01-13-incomplete.html?raw";
import octHtml from "../fixtures/node-runtime/2026-10-21.tcs-69.html?raw";
import indexOct from "../fixtures/node-runtime/index.json?raw";
import indexJuly from "../fixtures/node-runtime/index-since-2026-07.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { clearNodeLedger, nodePostRow } from "./node-ledger-seed.tcs-69";
import { createRuntimeFake, type FakeAnswer } from "./runtime-fake.tcs-6";

// TCS-69 round 2: the history walk from an EMPTY ledger (the state on deploy)
// over the recorded feed (48 Security Release posts), with the production path
// (runIngesters, the node-runtime row's config: max_posts 20).
// RECORDED pages (tests/fixtures/node-runtime/README.tcs-69.md): the 2019
// "no updates" post, the 2019-12-18 pre-announcement, the 2026-01-13
// (december-2025-security-releases) post that has no fixed version, and the
// October 2026 release post. Every other post answers a SYNTHETIC post as in
// node-history.tcs-32 (one CVE heading on 4.x, fixed in v4.9.1, a version of
// tests/fixtures/node-eol/index.json).
const FEED = NODE_DEFAULTS.feed_url;
const INDEX = NODE_DEFAULTS.dist_index_url;
const BASE = "https://nodejs.org/en/blog/vulnerability/";
const NO_UPDATES = `${BASE}september-2019-openssl-no-updates`;
const PRE_2019 = `${BASE}december-2019-security-releases`;
const INCOMPLETE = `${BASE}december-2025-security-releases`;
const OCT = `${BASE}october-2026-security-releases`;
const NEWER_THAN_INCOMPLETE = [`${BASE}march-2026-security-releases`, `${BASE}june-2026-security-releases`, `${BASE}july-2026-security-releases`, OCT];
const NOW = Date.parse("2026-10-23T13:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const POSTS = parseNodeFeed(feedXml).filter((p) => p.title.toLowerCase().includes("security release"));
const OCT_CVES = parseNodeSecurityPost(octHtml).cves.map((c) => c.cve);

function synthetic(i: number): string {
  return `<main><h2>Fixture issue ${i} (CVE-2015-${String(90000 + i)}) - (high)</h2>
<p>This vulnerability affects Node.js 4.x</p>
<h2>Downloads and release details</h2><ul><li>Node.js v4.9.1</li></ul></main>`;
}

function routes(over: Record<string, FakeAnswer> = {}): Record<string, FakeAnswer> {
  const versions = [...(JSON.parse(indexOct) as unknown[]), ...(JSON.parse(indexJuly) as unknown[]), ...(JSON.parse(distIndex) as unknown[])];
  const r: Record<string, FakeAnswer> = { [FEED]: feedXml, [INDEX]: JSON.stringify(versions) };
  POSTS.forEach((p, i) => (r[p.link] = synthetic(i)));
  r[NO_UPDATES] = noUpdatesHtml;
  r[PRE_2019] = pre2019Html;
  r[INCOMPLETE] = incompleteHtml;
  r[OCT] = octHtml;
  return { ...r, ...over };
}

// Three runs from an empty ledger, 10 minutes apart (the walk of 48 posts, 20 per run).
const RUNS = [NOW, NOW + 10 * MIN, NOW + 20 * MIN];
async function walk(fake: ReturnType<typeof createRuntimeFake>): Promise<SourceOutcome[]> {
  const outcomes: SourceOutcome[] = [];
  for (const at of RUNS) outcomes.push(await viaRegistry(fake.fetch, at));
  return outcomes;
}

let fetchSpy: MockInstance;
const noNetwork = (() => {
  throw new Error("real network call in a TCS-69 test");
}) as never;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(noNetwork);
});
afterAll(() => fetchSpy.mockRestore());

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

async function sourceRow() {
  return env.DB.prepare("SELECT last_ok_at, last_error, last_warning, coverage_since FROM sources WHERE id = 'node-runtime'").first<{
    last_ok_at: string | null;
    last_error: string | null;
    last_warning: string | null;
    coverage_since: string | null;
  }>();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL, last_run_at = NULL, last_ok_at = NULL, last_error = NULL, last_warning = NULL WHERE id = 'node-runtime'").run();
  await env.CURSORS.delete(NODE_DIST_KEY);
  await clearNodeLedger();
});

describe("walk from an empty ledger (walk)", () => {
  it("walk: an incomplete recent post gets a backoff and the walk goes past it; run 4 before the backoff does not read it", async () => {
    expect(POSTS).toHaveLength(48);
    expect(OCT_CVES).toHaveLength(10);
    const fake = createRuntimeFake(routes());
    const runs = RUNS;
    const outcomes = await walk(fake);

    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    const row = await sourceRow();
    expect(row?.last_error).toBeNull();
    expect(row?.last_ok_at).toBe(iso(runs[2]));
    // Round 3: the December 2025 post (20.x, 22.x, 24.x) is not read in full,
    // so the history is not complete (no false clean).
    expect(row?.coverage_since).toBeNull();
    expect(row?.last_warning).toContain("december-2025-security-releases");

    expect(await nodePostRow(INCOMPLETE)).toMatchObject({ state: "failed", attempts: 1, next_check_at: iso(runs[2] + 60 * MIN) });
    expect(fake.count(INCOMPLETE)).toBe(1);
    // The walk continued past the incomplete post in the same run.
    for (const url of NEWER_THAN_INCOMPLETE) expect((await nodePostRow(url))?.state, url).toBe("ok");
    expect(await nodePostRow(NO_UPDATES)).toMatchObject({ state: "empty" });
    expect(await nodePostRow(PRE_2019)).toMatchObject({ state: "pending" });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM node_runtime_posts").first<{ n: number }>();
    expect(rows?.n).toBe(48);

    const stored = await env.DB.prepare("SELECT source_id FROM advisory_sources WHERE source = 'node-runtime' AND source_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(OCT_CVES))
      .all<{ source_id: string }>();
    expect(stored.results.map((r) => r.source_id).sort()).toEqual([...OCT_CVES].sort());

    // Run 4, 30 minutes after run 3: the backoff (1 hour) has not passed.
    const o4 = await viaRegistry(fake.fetch, NOW + 50 * MIN);
    expect(o4.status).toBe("ok");
    expect(fake.count(INCOMPLETE)).toBe(1);
    expect((await sourceRow())?.last_error).toBeNull();
    expect((await nodePostRow(INCOMPLETE))?.attempts).toBe(1);
    expect((await sourceRow())?.coverage_since).toBeNull();
  });

  it("walk: coverage_since is set once the incomplete post is ok; the empty 2019 no-updates post does not hold it back", async () => {
    await walk(createRuntimeFake(routes()));
    expect((await sourceRow())?.coverage_since).toBeNull();
    expect(await nodePostRow(NO_UPDATES)).toMatchObject({ state: "empty", last_error: null });
    // After the 1-hour backoff the post answers a complete page: a SYNTHETIC
    // page (in-test edit, source: assumed), the shape of node-history.tcs-32.
    const fixed = createRuntimeFake(routes({ [INCOMPLETE]: synthetic(999) }));
    const o = await viaRegistry(fixed.fetch, RUNS[2] + 61 * MIN);
    expect(o.status).toBe("ok");
    expect(fixed.count(INCOMPLETE)).toBe(1);
    expect(await nodePostRow(INCOMPLETE)).toMatchObject({ state: "ok" });
    expect((await sourceRow())?.coverage_since).not.toBeNull();
  });
});
