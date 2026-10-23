import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { OsvHttpError } from "../../src/ingest/osv-client";
import { DEFAULT_ECOSYSTEMS, modKey, normalizeOsv, osv, paginate, type OsvVuln } from "../../src/ingest/osv";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import page1 from "../fixtures/osv/page1.json";
import { createOsvFake, FAKE_API_BASE, FAKE_CSV_BASE, type FakeRecord, type OsvFakeOptions } from "./osv-fake";

// page1.json: 7 unedited OSV records (2 npm, 2 PyPI, 2 Go, 1 RubyGems), copied
// from the osv-schema testdata in Google's `osv` 0.1.3 wheel on PyPI (wheel
// sha256 0eabd7164d3a7b3c578a5953c61cf309527daef5de64b34fc9c41a4f766f0055).
// api.osv.dev was not reachable from the build box when this was recorded.
const RECORDS = page1 as unknown as FakeRecord[];
const CURSOR_KEY = "cursor:osv";
const MAX_MODIFIED = "2024-07-03T20:05:21Z"; // GHSA-9v2f-6vcg-3hgv, the newest record in page1.json
const PLACEHOLDER_ID = "tcs_00000000000000000000000000";

// Expected action per fixture record: the fixed version, each fixed line by
// name when there are several (TCS-75), or no fix.
const EXPECTED_ACTION: Record<string, string> = {
  "GHSA-fhjf-83wg-r2j9": "Upgrade mixin-deep to 1.3.2 (1.x) or 2.0.1 (2.x) or later.",
  "GHSA-jvf4-g24p-2qgw": "No fix published. Pin and monitor.",
  "PYSEC-2023-74": "Upgrade requests to 2.31.0 or later.",
  "GHSA-9v2f-6vcg-3hgv": "No fix published. Pin and monitor.",
  "GO-2024-2963": "Upgrade stdlib to 1.21.12 (1.21.x) or 1.22.5 (1.22.x) or later.",
  "GO-2020-0001": "Upgrade github.com/gin-gonic/gin to 1.6.0 or later.",
  "GHSA-9qj7-jvg4-qr2x": "Upgrade passenger to 3.0.21 (3.x) or 4.0.5 (4.x) or later.",
};

function rec(id: string): OsvVuln {
  const r = RECORDS.find((x) => x.id === id);
  if (!r) throw new Error(`fixture has no ${id}`);
  return structuredClone(r) as unknown as OsvVuln;
}

function normalizeOk(v: OsvVuln): Advisory {
  const r = normalizeOsv(v, DEFAULT_ECOSYSTEMS);
  if (!r.ok) throw new Error(`normalize failed: ${r.reason}`);
  return { id: PLACEHOLDER_ID, ...r.doc };
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Every OSV read in this file goes through the fake: 0 real network calls.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

describe("normalizeOsv (normalize)", () => {
  it("the fixture has at least 5 records across at least 3 ecosystems (normalize)", () => {
    const ecos = new Set(RECORDS.flatMap((r) => (r.affected ?? []).map((a) => a.package?.ecosystem)));
    expect(RECORDS.length).toBeGreaterThanOrEqual(5);
    expect(ecos.size).toBeGreaterThanOrEqual(3);
  });

  it.each(RECORDS.map((r) => r.id))("normalize %s to a valid v1 doc with the right action", (id) => {
    const doc = normalizeOk(rec(id));
    const v = validateAdvisory(doc);
    expect(v.ok ? [] : v.errors).toEqual([]);
    expect(doc.action).toBe(EXPECTED_ACTION[id]);
    expect(doc.sources).toEqual([{ source: "osv", source_id: id, url: `https://osv.dev/vulnerability/${id}` }]);
    expect(doc.references[0]).toBe(`https://osv.dev/vulnerability/${id}`);
    expect(doc.exploited).toBe(false);
  });

  it("normalize: ranges are ordered by version, GIT ranges are skipped, fixed_versions come from events.fixed", () => {
    const mixin = normalizeOk(rec("GHSA-fhjf-83wg-r2j9"));
    expect(mixin.ecosystem).toBe("npm");
    expect(mixin.component).toBe("mixin-deep");
    expect(mixin.affected).toEqual([
      { introduced: "0", fixed: "1.3.2" },
      { introduced: "2.0.0", fixed: "2.0.1" },
    ]);
    expect(mixin.fixed_versions).toEqual(["2.0.1", "1.3.2"]);
    expect(mixin.cve_ids).toEqual(["CVE-2019-10746"]);
    expect(mixin.ghsa_id).toBe("GHSA-fhjf-83wg-r2j9");

    const requests = normalizeOk(rec("PYSEC-2023-74"));
    expect(requests.affected).toEqual([{ introduced: "2.3.0", fixed: "2.31.0" }]);
    expect(requests.fixed_versions).toEqual(["2.31.0"]);
    expect(requests.ghsa_id).toBe("GHSA-j8r2-6x86-q33q");
    expect(requests.published_at).toBe("2023-05-26T18:15:00Z");
    expect(requests.modified_at).toBe("2023-06-05T01:13:00.534973Z");

    const shiba = normalizeOk(rec("GHSA-jvf4-g24p-2qgw"));
    expect(shiba.affected).toEqual([{ introduced: "0" }]);
    expect(shiba.fixed_versions).toEqual([]);

    const go = normalizeOk(rec("GO-2024-2963"));
    expect(go.affected).toEqual([
      { introduced: "0", fixed: "1.21.12" },
      { introduced: "1.22.0-0", fixed: "1.22.5" },
    ]);
  });

  it("normalize: severity from a CVSS v3 vector, else database_specific.severity, else unknown", () => {
    expect(normalizeOk(rec("GHSA-9v2f-6vcg-3hgv")).severity).toEqual({ score: 9.8, label: "critical" });

    // Derived from the fixture record: the CVSS entry removed, database_specific kept.
    const dbOnly = rec("GHSA-9v2f-6vcg-3hgv");
    delete (dbOnly as { severity?: unknown }).severity;
    expect(normalizeOk(dbOnly).severity).toEqual({ label: "critical" });

    // Derived: a CVSS v4 vector only, which this ticket does not score.
    const v4 = rec("GHSA-9v2f-6vcg-3hgv");
    v4.severity = [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }];
    (v4.database_specific as Record<string, unknown>).severity = "MODERATE";
    expect(normalizeOk(v4).severity).toEqual({ label: "medium" });

    expect(normalizeOk(rec("GO-2020-0001")).severity).toEqual({ label: "unknown" });
  });

  it("normalize: summary falls back to the first line of details, collapses newlines and is cut to 200 chars", () => {
    const noSummary = rec("GHSA-fhjf-83wg-r2j9");
    delete (noSummary as { summary?: unknown }).summary;
    expect(normalizeOk(noSummary).summary).toBe(
      "Versions of `mixin-deep` prior to 2.0.1 or 1.3.2 are vulnerable to Prototype Pollution. The `mixinDeep` function fails to validate which Object properties it updates. This allows attackers to modify t",
    );

    const multi = rec("GO-2020-0001");
    multi.summary = "first\nsecond   third";
    expect(normalizeOk(multi).summary).toBe("first second third");

    const nothing = rec("GO-2020-0001");
    delete (nothing as { summary?: unknown }).summary;
    delete (nothing as { details?: unknown }).details;
    expect(normalizeOk(nothing).summary).toBe("Advisory GO-2020-0001 affects github.com/gin-gonic/gin.");
  });

  it("normalize: a record with no affected package in a listed ecosystem is refused with a reason", () => {
    const r = normalizeOsv(rec("GO-2020-0001"), ["npm"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no affected package/);
  });

  it("normalize: modKey orders fraction digits correctly", () => {
    expect(modKey("2026-10-21T22:45:05Z") > modKey("2026-10-21T22:45:05.2Z")).toBe(false);
    expect(modKey("2026-10-21T22:45:05.2Z") > modKey("2026-10-21T22:45:05Z")).toBe(true);
    expect(modKey("2026-10-21T22:45:05.20Z")).toBe(modKey("2026-10-21T22:45:05.2Z"));
    expect(modKey("2026-10-21T22:45:05.123456789Z") > modKey("2026-10-21T22:45:05.12345678Z")).toBe(true);
  });
});

function ctxFor(fake: { fetch: typeof fetch }, config: Record<string, unknown> = {}, now = "2026-10-22T00:00:00Z"): IngestContext {
  return {
    env,
    source: { id: "osv", kind: "osv", config: { csv_base: FAKE_CSV_BASE, api_base: FAKE_API_BASE, ...config } },
    now: () => new Date(now),
    fetch: fake.fetch,
  };
}

async function storedFor(ids: string[]): Promise<{ source_id: string; doc_json: string; cursor: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.source_id, a.doc_json, a.cursor FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id
     WHERE s.source = 'osv' AND s.source_id IN (${ids.map(() => "?").join(",")}) ORDER BY s.source_id`,
  )
    .bind(...ids)
    .all<{ source_id: string; doc_json: string; cursor: number }>();
  return results;
}

// A record derived from GO-2020-0001 with a new id and modified time.
function derived(id: string, modified: string, ecosystem = "Go"): FakeRecord {
  const r = structuredClone(RECORDS.find((x) => x.id === "GO-2020-0001")!) as FakeRecord & { aliases?: string[] };
  r.id = id;
  r.modified = modified;
  r.aliases = [];
  r.affected = [{ ...(r.affected![0] as object), package: { ecosystem, name: `example.com/${id.toLowerCase()}` } }];
  return r;
}

describe("osv ingester (run)", () => {
  beforeEach(async () => {
    await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
  });

  it("run (a): reads all 6 ecosystem lists, stores valid docs and sets the cursor to the max modified", async () => {
    const fake = createOsvFake(RECORDS);
    const res = await osv.run(ctxFor(fake, { page_size: 25 }));
    expect(res.errors).toEqual([]);
    expect(res.fetched).toBe(RECORDS.length);
    expect(res.upserted + res.unchanged).toBe(RECORDS.length);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(MAX_MODIFIED);

    const csvCalls = fake.calls.filter((c) => c.endsWith("/modified_id.csv"));
    expect(csvCalls.sort()).toEqual(DEFAULT_ECOSYSTEMS.map((e) => `${FAKE_CSV_BASE}/${encodeURIComponent(e)}/modified_id.csv`).sort());
    expect(DEFAULT_ECOSYSTEMS).toEqual(["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems"]);

    const rows = await storedFor(RECORDS.map((r) => r.id));
    expect(rows).toHaveLength(RECORDS.length);
    for (const row of rows) {
      const v = validateAdvisory(JSON.parse(row.doc_json));
      expect(v.ok ? [] : v.errors).toEqual([]);
    }
  });

  it("run (b): a thrown error on page 2 throws and leaves the cursor at page 1's max modified", async () => {
    const failing = "GHSA-2222-3333-4444";
    const opts: OsvFakeOptions = {
      extraRows: [{ ecosystem: "npm", modified: "2024-08-01T00:00:00Z", id: failing }],
      failIds: { [failing]: 503 },
    };
    const fake = createOsvFake(RECORDS, opts);
    await expect(osv.run(ctxFor(fake, { page_size: RECORDS.length }))).rejects.toBeInstanceOf(OsvHttpError);
    expect(fake.vulnCalls()).toContain(`${FAKE_API_BASE}/v1/vulns/${failing}`);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(MAX_MODIFIED);
  });

  it("run (b3): a thrown error on page 1 leaves the cursor where it was", async () => {
    // GHSA-9v2f-6vcg-3hgv is the newest record, so it is the last one of page 1.
    const fake = createOsvFake(RECORDS, { failIds: { "GHSA-9v2f-6vcg-3hgv": 500 } });
    await expect(osv.run(ctxFor(fake))).rejects.toBeInstanceOf(OsvHttpError);
    expect(fake.vulnCalls()).toHaveLength(RECORDS.length);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe("2000-01-01T00:00:00Z");
  });

  it("run (b2): a 5xx error names the status and the URL", async () => {
    const fake = createOsvFake(RECORDS, { failIds: { "GO-2020-0001": 502 } });
    const err = await osv.run(ctxFor(fake)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OsvHttpError);
    expect(String((err as Error).message)).toContain("502");
    expect(String((err as Error).message)).toContain(`${FAKE_API_BASE}/v1/vulns/GO-2020-0001`);
  });

  it("run (c): a second run fetches 0 records; a forced re-run changes no cursor column", async () => {
    const fake = createOsvFake(RECORDS);
    await osv.run(ctxFor(fake));
    const before = await storedFor(RECORDS.map((r) => r.id));

    const again = createOsvFake(RECORDS);
    const res = await osv.run(ctxFor(again));
    expect(again.vulnCalls()).toEqual([]);
    expect(res).toEqual({ fetched: 0, upserted: 0, unchanged: 0, errors: [] });

    await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
    const forced = await osv.run(ctxFor(createOsvFake(RECORDS)));
    expect(forced.fetched).toBe(RECORDS.length);
    expect(forced.unchanged).toBe(RECORDS.length);
    expect(forced.upserted).toBe(0);
    expect(await storedFor(RECORDS.map((r) => r.id))).toEqual(before);
  });

  it("run (d): a page boundary inside a group of equal modified values extends the page", async () => {
    const t = "2025-01-01T00:00:00.5Z";
    const recs = [derived("GO-TEST-D1", t), derived("GO-TEST-D2", t), derived("GO-TEST-D3", t), derived("GO-TEST-D4", "2025-01-02T00:00:00Z")];
    const fake = createOsvFake(recs);
    const res = await osv.run(ctxFor(fake, { page_size: 2, max_pages: 1, ecosystems: ["Go"] }));
    expect(res.fetched).toBe(3);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(t);

    const next = await osv.run(ctxFor(createOsvFake(recs), { page_size: 2, max_pages: 1, ecosystems: ["Go"] }));
    expect(next.fetched).toBe(1);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe("2025-01-02T00:00:00Z");
  });

  it("run (d2): paginate never splits equal modified values", () => {
    const items = ["1", "2", "2", "2", "3", "4"].map((s, i) => ({ id: `x${i}`, modified: `2025-01-0${s}T00:00:00Z` }));
    expect(paginate(items, 2).map((p) => p.map((x) => x.id))).toEqual([["x0", "x1", "x2", "x3"], ["x4", "x5"]]);
  });

  it("run (e): a MAL- id in the list is never fetched; an id in two lists is fetched once", async () => {
    const opts: OsvFakeOptions = {
      extraRows: [
        { ecosystem: "npm", modified: "2024-09-01T00:00:00Z", id: "MAL-2024-99999" },
        { ecosystem: "PyPI", modified: "2023-01-01T00:00:00Z", id: "GO-2020-0001" },
      ],
    };
    const fake = createOsvFake(RECORDS, opts);
    const res = await osv.run(ctxFor(fake));
    expect(res.errors).toEqual([]);
    expect(fake.vulnCalls().some((c) => c.includes("MAL-"))).toBe(false);
    expect(fake.vulnCalls().filter((c) => c.endsWith("/GO-2020-0001"))).toHaveLength(1);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(MAX_MODIFIED);
  });

  it("run (f): a record outside the listed ecosystems is an error line and the page still completes", async () => {
    const maven = derived("TEST-MAVEN-1", "2025-02-01T00:00:00Z", "Maven");
    const fake = createOsvFake([maven], { extraRows: [{ ecosystem: "Go", modified: maven.modified, id: maven.id }] });
    const res = await osv.run(ctxFor(fake, { ecosystems: ["Go"] }));
    expect(res.fetched).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^TEST-MAVEN-1: no affected package/);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(maven.modified);
  });

  it("run (g): with no cursor the run starts backfill_days before now", async () => {
    await env.CURSORS.delete(CURSOR_KEY);
    const fake = createOsvFake(RECORDS);
    const res = await osv.run(ctxFor(fake, { backfill_days: 7 }, "2024-07-04T00:00:00Z"));
    expect(fake.vulnCalls().map((c) => c.split("/").pop()).sort()).toEqual(["GHSA-9v2f-6vcg-3hgv", "GO-2024-2963"]);
    expect(res.fetched).toBe(2);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(MAX_MODIFIED);
  });

  it("run (h): an invalid config value fails the run instead of falling back", async () => {
    await expect(osv.run(ctxFor(createOsvFake(RECORDS), { page_size: 0 }))).rejects.toThrow(/page_size/);
    await expect(osv.run(ctxFor(createOsvFake(RECORDS), { ecosystems: "npm" }))).rejects.toThrow(/ecosystems/);
  });

  it("run (i): reading past max_csv_rows without reaching the cursor fails the run", async () => {
    await expect(osv.run(ctxFor(createOsvFake(RECORDS), { max_csv_rows: 1, ecosystems: ["npm"] }))).rejects.toThrow(/max_csv_rows/);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe("2000-01-01T00:00:00Z");
  });
});
