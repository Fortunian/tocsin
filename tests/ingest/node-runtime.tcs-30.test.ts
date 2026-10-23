import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import {
  isNodePreAnnouncement,
  NODE_CURSOR_KEY,
  NODE_PARSER_KEY,
  NODE_PARSER_REV,
  normalizeNodePost,
  nodeRuntime,
  parseNodeSecurityPost,
} from "../../src/ingest/node-runtime";
import { runIngesters } from "../../src/ingest/registry";
import type { IngestContext } from "../../src/ingest/types";
import { loadStatus } from "../../src/site/data";
import julyHtml from "../fixtures/node-runtime/2026-07-29.html?raw";
import preHtml from "../fixtures/node-runtime/2026-10-14-pre.html?raw";
import octHtml from "../fixtures/node-runtime/2026-10-21.html?raw";
import indexJuly from "../fixtures/node-runtime/index-since-2026-07.json?raw";
import indexJson from "../fixtures/node-runtime/index.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { createRuntimeFake, type FakeAnswer } from "./runtime-fake.tcs-6";

// TCS-30. Fixtures: recorded from nodejs.org and web.archive.org (tests/fixtures/node-runtime/README.md).
const FEED = "https://nodejs.org/en/feed/vulnerability.xml";
const OCT = "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases";
const JULY = "https://nodejs.org/en/blog/vulnerability/july-2026-security-releases";
const INDEX = "https://nodejs.org/dist/index.json";
const PUB = "2026-10-21T22:00:00Z";
const JULY_PUB = "2026-07-29T00:00:00Z";
const START = "2026-10-01T00:00:00Z";
const NOW = "2026-10-22T16:00:00Z";
const ETAG = '"45b4cc5ffeb4ba28564a5872331d3d40"';
const DIST_JULY = new Set((JSON.parse(indexJuly) as { version: string }[]).map((e) => e.version));
const MIN = 60_000;

// Every CVE heading of the recorded July post with its release lines, read from
// the fixture text. CVE-2026-56847 is the "users of the Permission Model" wording.
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

interface IndexCall {
  ifNoneMatch: string | undefined;
  status: number;
}

// The URL-map fake plus a conditional dist index: 200 with an ETag, or 304
// with no body when If-None-Match carries that ETag. Each index body has its own ETag.
function fakeWith(over: Record<string, FakeAnswer> = {}, index = indexJson) {
  const etag = index === indexJson ? ETAG : `"len-${index.length}"`;
  const base = createRuntimeFake({ [FEED]: feedXml, [OCT]: octHtml, ...over });
  const indexCalls: IndexCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== INDEX) return base.fetch(input, init);
    const inm = new Headers(init?.headers).get("If-None-Match") ?? undefined;
    const status = inm === etag ? 304 : 200;
    indexCalls.push({ ifNoneMatch: inm, status });
    return status === 304 ? new Response(null, { status: 304 }) : new Response(index, { status: 200, headers: { ETag: etag } });
  }) as typeof fetch;
  return { fetch: fetchFn, base, indexCalls };
}

function ctxAt(fetchFn: typeof fetch, now: string | number = NOW, config: Record<string, unknown> = {}): IngestContext {
  return { env, source: { id: "node-runtime", kind: "node-runtime", config }, now: () => new Date(now), fetch: fetchFn };
}

// One h2 CVE section with the given affects sentence (source: assumed, in-test edit).
function section(sentence: string): string {
  return `<main><h2>Thing breaks (CVE-2026-99999) - (high)</h2><p>${sentence}</p><h2>Downloads and release details</h2><ul><li>Node.js v24.22.1</li></ul></main>`;
}

async function nodeRowCount(): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')",
  ).first<{ n: number }>();
  return r!.n;
}

async function nodeSourceRow() {
  return env.DB.prepare("SELECT last_run_at, last_ok_at, last_error FROM sources WHERE id = 'node-runtime'").first<{
    last_run_at: string | null;
    last_ok_at: string | null;
    last_error: string | null;
  }>();
}

// runIngesters calls globalThis.fetch: point it at the fake for one call, 0 network calls.
async function viaRegistry(fetchFn: typeof fetch, now = NOW) {
  fetchSpy.mockImplementation(fetchFn);
  try {
    return await runIngesters(env, { "node-runtime": nodeRuntime }, () => new Date(now));
  } finally {
    // Clears the recorded calls and puts the real fetch back.
    fetchSpy.mockReset();
  }
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Outside viaRegistry no test calls globalThis.fetch; inside it the spy answers from the fake.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

// Each test starts with no node-runtime rows, a cursor before the October post,
// no cached dist index and the current parser revision (T5 cases override it).
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.DB.prepare("UPDATE sources SET last_run_at = NULL, last_ok_at = NULL, last_error = NULL, config_json = '{}' WHERE id = 'node-runtime'").run();
  await env.CURSORS.put(NODE_CURSOR_KEY, START);
  await env.CURSORS.delete(NODE_DIST_KEY);
  await env.CURSORS.put(NODE_PARSER_KEY, NODE_PARSER_REV);
});

describe("AFFECTS wordings (affects)", () => {
  it.each([
    ["affects Node.js 24.x, 22.x", [22, 24]],
    ["This vulnerability affects all users in active release lines: 24.x, 22.x", [22, 24]],
    ["This vulnerability affects all users of the Permission Model in active release lines: 26.x, 24.x, 22.x", [22, 24, 26]],
    ["This vulnerability affects all active release lines: 24.x, 22.x, 20.x", [20, 22, 24]],
  ])("affects: %j -> %j", (sentence, lines) => {
    const p = parseNodeSecurityPost(section(sentence));
    expect(p.cves).toHaveLength(1);
    expect(p.cves[0].lines).toEqual(lines);
  });

  it.each([
    "This vulnerability affects all users in active release lines: none",
    "This vulnerability affects all users",
    "This vulnerability affects all End-of-Life release lines: 18.x",
    "Present in active release lines: 24.x",
  ])("affects: %j gives no lines (source: assumed)", (sentence) => {
    expect(parseNodeSecurityPost(section(sentence)).cves[0].lines).toEqual([]);
  });
});

describe("July post (july)", () => {
  it("July: the recorded July post yields 11 advisories with the right lines and fixed versions", () => {
    const r = normalizeNodePost({ link: JULY, published: JULY_PUB }, julyHtml, DIST_JULY);
    expect(r.errors).toEqual([]);
    expect(r.incomplete).toBe(false);
    expect(r.docs.map((d) => d.cve_ids[0]).sort()).toEqual(Object.keys(JULY_CVES).sort());
    for (const [cve, lines] of Object.entries(JULY_CVES)) {
      const d = r.docs.find((x) => x.cve_ids[0] === cve)!;
      expect(d.affected, cve).toEqual(lines.map((l) => ({ introduced: `${l}.0.0`, fixed: JULY_FIXED[l] })));
    }
  });
});

describe("pre-announcement (pre-announcement)", () => {
  it("pre-announcement: the recorded 2026-10-14 post is one; the October and July release posts are not", () => {
    expect(isNodePreAnnouncement(preHtml)).toBe(true);
    expect(isNodePreAnnouncement(octHtml)).toBe(false);
    expect(isNodePreAnnouncement(julyHtml)).toBe(false);
  });

  it("pre-announcement: normalizeNodePost gives 0 docs and no error for the recorded post", () => {
    const r = normalizeNodePost({ link: OCT, published: PUB }, preHtml, new Set());
    expect(r).toMatchObject({ docs: [], errors: [], incomplete: false, preAnnouncement: true });
  });

  it.each([
    ["<main><h2>Summary</h2><p>This is a pre-announcement of security releases.</p></main>", true],
    ["<main><h2>Summary</h2><p>Releases will be released on Tuesday.</p></main>", true],
    ["<main><h2>Summary</h2><p>Nothing to see.</p></main>", false],
    ["<main><h2>Summary</h2><p>This is a pre-announcement.</p><h2>Thing (CVE-2026-1234)</h2></main>", false],
  ])("pre-announcement: in-test post %j -> %j (source: assumed)", (html, skip) => {
    expect(isNodePreAnnouncement(html)).toBe(skip);
  });

  it("pre-announcement: no CVE headings and no marker is still the error 'no CVE headings' (source: assumed)", () => {
    const r = normalizeNodePost({ link: OCT, published: PUB }, "<main><h2>Summary</h2><p>Nothing to see.</p></main>", new Set());
    expect(r.errors).toEqual([`${OCT}: no CVE headings`]);
  });

  it("pre-announcement: a marker plus an unrated CVE heading is an error, not a skip (source: assumed)", () => {
    const r = normalizeNodePost({ link: OCT, published: PUB }, "<main><h2>Summary</h2><p>This is a pre-announcement.</p><h2>Thing (CVE-2026-1234)</h2></main>", new Set());
    expect(r.preAnnouncement).toBe(false);
    expect(r.errors.join("\n")).toContain("CVE-2026-1234");
  });

  it("pre-announcement run: 0 advisories, no error, cursor unchanged, no dist index read; the release post then yields 10", async () => {
    const pre = fakeWith({ [OCT]: preHtml });
    const r1 = await nodeRuntime.run(ctxAt(pre.fetch));
    expect(r1.errors).toEqual([]);
    expect(r1.upserted + r1.unchanged).toBe(0);
    expect(pre.indexCalls).toHaveLength(0);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(START);
    expect(r1.summary).toBe("october-2026-security-releases: pre-announcement, read again next run");
    expect(await nodeRowCount()).toBe(0);

    const rel = fakeWith();
    const r2 = await nodeRuntime.run(ctxAt(rel.fetch, Date.parse(NOW) + 10 * MIN));
    expect(r2.errors).toEqual([]);
    expect(r2.upserted).toBe(10);
    expect(rel.base.count(OCT)).toBe(1);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);
    expect(await nodeRowCount()).toBe(10);
  });

  it("pre-announcement through runIngesters: the source is ok, last_ok_at = last_run_at = now, last_error NULL; status shape unchanged", async () => {
    await env.DB.prepare("UPDATE sources SET last_error = 'old failure' WHERE id = 'node-runtime'").run();
    const out = await viaRegistry(fakeWith({ [OCT]: preHtml }).fetch);
    expect(out.find((o) => o.source === "node-runtime")?.status).toBe("ok");
    const at = new Date(NOW).toISOString();
    expect(await nodeSourceRow()).toEqual({ last_run_at: at, last_ok_at: at, last_error: null });

    // status shape: the loader behind GET /v1/status.
    const node = (await loadStatus(env.DB)).sources.find((s) => s.id === "node-runtime")!;
    // TCS-32 added coverage_since to every status source.
    expect(Object.keys(node).sort()).toEqual(["coverage_since", "id", "kind", "last_error", "last_ok_at", "last_run_at", "last_warning"]);
    expect(node.last_error).toBeNull();
  });
});

describe("dist index cache (dist index)", () => {
  it("dist index: two runs 30 min apart read it once; a run after the TTL sends If-None-Match, a 304 reuses the cache", async () => {
    const f = fakeWith();
    const r1 = await nodeRuntime.run(ctxAt(f.fetch));
    expect(r1.upserted).toBe(10);
    const r2 = await nodeRuntime.run(ctxAt(f.fetch, Date.parse(NOW) + 30 * MIN));
    expect(r2.unchanged).toBe(10);
    expect(f.indexCalls).toEqual([{ ifNoneMatch: undefined, status: 200 }]);

    const r3 = await nodeRuntime.run(ctxAt(f.fetch, Date.parse(NOW) + 61 * MIN));
    expect(r3.errors).toEqual([]);
    expect(r3.unchanged).toBe(10);
    expect(f.indexCalls).toEqual([
      { ifNoneMatch: undefined, status: 200 },
      { ifNoneMatch: ETAG, status: 304 },
    ]);
    const cached = JSON.parse((await env.CURSORS.get(NODE_DIST_KEY))!) as { etag: string; fetched_at: string; versions: string[] };
    expect(cached.etag).toBe(ETAG);
    expect(cached.fetched_at).toBe(new Date(Date.parse(NOW) + 61 * MIN).toISOString());
    expect(cached.versions).toContain("v24.22.1");

    // The 304 refreshed the window: 30 min later there is no read.
    await nodeRuntime.run(ctxAt(f.fetch, Date.parse(NOW) + 91 * MIN));
    expect(f.indexCalls).toHaveLength(2);
  });

  it("dist index: the TTL is the knob sources.config_json.dist_cache_seconds", async () => {
    const f = fakeWith();
    await nodeRuntime.run(ctxAt(f.fetch, NOW, { dist_cache_seconds: 600 }));
    await nodeRuntime.run(ctxAt(f.fetch, Date.parse(NOW) + 11 * MIN, { dist_cache_seconds: 600 }));
    expect(f.indexCalls.map((c) => c.status)).toEqual([200, 304]);
  });

  it("dist index: a fresh cache without a needed version is read again in the same run", async () => {
    const stale = [...(JSON.parse(indexJson) as { version: string }[]).map((e) => e.version)].filter((v) => v !== "v24.22.1");
    await env.CURSORS.put(NODE_DIST_KEY, JSON.stringify({ etag: '"old"', fetched_at: new Date(Date.parse(NOW) - MIN).toISOString(), versions: stale }));
    const f = fakeWith();
    const r = await nodeRuntime.run(ctxAt(f.fetch));
    expect(r.errors).toEqual([]);
    expect(r.upserted).toBe(10);
    expect(f.indexCalls).toEqual([{ ifNoneMatch: '"old"', status: 200 }]);
    const cached = JSON.parse((await env.CURSORS.get(NODE_DIST_KEY))!) as { versions: string[] };
    expect(cached.versions).toContain("v24.22.1");
  });

  it("dist index: an origin index that lacks the version leaves the post incomplete after one forced read", async () => {
    const without = JSON.stringify((JSON.parse(indexJson) as { version: string }[]).filter((e) => e.version !== "v24.22.1"));
    const f = fakeWith({}, without);
    const r = await nodeRuntime.run(ctxAt(f.fetch));
    expect(r.upserted).toBe(0);
    expect(r.errors.join("\n")).toContain("24.22.1");
    expect(f.indexCalls).toHaveLength(1);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(START);
  });
});

describe("per-post summary (summary)", () => {
  it("summary: through runIngesters, last_error starts with a count per post before the detail", async () => {
    await env.CURSORS.put(NODE_CURSOR_KEY, "2026-07-01T00:00:00Z");
    const sentence = "This vulnerability affects all users in active release lines: 24.x, 22.x";
    expect(julyHtml.split(sentence)).toHaveLength(2);
    const july = julyHtml.replace(sentence, "This vulnerability is bad");
    const out = await viaRegistry(fakeWith({ [JULY]: july }, indexJuly).fetch);
    expect(out.find((o) => o.source === "node-runtime")?.status).toBe("failed");
    const row = await nodeSourceRow();
    expect(row?.last_error).toMatch(
      /^july-2026-security-releases: 10 ok, 1 not emitted; october-2026-security-releases: 10 ok \| 1 record error\(s\): https:\/\/nodejs\.org\/en\/blog\/vulnerability\/july-2026-security-releases: CVE-2026-56846: no affected release lines, not emitted$/,
    );
    expect(await nodeRowCount()).toBe(20);
  });

  it("summary: an ok run does not write last_error", async () => {
    await viaRegistry(fakeWith().fetch);
    expect((await nodeSourceRow())?.last_error).toBeNull();
  });
});

describe("parser revision (parser revision)", () => {
  it("parser revision: with no revision key, a cursor past July still reads the July post once; the next run does not", async () => {
    await env.CURSORS.put(NODE_CURSOR_KEY, PUB);
    await env.CURSORS.delete(NODE_PARSER_KEY);
    const f = fakeWith({ [JULY]: julyHtml }, indexJuly);
    const r1 = await nodeRuntime.run(ctxAt(f.fetch));
    expect(r1.errors).toEqual([]);
    expect(r1.upserted).toBe(21);
    expect(await nodeRowCount()).toBe(21);
    expect(await env.CURSORS.get(NODE_PARSER_KEY)).toBe(NODE_PARSER_REV);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);

    const r2 = await nodeRuntime.run(ctxAt(f.fetch, Date.parse(NOW) + 10 * MIN));
    expect(r2.unchanged).toBe(10);
    expect(f.base.count(JULY)).toBe(1);
  });

  it("parser revision: an incomplete July post during the re-read is read again on the next run", async () => {
    await env.CURSORS.put(NODE_CURSOR_KEY, PUB);
    await env.CURSORS.delete(NODE_PARSER_KEY);
    const r1 = await nodeRuntime.run(ctxAt(fakeWith({ [JULY]: julyHtml }, indexJson).fetch));
    expect(r1.upserted).toBe(0);
    expect(r1.errors.join("\n")).toContain("post incomplete");

    const f = fakeWith({ [JULY]: julyHtml }, indexJuly);
    const r2 = await nodeRuntime.run(ctxAt(f.fetch, Date.parse(NOW) + 10 * MIN));
    expect(f.base.count(JULY)).toBe(1);
    expect(r2.upserted).toBe(21);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);
  });
});
