import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fetchFeed, fetchPost, NodeHttpError, NodeLinkError } from "../../src/ingest/node-runtime-client";
import { NODE_CURSOR_KEY, normalizeNodePost, nodeRuntime, parseNodeFeed } from "../../src/ingest/node-runtime";
import { decodeEntities, htmlSections } from "../../src/ingest/runtime-text";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import postHtml from "../fixtures/node-runtime/2026-10-21.html?raw";
import indexJson from "../fixtures/node-runtime/index.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { createRuntimeFake, type FakeAnswer } from "./runtime-fake.tcs-6";

// Fixtures: recorded from nodejs.org on 2026-10-22 (tests/fixtures/node-runtime/README.md).
const FEED = "https://nodejs.org/en/feed/vulnerability.xml";
const POST = "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases";
const INDEX = "https://nodejs.org/dist/index.json";
const PUB = "2026-10-21T22:00:00Z";
const NOW = "2026-10-22T16:00:00Z";
// Every CVE heading of the recorded post, with its rating word and release lines.
const CVES: Record<string, { label: string; lines: number[] }> = {
  "CVE-2026-105482": { label: "high", lines: [22, 24, 26] },
  "CVE-2026-105483": { label: "high", lines: [24, 26] },
  "CVE-2026-106069": { label: "high", lines: [22, 24, 26] },
  "CVE-2026-111497": { label: "high", lines: [22, 24, 26] },
  "CVE-2026-105481": { label: "medium", lines: [22, 24, 26] },
  "CVE-2026-106072": { label: "medium", lines: [22, 24, 26] },
  "CVE-2026-106074": { label: "medium", lines: [22, 24, 26] },
  "CVE-2026-106070": { label: "low", lines: [26] },
  "CVE-2026-106071": { label: "low", lines: [26] },
  "CVE-2026-106073": { label: "low", lines: [22, 24, 26] },
};
const FIXED: Record<number, string> = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };
const DIST = new Set((JSON.parse(indexJson) as { version: string }[]).map((e) => e.version));
const PLACEHOLDER_ID = "tcs_00000000000000000000000000";

function routes(over: Record<string, FakeAnswer> = {}): Record<string, FakeAnswer> {
  return { [FEED]: feedXml, [POST]: postHtml, [INDEX]: indexJson, ...over };
}

function ctxFor(fetchFn: typeof fetch, config: Record<string, unknown> = {}): IngestContext {
  return {
    env,
    source: { id: "node-runtime", kind: "node-runtime", config },
    now: () => new Date(NOW),
    fetch: fetchFn,
  };
}

function docsOk(html = postHtml): Advisory[] {
  const r = normalizeNodePost({ link: POST, published: PUB }, html, DIST);
  expect(r.errors).toEqual([]);
  expect(r.incomplete).toBe(false);
  return r.docs.map((d) => ({ id: PLACEHOLDER_ID, ...d }));
}

function byCve(docs: Advisory[], cve: string): Advisory {
  const d = docs.find((x) => x.cve_ids.includes(cve));
  if (!d) throw new Error(`no doc for ${cve}`);
  return d;
}

// Replaces the title of the 2026-10-21 item in an in-test copy of the recorded feed.
function feedWithTitle(title: string): string {
  const before = "<title><![CDATA[Wednesday, October 21, 2026 Security Releases]]></title>";
  expect(feedXml).toContain(before);
  return feedXml.replace(before, `<title><![CDATA[${title}]]></title>`);
}

// Adds one "Security Releases" item with the given link and pubDate to an in-test copy of the recorded feed.
function feedWithExtraItem(link: string, pubDate: string): string {
  const anchor = "<item>";
  expect(feedXml).toContain(anchor);
  const item = `<item>\n<title><![CDATA[Thursday, October 22, 2026 Security Releases]]></title>\n<link>${link}</link>\n<pubDate>${pubDate}</pubDate>\n</item>\n`;
  return feedXml.replace(anchor, item + anchor);
}

async function nodeRowCount(): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')",
  ).first<{ n: number }>();
  return r!.n;
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Every nodejs.org read in this file goes through the fake: 0 real network calls.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

// Each test starts with no node-runtime rows and a cursor before the 2026-10-21 post.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.CURSORS.put(NODE_CURSOR_KEY, "2026-10-01T00:00:00Z");
});

describe("runtime text helpers (text)", () => {
  it("text: decodes named and numeric entities", () => {
    expect(decodeEntities("It&#x27;s &amp; &lt;b&gt; &quot;x&quot; &#39;y&#39; &#8212;")).toBe(`It's & <b> "x" 'y' —`);
  });

  it("text: reads CDATA titles, links and pubDates from the recorded feed", () => {
    const items = parseNodeFeed(feedXml);
    expect(items.length).toBeGreaterThan(5);
    expect(items[0]).toEqual({ title: "Wednesday, October 21, 2026 Security Releases", link: POST, published: PUB });
  });

  it("text: splits the recorded post on h1/h2 headings", () => {
    const heads = htmlSections(postHtml).map((s) => s.heading);
    expect(heads[0]).toBe("Wednesday, October 21, 2026 Security Releases");
    expect(heads).toContain("Node.js Brotli decoder out-of-bounds write permits remote code execution (CVE-2026-111497) - (high)");
    expect(heads).toContain("Downloads and release details");
    expect(heads.indexOf("Summary")).toBeGreaterThan(heads.indexOf("Downloads and release details"));
  });
});

describe("node-runtime seam (seam)", () => {
  it("seam: a non-2xx answer throws NodeHttpError with the status and URL", async () => {
    const fake = createRuntimeFake({ [FEED]: { status: 502 } });
    const err = await fetchFeed(fake.fetch, FEED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeHttpError);
    expect((err as NodeHttpError).status).toBe(502);
    expect((err as NodeHttpError).url).toBe(FEED);
  });

  it("seam: the fake throws on an unmapped URL", async () => {
    const fake = createRuntimeFake({});
    await expect(fetchFeed(fake.fetch, FEED)).rejects.toThrow(/unexpected URL/);
  });
});

describe("normalizeNodePost (normalize)", () => {
  it("N1: CVE-2026-111497 has 3 per-line ranges, fixed 22.23.4/24.22.1/26.12.1, label high, a one-line summary", () => {
    const d = byCve(docsOk(), "CVE-2026-111497");
    expect(d.fixed_versions).toEqual(["22.23.4", "24.22.1", "26.12.1"]);
    expect(d.severity).toEqual({ label: "high" });
    expect(d.affected).toHaveLength(3);
    expect(d.affected).toContainEqual({ introduced: "24.0.0", fixed: "24.22.1" });
    expect(d.affected).toEqual([
      { introduced: "22.0.0", fixed: "22.23.4" },
      { introduced: "24.0.0", fixed: "24.22.1" },
      { introduced: "26.0.0", fixed: "26.12.1" },
    ]);
    expect(d.summary).toMatch(/^[^\r\n]+$/);
    expect(d.summary.length).toBeLessThan(200);
    expect(d.summary).toBe("Node.js Brotli decoder out-of-bounds write permits remote code execution");
    expect(d.ecosystem).toBe("node");
    expect(d.component).toBe("node");
    expect(d.cve_ids).toEqual(["CVE-2026-111497"]);
    expect(d.sources[0]).toEqual({ source: "node-runtime", source_id: "CVE-2026-111497", url: POST });
    expect(d.references).toEqual([POST]);
    expect(d.published_at).toBe(PUB);
    expect(d.modified_at).toBe(PUB);
    const v = validateAdvisory(d);
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("N2: every CVE heading is emitted once, with its rating word and its lines", () => {
    const docs = docsOk();
    expect(docs.map((d) => d.cve_ids[0]).sort()).toEqual(Object.keys(CVES).sort());
    for (const [cve, want] of Object.entries(CVES)) {
      const d = byCve(docs, cve);
      expect(d.severity.label, cve).toBe(want.label);
      expect(d.affected, cve).toEqual(want.lines.map((l) => ({ introduced: `${l}.0.0`, fixed: FIXED[l] })));
      expect(d.fixed_versions, cve).toEqual(want.lines.map((l) => FIXED[l]));
      const v = validateAdvisory(d);
      expect(v.ok ? [] : v.errors, cve).toEqual([]);
    }
    const one = byCve(docs, "CVE-2026-106070");
    expect(one.affected).toHaveLength(1);
    expect(one.action).toBe("Upgrade node to 26.12.1 or later.");
  });

  it("N3: the action lists the fixed version of each line", () => {
    expect(byCve(docsOk(), "CVE-2026-111497").action).toBe("Upgrade node to 22.23.4 (22.x), 24.22.1 (24.x) or 26.12.1 (26.x) or later.");
    expect(byCve(docsOk(), "CVE-2026-105483").action).toBe("Upgrade node to 24.22.1 (24.x) or 26.12.1 (26.x) or later.");
  });

  it("normalize: a CVE heading with no rating suffix is not emitted and is reported (source: assumed, in-test edit)", () => {
    const html = postHtml.replace("(CVE-2026-105482) - (high)</a></h2>", "(CVE-2026-105482)</a></h2>");
    expect(html).not.toBe(postHtml);
    const r = normalizeNodePost({ link: POST, published: PUB }, html, DIST);
    expect(r.incomplete).toBe(false);
    expect(r.docs.map((d) => d.cve_ids[0])).not.toContain("CVE-2026-105482");
    expect(r.docs).toHaveLength(9);
    expect(r.errors.join("\n")).toContain("CVE-2026-105482");
  });

  it("normalize: a fixed version missing from the dist index makes the post incomplete", () => {
    const dist = new Set([...DIST].filter((v) => v !== "v24.22.1"));
    const r = normalizeNodePost({ link: POST, published: PUB }, postHtml, dist);
    expect(r.incomplete).toBe(true);
    expect(r.docs).toEqual([]);
    expect(r.errors.join("\n")).toContain("24.22.1");
  });

  it("normalize: a line with no fixed version in the downloads list makes the post incomplete (source: assumed, in-test edit)", () => {
    const html = postHtml.replace('<li><a href="/en/blog/release/v22.23.4/">Node.js v22.23.4</a></li>', "");
    expect(html).not.toBe(postHtml);
    const r = normalizeNodePost({ link: POST, published: PUB }, html, DIST);
    expect(r.incomplete).toBe(true);
    expect(r.docs).toEqual([]);
    expect(r.errors.join("\n")).toContain("22.x");
  });
});

describe("nodeRuntime.run (run)", () => {
  it("N4: run stores 10 advisories and sets the cursor to the post pubDate", async () => {
    const fake = createRuntimeFake(routes());
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(10);
    expect(res.unchanged).toBe(0);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);
    expect(fake.urls()).toEqual([FEED, INDEX, POST]);
    const row = await env.DB.prepare(
      "SELECT a.ecosystem, a.component, a.severity_label FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = 'node-runtime' AND s.source_id = 'CVE-2026-111497'",
    ).first<{ ecosystem: string; component: string; severity_label: string }>();
    expect(row).toEqual({ ecosystem: "node", component: "node", severity_label: "high" });
    expect(await nodeRowCount()).toBe(10);
  });

  it("N4b: with no cursor, the backfill window from config picks the post", async () => {
    await env.CURSORS.delete(NODE_CURSOR_KEY);
    const fake = createRuntimeFake(routes());
    const res = await nodeRuntime.run(ctxFor(fake.fetch, { backfill_days: 30 }));
    expect(res.upserted).toBe(10);
    expect(fake.count(POST)).toBe(1);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);
  });

  it("N5: re-run on the same fixtures yields unchanged for every advisory and no new rows", async () => {
    await nodeRuntime.run(ctxFor(createRuntimeFake(routes()).fetch));
    const before = await nodeRowCount();
    const res = await nodeRuntime.run(ctxFor(createRuntimeFake(routes()).fetch));
    expect(res.errors).toEqual([]);
    expect(res.unchanged).toBe(10);
    expect(res.upserted).toBe(0);
    expect(await nodeRowCount()).toBe(before);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);
  });

  it("N6 cursor: a cursor after the post skips it: 1 fetch (feed only), 0 upserts", async () => {
    await env.CURSORS.put(NODE_CURSOR_KEY, "2026-10-22T00:00:00Z");
    const fake = createRuntimeFake(routes());
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(fake.urls()).toEqual([FEED]);
    expect(res.upserted + res.unchanged).toBe(0);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe("2026-10-22T00:00:00Z");
  });

  it("N7 cursor: a cursor equal to the post pubDate re-reads the post", async () => {
    await nodeRuntime.run(ctxFor(createRuntimeFake(routes()).fetch));
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe(PUB);
    const fake = createRuntimeFake(routes());
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(fake.count(POST)).toBe(1);
    expect(res.unchanged).toBe(10);
  });

  it("N8: an index without v24.22.1 stores nothing, names 24.22.1 and leaves the cursor", async () => {
    const index = JSON.stringify((JSON.parse(indexJson) as { version: string }[]).filter((e) => e.version !== "v24.22.1"));
    const res = await nodeRuntime.run(ctxFor(createRuntimeFake(routes({ [INDEX]: index })).fetch));
    expect(res.upserted).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("24.22.1");
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe("2026-10-01T00:00:00Z");
    expect(await nodeRowCount()).toBe(0);
  });

  it.each(["Node.js v24.22.0 (LTS)", "Node.js 26.12.0 (Current)", "March 2026 HashDoS"])(
    "N9: title %j does not start a post read (source: assumed, in-test edit)",
    async (title) => {
      const fake = createRuntimeFake(routes({ [FEED]: feedWithTitle(title) }));
      const res = await nodeRuntime.run(ctxFor(fake.fetch));
      expect(fake.urls()).toEqual([FEED]);
      expect(res.upserted).toBe(0);
    },
  );

  it("N9b: a lowercase 'security release' title still matches (source: assumed, in-test edit)", async () => {
    const fake = createRuntimeFake(routes({ [FEED]: feedWithTitle("october 2026 security release") }));
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(fake.count(POST)).toBe(1);
    expect(res.upserted).toBe(10);
  });

  it("N10: a 503 on the post throws NodeHttpError and leaves the cursor", async () => {
    const fake = createRuntimeFake(routes({ [POST]: { status: 503 } }));
    await expect(nodeRuntime.run(ctxFor(fake.fetch))).rejects.toBeInstanceOf(NodeHttpError);
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe("2026-10-01T00:00:00Z");
  });

  it("N11 F2: a feed item linking off nodejs.org is not fetched, is reported, and does not stop the real post (source: assumed, in-test edit)", async () => {
    const evil = "https://evil.example/post";
    const fake = createRuntimeFake(routes({ [FEED]: feedWithExtraItem(evil, "Thu, 22 Oct 2026 01:00:00 GMT") }));
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(fake.urls().filter((u) => u.includes("evil.example"))).toEqual([]);
    expect(fake.urls()).toEqual([FEED, INDEX, POST]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain(evil);
    expect(res.errors[0]).toContain("https://nodejs.org");
    expect(res.upserted).toBe(10);
    expect(await nodeRowCount()).toBe(10);
    // The off-origin post counts as done: the cursor reaches the newest post date.
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe("2026-10-22T01:00:00Z");
  });

  it("N11 F2: an http:// link on nodejs.org is refused for an https feed (source: assumed, in-test edit)", async () => {
    const plain = POST.replace("https://", "http://");
    const fake = createRuntimeFake(routes({ [FEED]: feedWithExtraItem(plain, "Thu, 22 Oct 2026 01:00:00 GMT") }));
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(fake.count(plain)).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain(plain);
  });

  it("N11 F2 near miss: a nodejs.org link with a query string is read (source: assumed, in-test edit)", async () => {
    const withQuery = `${POST}?x=1`;
    const fake = createRuntimeFake(routes({ [FEED]: feedWithExtraItem(withQuery, "Thu, 22 Oct 2026 01:00:00 GMT"), [withQuery]: postHtml }));
    const res = await nodeRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(fake.count(withQuery)).toBe(1);
    expect(res.upserted + res.unchanged).toBe(20);
  });

  it("F2 seam: fetchPost throws NodeLinkError for another origin and makes no call", async () => {
    const fake = createRuntimeFake(routes());
    await expect(fetchPost(fake.fetch, "https://evil.example/post", "https://nodejs.org")).rejects.toBeInstanceOf(NodeLinkError);
    expect(fake.calls).toHaveLength(0);
    await expect(fetchPost(fake.fetch, POST, "https://nodejs.org")).resolves.toBe(postHtml);
  });

  it("config: a bad config value throws before any fetch", async () => {
    const fake = createRuntimeFake(routes());
    await expect(nodeRuntime.run(ctxFor(fake.fetch, { max_posts: 0 }))).rejects.toThrow(/max_posts/);
    await expect(nodeRuntime.run(ctxFor(fake.fetch, { feed_url: "ftp://x" }))).rejects.toThrow(/feed_url/);
    expect(fake.calls).toHaveLength(0);
  });
});
