import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NODE_DEFAULTS, NODE_PARSER_REV, normalizeNodePost, nodeRuntime, parseNodeFeed, parseNodeSecurityPost } from "../../src/ingest/node-runtime";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import type { IngestContext } from "../../src/ingest/types";
import eolIndex from "../fixtures/node-eol/index.json?raw";
import noUpdatesHtml from "../fixtures/node-runtime/2019-09-12-no-updates.html?raw";
import decHtml from "../fixtures/node-runtime/2026-01-13-incomplete.html?raw";
import marchHtml from "../fixtures/node-runtime/2026-03-24.html?raw";
import juneHtml from "../fixtures/node-runtime/2026-06-18.html?raw";
import julyHtml from "../fixtures/node-runtime/2026-07-29.html?raw";
import octHtml from "../fixtures/node-runtime/2026-10-21.tcs-69.html?raw";
import indexDecJune from "../fixtures/node-runtime/index-2025-12-to-2026-06.json?raw";
import indexJuly from "../fixtures/node-runtime/index-since-2026-07.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { clearNodeLedger, nodePostRow, seedNodePosts } from "./node-ledger-seed.tcs-69";
import { createRuntimeFake, type FakeAnswer } from "./runtime-fake.tcs-6";

// TCS-76: the December 2025, March 2026 and June 2026 Node security posts.
// RECORDED pages (tests/fixtures/node-runtime/README.tcs-69.md and
// README.tcs-76.md): the three posts, the July and October 2026 posts and the
// 2019 "no updates" post. The dist index is the recorded slices
// index-2025-12-to-2026-06.json and index-since-2026-07.json, plus
// tests/fixtures/node-eol/index.json (v4.9.1) for the SYNTHETIC posts of the
// shape of node-history.tcs-32 that answer every other feed post.
const FEED = NODE_DEFAULTS.feed_url;
const INDEX = NODE_DEFAULTS.dist_index_url;
const BASE = "https://nodejs.org/en/blog/vulnerability/";
const DEC = `${BASE}december-2025-security-releases`;
const MARCH = `${BASE}march-2026-security-releases`;
const JUNE = `${BASE}june-2026-security-releases`;
const JULY = `${BASE}july-2026-security-releases`;
const OCT = `${BASE}october-2026-security-releases`;
const NO_UPDATES = `${BASE}september-2019-openssl-no-updates`;
const POSTS = parseNodeFeed(feedXml)
  .filter((p) => p.title.toLowerCase().includes("security release"))
  .sort((a, b) => (a.published < b.published ? -1 : 1));
const pubOf = (url: string) => POSTS.find((p) => p.link === url)!.published;
const NOW = Date.parse("2026-10-23T14:00:00Z");
const MIN = 60_000;

type Entry = { version: string };
const VERSIONS: Entry[] = [...(JSON.parse(indexDecJune) as Entry[]), ...(JSON.parse(indexJuly) as Entry[]), ...(JSON.parse(eolIndex) as Entry[])];
const DIST = new Set(VERSIONS.map((e) => e.version));

const DEC_FIXED: Record<number, string> = { 20: "20.20.0", 22: "22.22.0", 24: "24.13.0", 25: "25.3.0" };
const MARCH_FIXED: Record<number, string> = { 20: "20.20.2", 22: "22.22.2", 24: "24.14.1", 25: "25.8.2" };
const JUNE_FIXED: Record<number, string> = { 22: "22.23.0", 24: "24.17.0", 26: "26.3.1" };
// The 8 March CVEs the parser did not emit before TCS-76 (CVE-2026-21711 was emitted).
const MARCH_MISSING = ["CVE-2026-21637", "CVE-2026-21710", "CVE-2026-21712", "CVE-2026-21713", "CVE-2026-21714", "CVE-2026-21715", "CVE-2026-21716", "CVE-2026-21717"];
// The July table of node-runtime.tcs-30 (read from the fixture text).
const JULY_CVES: Record<string, number[]> = {
  "CVE-2026-56846": [22, 24],
  "CVE-2026-56848": [22, 24, 26],
  "CVE-2026-58043": [22, 24, 26],
  "CVE-2026-56850": [22, 24, 26],
  "CVE-2026-58040": [22, 24, 26],
  "CVE-2026-58041": [24, 26],
  "CVE-2026-58042": [22, 24, 26],
  "CVE-2026-58045": [22, 24, 26],
  "CVE-2026-56847": [22, 24, 26],
  "CVE-2026-58039": [22, 24, 26],
  "CVE-2026-58044": [22, 24, 26],
};
const JULY_FIXED: Record<number, string> = { 22: "22.23.2", 24: "24.18.1", 26: "26.5.1" };

const norm = (link: string, html: string, dist = DIST) => normalizeNodePost({ link, published: pubOf(link) }, html, dist);
const ranges = (lines: number[], fixed: Record<number, string>) => lines.map((l) => ({ introduced: `${l}.0.0`, fixed: fixed[l] }));
const docOf = (r: ReturnType<typeof norm>, cve: string) => r.docs.find((d) => d.cve_ids[0] === cve);

function synthetic(i: number): string {
  return `<main><h2>Fixture issue ${i} (CVE-2015-${String(90000 + i)}) - (high)</h2>
<p>This vulnerability affects Node.js 4.x</p>
<h2>Downloads and release details</h2><ul><li>Node.js v4.9.1</li></ul></main>`;
}

function routes(over: Record<string, FakeAnswer> = {}): Record<string, FakeAnswer> {
  const r: Record<string, FakeAnswer> = { [FEED]: feedXml, [INDEX]: JSON.stringify(VERSIONS) };
  POSTS.forEach((p, i) => (r[p.link] = synthetic(i)));
  Object.assign(r, { [DEC]: decHtml, [MARCH]: marchHtml, [JUNE]: juneHtml, [JULY]: julyHtml, [OCT]: octHtml, [NO_UPDATES]: noUpdatesHtml });
  return { ...r, ...over };
}

const CONFIG = { max_posts: 20, backfill_days: 4000 };
function ctxAt(fetchFn: typeof fetch, now: number): IngestContext {
  return { env, source: { id: "node-runtime", kind: "node-runtime", config: CONFIG, coverage_since: null }, now: () => new Date(now), fetch: fetchFn };
}

let fetchSpy: MockInstance;
const noNetwork = (() => {
  throw new Error("real network call in a TCS-76 test");
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

async function storedFixed(cve: string): Promise<string[] | undefined> {
  const row = await env.DB.prepare("SELECT a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'node-runtime' AND s.source_id = ?")
    .bind(cve)
    .first<{ doc_json: string }>();
  return row ? (JSON.parse(row.doc_json) as { fixed_versions: string[] }).fixed_versions : undefined;
}

// Every feed post has an ok row of the current parser revision, except the listed URLs.
async function readAllBut(...except: string[]): Promise<void> {
  await seedNodePosts(POSTS.filter((p) => !except.includes(p.link)).map((p) => ({ url: p.link, published: p.published, state: "ok" })));
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL, last_run_at = NULL, last_ok_at = NULL, last_error = NULL, last_warning = NULL WHERE id = 'node-runtime'").run();
  await env.CURSORS.delete(NODE_DIST_KEY);
  await clearNodeLedger();
});

describe("fixtures (A1)", () => {
  it("A1: the March page has 9 rated CVE headings; the dist slice is an array with the fixed versions", () => {
    const p = parseNodeSecurityPost(marchHtml);
    expect(p.cves).toHaveLength(9);
    expect(p.unparsed).toEqual([]);
    const slice = (JSON.parse(indexDecJune) as Entry[]).map((e) => e.version);
    expect(slice).toEqual(expect.arrayContaining(["v20.20.0", "v24.12.0", "v25.8.2", "v26.3.1"]));
  });
});

describe("the three posts (posts)", () => {
  it("A2: December 2025 gives 8 advisories with fixed versions for 20.x, 22.x, 24.x and 25.x", () => {
    const r = norm(DEC, decHtml);
    expect(r.errors).toEqual([]);
    expect(r.incomplete).toBe(false);
    expect(r.notEmitted).toBe(0);
    expect(r.docs).toHaveLength(8);
    for (const cve of ["CVE-2025-55131", "CVE-2025-55130", "CVE-2025-55132", "CVE-2026-21637"]) {
      expect(docOf(r, cve)?.affected, cve).toEqual(ranges([20, 22, 24, 25], DEC_FIXED));
    }
    // "already fixed on Node.js 24.12.0": the version of its own section, not the Downloads one.
    expect(docOf(r, "CVE-2025-59464")?.affected).toEqual([{ introduced: "24.0.0", fixed: "24.12.0" }]);
    expect(docOf(r, "CVE-2025-59464")?.action).toBe("Upgrade node to 24.12.0 or later.");
    expect(docOf(r, "CVE-2026-21636")?.affected).toEqual(ranges([25], DEC_FIXED));
  });

  it("A3: March 2026 gives 9 advisories, the 8 that were missing among them", () => {
    const r = norm(MARCH, marchHtml);
    expect(r.errors).toEqual([]);
    expect(r.notEmitted).toBe(0);
    expect(r.docs).toHaveLength(9);
    expect(r.docs.map((d) => d.cve_ids[0])).toEqual(expect.arrayContaining(MARCH_MISSING));
    expect(docOf(r, "CVE-2026-21714")?.affected).toEqual(ranges([20, 22, 24, 25], MARCH_FIXED));
    expect(docOf(r, "CVE-2026-21712")?.affected).toEqual(ranges([24, 25], MARCH_FIXED));
    expect(docOf(r, "CVE-2026-21711")?.affected).toEqual(ranges([25], MARCH_FIXED));
    for (const cve of ["CVE-2026-21637", "CVE-2026-21710", "CVE-2026-21713", "CVE-2026-21715", "CVE-2026-21716", "CVE-2026-21717"]) {
      expect(docOf(r, cve)?.affected, cve).toEqual(ranges([20, 22, 24, 25], MARCH_FIXED));
    }
  });

  it("A4: June 2026 gives 12 advisories", () => {
    const r = norm(JUNE, juneHtml);
    expect(r.errors).toEqual([]);
    expect(r.notEmitted).toBe(0);
    expect(r.docs).toHaveLength(12);
    for (const d of r.docs) {
      const cve = d.cve_ids[0];
      const lines = cve === "CVE-2026-48937" ? [22, 24] : cve === "CVE-2026-48936" ? [26] : [22, 24, 26];
      expect(d.affected, cve).toEqual(ranges(lines, JUNE_FIXED));
    }
    expect(docOf(r, "CVE-2026-48937")).toBeDefined();
    expect(docOf(r, "CVE-2026-48936")).toBeDefined();
  });

  it("A5: October 2026 still gives 10 and July the same docs; a second run is unchanged", async () => {
    const oct = norm(OCT, octHtml);
    expect(oct.errors).toEqual([]);
    expect(oct.docs).toHaveLength(10);
    const july = norm(JULY, julyHtml);
    expect(july.errors).toEqual([]);
    expect(july.docs.map((d) => d.cve_ids[0]).sort()).toEqual(Object.keys(JULY_CVES).sort());
    for (const [cve, lines] of Object.entries(JULY_CVES)) expect(docOf(july, cve)?.affected, cve).toEqual(ranges(lines, JULY_FIXED));

    const five = [DEC, MARCH, JUNE, JULY, OCT];
    await readAllBut(...five);
    const f = createRuntimeFake(routes());
    const r1 = await nodeRuntime.run(ctxAt(f.fetch, NOW));
    expect(r1.errors).toEqual([]);
    // 8 + 9 + 12 + 11 + 10 docs; CVE-2026-21637 is in December and March.
    expect(r1.fetched).toBe(50);
    expect(r1.upserted).toBe(50);
    for (const url of five) expect(await nodePostRow(url), url).toMatchObject({ state: "ok", parser_rev: NODE_PARSER_REV });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'node-runtime'").first<{ n: number }>();
    expect(n?.n).toBe(49);

    await env.DB.prepare("UPDATE node_runtime_posts SET parser_rev = '3' WHERE url IN (SELECT value FROM json_each(?))").bind(JSON.stringify(five)).run();
    const r2 = await nodeRuntime.run(ctxAt(f.fetch, NOW + 10 * MIN));
    expect(r2.errors).toEqual([]);
    expect(r2.fetched).toBe(50);
    expect(r2.upserted).toBe(0);
    expect(r2.unchanged).toBe(50);
  });

  it("A7: December against a dist index without v24.12.0 is incomplete", () => {
    const r = norm(DEC, decHtml, new Set([...DIST].filter((v) => v !== "v24.12.0")));
    expect(r.incomplete).toBe(true);
    expect(r.docs).toEqual([]);
    expect(r.errors.join("; ")).toContain("24.12.0 is not in the dist index");
  });
});

describe("CVE-2026-21637 in two posts (21637)", () => {
  const MARCH_21637 = ["20.20.2", "22.22.2", "24.14.1", "25.8.2"];

  it("21637: March then December keeps fixed 20.20.2/22.22.2/24.14.1/25.8.2; December then March gives the same", async () => {
    // March read first, then December (a December retry after March).
    await readAllBut(MARCH);
    const f = createRuntimeFake(routes());
    await nodeRuntime.run(ctxAt(f.fetch, NOW));
    expect(f.count(MARCH)).toBe(1);
    expect(f.count(DEC)).toBe(0);
    expect(await storedFixed("CVE-2026-21637")).toEqual(MARCH_21637);

    await env.DB.prepare("UPDATE node_runtime_posts SET parser_rev = '3' WHERE url = ?").bind(DEC).run();
    const r = await nodeRuntime.run(ctxAt(f.fetch, NOW + 10 * MIN));
    expect(f.count(DEC)).toBe(1);
    expect(r.errors).toEqual([]);
    // The 7 other December CVEs are new; CVE-2026-21637 is skipped as unchanged.
    // The newest post (October, 10 CVEs) is read on every run and is unchanged too.
    expect(f.count(OCT)).toBe(2);
    expect(r.upserted).toBe(7);
    expect(r.unchanged).toBe(1 + 10);
    expect(await storedFixed("CVE-2026-21637")).toEqual(MARCH_21637);
    expect(await nodePostRow(DEC)).toMatchObject({ state: "ok", parser_rev: NODE_PARSER_REV });

    // December then March, from an empty store.
    await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
    await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
    await clearNodeLedger();
    await readAllBut(DEC, MARCH);
    await nodeRuntime.run(ctxAt(createRuntimeFake(routes()).fetch, NOW + 20 * MIN));
    expect(await storedFixed("CVE-2026-21637")).toEqual(MARCH_21637);
  });
});

describe("parser revision bump through runIngesters (coverage)", () => {
  it("coverage: rev bump: failed (December), empty-with-note, and ok-unemitted (March, June) rows at parser_rev 3 are each read once and become ok with unemitted 0; coverage_since is set and /v1/check?node=22.12.0 lists the December CVEs", async () => {
    expect(POSTS).toHaveLength(48);
    const NOTE = POSTS[10].link;
    await seedNodePosts(
      POSTS.map((p) =>
        p.link === DEC
          ? { url: p.link, published: p.published, state: "failed", attempts: 1, parser_rev: "3", next_check_at: new Date(NOW + 60 * MIN).toISOString() }
          : p.link === NOTE || p.link === NO_UPDATES
            ? { url: p.link, published: p.published, state: "empty", parser_rev: "3" }
            : { url: p.link, published: p.published, state: "ok", parser_rev: "3" },
      ),
    );
    await env.DB.prepare("UPDATE node_runtime_posts SET last_error = 'post incomplete after 10 reads' WHERE url = ?").bind(NOTE).run();
    await env.DB.prepare("UPDATE node_runtime_posts SET last_error = 'no fixed version for 20.x' WHERE url = ?").bind(DEC).run();
    await env.DB.prepare("UPDATE node_runtime_posts SET unemitted = 8 WHERE url = ?").bind(MARCH).run();
    await env.DB.prepare("UPDATE node_runtime_posts SET unemitted = 12 WHERE url = ?").bind(JUNE).run();

    const f = createRuntimeFake(routes());
    const outcomes: SourceOutcome[] = [];
    for (let run = 0; run < 3; run++) {
      const o = await viaRegistry(f.fetch, NOW + run * 10 * MIN);
      outcomes.push(o);
      expect(o.status, `run ${run + 1}`).toBe("ok");
      if (o.status === "ok" && !o.result.deferred) break;
    }
    const last = outcomes[outcomes.length - 1];
    expect(last.status === "ok" ? (last.result.deferred ?? 0) : -1).toBe(0);

    for (const p of POSTS) expect(f.count(p.link), p.link).toBe(1);
    const revs = await env.DB.prepare("SELECT parser_rev, COUNT(*) AS n FROM node_runtime_posts GROUP BY parser_rev").all<{ parser_rev: string; n: number }>();
    expect(revs.results).toEqual([{ parser_rev: NODE_PARSER_REV, n: 48 }]);
    for (const url of [DEC, MARCH, JUNE, NOTE]) {
      const row = await env.DB.prepare("SELECT state, unemitted, last_error FROM node_runtime_posts WHERE url = ?").bind(url).first();
      expect(row, url).toEqual({ state: "ok", unemitted: 0, last_error: null });
    }
    // A8: the 2019 "no updates" post (no CVE id in a heading) stays empty with no note.
    expect(await nodePostRow(NO_UPDATES)).toMatchObject({ state: "empty", last_error: null, parser_rev: NODE_PARSER_REV });

    const src = await env.DB.prepare("SELECT coverage_since, last_error FROM sources WHERE id = 'node-runtime'").first<{ coverage_since: string | null; last_error: string | null }>();
    expect(src?.last_error).toBeNull();
    expect(src?.coverage_since).not.toBeNull();

    const res = await exports.default.fetch("https://tocsin.test/v1/check?node=22.12.0", { headers: { "CF-Connecting-IP": "192.0.2.76" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected: { cve_ids: string[]; fixed_in: string | null }[]; coverage: { ecosystem: string; complete: boolean }[] };
    const byCve = new Map(body.affected.map((a) => [a.cve_ids[0], a.fixed_in]));
    for (const cve of ["CVE-2025-55131", "CVE-2025-55130", "CVE-2025-59465", "CVE-2025-55132"]) expect(byCve.get(cve), cve).toBe("22.22.0");
    // A newer post owns CVE-2026-21637: the March fixed version.
    expect(byCve.get("CVE-2026-21637")).toBe("22.22.2");
    // 24.x and 25.x only: not listed for 22.12.0.
    expect(byCve.has("CVE-2025-59464")).toBe(false);
    expect(byCve.has("CVE-2026-21636")).toBe(false);
    expect(body.coverage).toEqual([expect.objectContaining({ ecosystem: "node", complete: true })]);
  });
});

describe("wordings that give no line (negatives)", () => {
  const section = (sentence: string) => `<main><h2>Fixture issue (CVE-2026-99999) - (high)</h2><p>${sentence}</p><h2>Downloads and release details</h2><ul><li>Node.js v24.1.0</li></ul></main>`;
  it.each([
    "This vulnerability affects all users in active release lines: none",
    "This vulnerability affects all users",
    "This vulnerability affects all End-of-Life release lines: 18.x",
    "Present in active release lines: 24.x",
    "This vulnerability is bad",
    "This vulnerability affects all Node.js versions",
    "This vulnerability is fixed in undici 7.24.4",
    "This vulnerability affects Node.js 24.12.0 users",
    "This vulnerability affects all users of the CVE-2026-21637 fix",
    "This vulnerability affects HTTP/2 users",
    "This vulnerability affects arrays of 2³¹-1 items",
  ])("negatives: %j gives no lines", (sentence) => {
    expect(parseNodeSecurityPost(section(sentence)).cves[0].lines).toEqual([]);
  });

  it.each([
    ["This vulnerability affects HTTP2 users on Node.js 20, 22, 24 and 25.", [20, 22, 24, 25]],
    ["This vulnerability affects one supported release line: Node.js 26 .", [26]],
    ["This vulnerability affects 24.x and 25.x . Thank you, to a reporter.", [24, 25]],
    ["This vulnerability was already fixed on Node.js 24.12.0. It has no impact on other active release lines.", [24]],
  ] as [string, number[]][])("wordings: %j -> %j", (sentence, lines) => {
    expect(parseNodeSecurityPost(section(sentence)).cves[0].lines).toEqual(lines);
  });

  it("negatives: the July post with one Impact line replaced is 1 not emitted, the rest unchanged", () => {
    const sentence = "This vulnerability affects all users in active release lines: 24.x, 22.x";
    expect(julyHtml.split(sentence)).toHaveLength(2);
    const r = norm(JULY, julyHtml.replace(sentence, "This vulnerability is bad"));
    expect(r.notEmitted).toBe(1);
    expect(r.docs).toHaveLength(10);
  });

  it("negatives: 'Node.js versions' takes the lines of the 'Security releases available' sentence only", () => {
    const body = (extra: string) =>
      `<main>${extra}<h2>Fixture issue (CVE-2026-99998) - (medium)</h2><p>This vulnerability affects TLS servers across Node.js versions where callbacks throw.</p></main>`;
    const available = "<h2>Security releases available</h2><p>Updates are now available for the 25.x, 24.x, and 20.x Node.js release lines to address: 1 issue.</p>";
    expect(parseNodeSecurityPost(body(available)).cves[0].lines).toEqual([20, 24, 25]);
    expect(parseNodeSecurityPost(body("")).cves[0].lines).toEqual([]);
  });
});
