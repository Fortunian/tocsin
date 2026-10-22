import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KEV_SQL, KevFormatError, KevHttpError, kev, kevCves } from "../../src/ingest/kev";
import type { AdvisoryInput, IngestContext } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import kevFeed from "../fixtures/kev/feed.json";
import { createKevFake, FAKE_KEV_URL, type SimpleFake } from "./enrich-fake.tcs-7";

// Every KEV read goes through the fake: 0 real network calls in this file.
let refused = 0;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    refused += 1;
    throw new Error(`real network call refused: ${String(input)}`);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  expect(refused).toBe(0);
  vi.restoreAllMocks();
});

let seq = 0;
let cveSeq = 820000;
function newCve(): string {
  cveSeq += 1;
  return `CVE-2026-${cveSeq}`;
}

interface Row {
  id: string;
  cve_primary: string | null;
  exploited: number;
  doc_json: string;
  cursor: number;
}

async function seed(cves: string[]): Promise<Row> {
  seq += 1;
  const sourceId = `GHSA-fixture-tcs7-kev-${seq}`;
  const doc: AdvisoryInput = {
    cve_ids: cves,
    ecosystem: "npm",
    component: `fixture-kev-${seq}`,
    affected: [{ introduced: "0", fixed: "1.0.1" }],
    fixed_versions: ["1.0.1"],
    severity: { score: 9.8, label: "critical" },
    exploited: false,
    published_at: "2026-10-20T00:00:00Z",
    modified_at: "2026-10-20T00:00:00Z",
    summary: "Fixture advisory.",
    action: "Upgrade to 1.0.1 or later.",
    references: [`https://osv.dev/vulnerability/${sourceId}`],
    sources: [{ source: "osv", source_id: sourceId, url: `https://osv.dev/vulnerability/${sourceId}` }],
  };
  await upsertAdvisory(env.DB, doc, { source: "osv", source_id: sourceId });
  const row = await env.DB.prepare(
    "SELECT a.id, a.cve_primary, a.exploited, a.doc_json, a.cursor FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
  )
    .bind(sourceId)
    .first<Row>();
  if (!row) throw new Error("seed failed");
  return row;
}

async function reread(id: string): Promise<Row> {
  const row = await env.DB.prepare("SELECT id, cve_primary, exploited, doc_json, cursor FROM advisories WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

function feed(cves: string[]): unknown {
  const entry = kevFeed.vulnerabilities[1];
  return { ...kevFeed, count: cves.length, vulnerabilities: cves.map((c) => ({ ...entry, cveID: c })) };
}

function ctx(fake: SimpleFake, config: Record<string, unknown> = {}): IngestContext {
  return {
    env,
    source: { id: "kev", kind: "kev", config: { feed_url: FAKE_KEV_URL, ...config } },
    now: () => new Date("2026-10-22T14:00:00Z"),
    fetch: fake.fetch,
  };
}

describe("kev ingester", () => {
  it("a feed with one matching CVE sets exploited=true, appends the kev source and bumps the cursor", async () => {
    const cve = newCve();
    const other = newCve();
    const hit = await seed([cve]);
    const miss = await seed([other]);
    const fake = createKevFake({ body: feed([cve, "CVE-2026-90011"]) });
    const result = await kev.run(ctx(fake));
    expect(fake.calls).toEqual([FAKE_KEV_URL]);
    expect(result).toMatchObject({ fetched: 1, upserted: 1, errors: [] });

    const after = await reread(hit.id);
    expect(after.exploited).toBe(1);
    expect(after.cursor).toBeGreaterThan(hit.cursor);
    const doc = JSON.parse(after.doc_json) as Advisory;
    expect(doc.exploited).toBe(true);
    expect(doc.sources[0]).toEqual((JSON.parse(hit.doc_json) as Advisory).sources[0]);
    expect(doc.sources[doc.sources.length - 1]).toEqual({ source: "kev", source_id: cve, url: FAKE_KEV_URL });
    expect(validateAdvisory(doc).ok).toBe(true);
    expect(await reread(miss.id)).toEqual(miss);
  });

  it("a second run over the same feed writes nothing (cursor and doc unchanged)", async () => {
    const cve = newCve();
    const row = await seed([cve]);
    await kev.run(ctx(createKevFake({ body: feed([cve]) })));
    const once = await reread(row.id);
    const result = await kev.run(ctx(createKevFake({ body: feed([cve]) })));
    expect(result.upserted).toBe(0);
    expect(await reread(row.id)).toEqual(once);
  });

  it("a feed with no matching CVE changes no row", async () => {
    const rows = [await seed([newCve()]), await seed([newCve()]), await seed([])];
    const result = await kev.run(ctx(createKevFake()));
    expect(result.upserted).toBe(0);
    for (const r of rows) expect(await reread(r.id)).toEqual(r);
  });

  it("near misses do not match: a CVE prefix, a lowercase id in the feed, a null cve_primary", async () => {
    const prefixRow = await seed(["CVE-2021-4422"]);
    const lowerRow = await seed(["CVE-2026-90012"]);
    const nullRow = await seed([]);
    // The fixture feed lists CVE-2021-44228 and lowercase cve-2026-90012.
    const result = await kev.run(ctx(createKevFake()));
    expect(result.upserted).toBe(0);
    expect(await reread(prefixRow.id)).toEqual(prefixRow);
    expect(await reread(lowerRow.id)).toEqual(lowerRow);
    expect(await reread(nullRow.id)).toEqual(nullRow);
  });

  it("kevCves keeps only well-formed upper-case CVE ids from the fixture feed", () => {
    expect(kevCves(kevFeed)).toEqual(["CVE-2021-44228", "CVE-2026-90011", "CVE-2026-90013"]);
    expect(kevCves({ vulnerabilities: [{ cveID: "CVE-21-1" }, { cveID: 7 }, null, { cveID: "CVE-2026-90011 " }] })).toEqual([]);
  });

  it("the fixture's real Log4Shell entry flags a matching advisory", async () => {
    const row = await seed(["CVE-2021-44228"]);
    await kev.run(ctx(createKevFake()));
    expect((await reread(row.id)).exploited).toBe(1);
  });

  it("HTTP 500 throws KevHttpError and changes no row", async () => {
    const cve = newCve();
    const row = await seed([cve]);
    await expect(kev.run(ctx(createKevFake({ status: 500 })))).rejects.toBeInstanceOf(KevHttpError);
    expect(await reread(row.id)).toEqual(row);
  });

  it("a body without vulnerabilities throws KevFormatError and changes no row", async () => {
    const row = await seed([newCve()]);
    await expect(kev.run(ctx(createKevFake({ body: { title: "x" } })))).rejects.toBeInstanceOf(KevFormatError);
    await expect(kev.run(ctx(createKevFake({ body: "<html>not json</html>" })))).rejects.toBeInstanceOf(KevFormatError);
    expect(await reread(row.id)).toEqual(row);
  });

  it("max_updates_per_run 1 with 2 matches: 1 written now, the other next run", async () => {
    const a = newCve();
    const b = newCve();
    const ra = await seed([a]);
    const rb = await seed([b]);
    const first = await kev.run(ctx(createKevFake({ body: feed([a, b]) }), { max_updates_per_run: 1 }));
    expect(first.upserted).toBe(1);
    expect(first.deferred).toBe(1);
    const flagged = [(await reread(ra.id)).exploited, (await reread(rb.id)).exploited];
    expect(flagged.sort()).toEqual([0, 1]);
    const second = await kev.run(ctx(createKevFake({ body: feed([a, b]) }), { max_updates_per_run: 1 }));
    expect(second.upserted).toBe(1);
    expect(second.deferred).toBe(0);
    expect((await reread(ra.id)).exploited).toBe(1);
    expect((await reread(rb.id)).exploited).toBe(1);
  });

  it("matches more than one bind chunk (200 CVEs in the feed)", async () => {
    const cves = Array.from({ length: 200 }, () => newCve());
    const last = await seed([cves[199]]);
    const result = await kev.run(ctx(createKevFake({ body: feed(cves) })));
    expect(result.upserted).toBe(1);
    expect((await reread(last.id)).exploited).toBe(1);
  });

  it("EXPLAIN: the IN-list query uses idx_advisories_cve_primary", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor) VALUES (?, ?, 'npm', 'pkg-fixture', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)",
    );
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 2000; i++) stmts.push(insert.bind(`tcs_explain_kev_${i}`, `CVE-2024-${30000 + i}`, 800000 + i));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("ANALYZE").run();
    const params = Array.from({ length: 90 }, (_, i) => `CVE-2024-${30000 + i}`);
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${KEV_SQL.match(90)}`).bind(...params).all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_advisories_cve_primary");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });
});
