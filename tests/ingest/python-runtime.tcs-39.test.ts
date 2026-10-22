import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fetchListing, PythonHttpError } from "../../src/ingest/python-runtime-client";
import {
  normalizePythonAdvisory,
  parsePsfListing,
  parsePythonReleases,
  PY_CURSOR_KEY,
  PY_DEDUP_SQL,
  PY_ETAG_KEY,
  PY_PENDING_PREFIX,
  pythonRuntime,
} from "../../src/ingest/python-runtime";
import { defaultRegistry, runIngesters } from "../../src/ingest/registry";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import cve12345 from "../fixtures/python-runtime/CVE-2026-12345.json?raw";
import cve19445 from "../fixtures/python-runtime/CVE-2026-19445.json?raw";
import cve19553 from "../fixtures/python-runtime/CVE-2026-19553.json?raw";
import cve82049 from "../fixtures/python-runtime/CVE-2026-82049.json?raw";
import listingJson from "../fixtures/python-runtime/listing.json?raw";
import psf41 from "../fixtures/python-runtime/PSF-2026-41.json?raw";
import psf42 from "../fixtures/python-runtime/PSF-2026-42.json?raw";
import psf43 from "../fixtures/python-runtime/PSF-2026-43.json?raw";
import psf44 from "../fixtures/python-runtime/PSF-2026-44.json?raw";
import releasesJson from "../fixtures/python-runtime/releases.json?raw";
import { get } from "../routes/seed.tcs-3";
import { createPyFake, type PyAnswer, type PyFake } from "./python-fake.tcs-39";

// Fixtures: recorded on 2026-10-22 (tests/fixtures/python-runtime/README.md).
const LISTING = "https://api.github.com/repos/psf/advisory-database/contents/advisories/python";
const RECORD_BASE = "https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python";
const HTML_BASE = "https://github.com/psf/advisory-database/blob/main/advisories/python";
const CVE_BASE = "https://cveawg.mitre.org/api/cve";
const RELEASES = "https://www.python.org/api/v2/downloads/release/?is_published=true";
const ETAG = '"39fd4cc08d4e9fccc7b7b084cfe4080373d7c4fb"';
const NOW = "2026-10-22T22:00:00Z";
const START = "PSF-2026-41";

const REC = (id: string) => `${RECORD_BASE}/${id}.json`;
const CVE = (id: string) => `${CVE_BASE}/${id}`;

const FIVE_LINES = [
  { introduced: "0", fixed: "3.10.22" },
  { introduced: "3.11.0", fixed: "3.11.17" },
  { introduced: "3.12.0", fixed: "3.12.15" },
  { introduced: "3.13.0", fixed: "3.13.16" },
  { introduced: "3.14.0", fixed: "3.14.8" },
];
const FIVE_ACTION = "Upgrade python to 3.10.22 (3.10.x), 3.11.17 (3.11.x), 3.12.15 (3.12.x), 3.13.16 (3.13.x) or 3.14.8 (3.14.x) or later.";

const EXPECTED = [
  {
    psf: "PSF-2026-42",
    cve: "CVE-2026-12345",
    psfJson: psf42,
    cveJson: cve12345,
    affected: [
      { introduced: "0", fixed: "3.12.15" },
      { introduced: "3.14.0", fixed: "3.14.9" },
    ],
    action: "Upgrade python to 3.12.15 (3.12.x) or 3.14.9 (3.14.x) or later.",
    severity: { score: 5.9, label: "medium" },
    published: "2026-09-29T17:46:01Z",
  },
  { psf: "PSF-2026-43", cve: "CVE-2026-19445", psfJson: psf43, cveJson: cve19445, affected: FIVE_LINES, action: FIVE_ACTION, severity: { score: 9.2, label: "critical" }, published: "2026-09-30T16:16:04Z" },
  { psf: "PSF-2026-44", cve: "CVE-2026-19553", psfJson: psf44, cveJson: cve19553, affected: FIVE_LINES, action: FIVE_ACTION, severity: { score: 7.6, label: "high" }, published: "2026-09-30T16:17:39Z" },
];

function routes(over: Record<string, string | PyAnswer> = {}): Record<string, string | PyAnswer> {
  return {
    [LISTING]: { body: listingJson, etag: ETAG },
    [REC("PSF-2026-41")]: psf41,
    [CVE("CVE-2026-82049")]: cve82049,
    ...Object.fromEntries(EXPECTED.flatMap((e) => [[REC(e.psf), e.psfJson], [CVE(e.cve), e.cveJson]])),
    [RELEASES]: releasesJson,
    ...over,
  };
}

function ctxFor(fetchFn: typeof fetch, config: Record<string, unknown> = {}, envOver: Partial<typeof env> = {}): IngestContext {
  return { env: { ...env, ...envOver }, source: { id: "python-runtime", kind: "python-runtime", config }, now: () => new Date(NOW), fetch: fetchFn };
}

// Calls that are not the one GitHub listing call: PSF record, CVE record and releases reads.
const recordCalls = (fake: PyFake) => fake.urls().filter((u) => u !== LISTING);

const RELEASED = parsePythonReleases(JSON.parse(releasesJson));

function normalizeOk(i: number): Advisory {
  const e = EXPECTED[i];
  const r = normalizePythonAdvisory(e.psf, JSON.parse(e.psfJson), JSON.parse(e.cveJson), { minLine: "3.9", htmlBase: HTML_BASE });
  if (!r.ok) throw new Error(`normalize failed: ${r.reason}`);
  return { id: "tcs_00000000000000000000000000", ...r.doc };
}

async function pyRows(): Promise<{ source_id: string; doc: Advisory }[]> {
  const { results } = await env.DB.prepare(
    "SELECT s.source_id, a.doc_json FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = 'python-runtime' ORDER BY s.source_id",
  ).all<{ source_id: string; doc_json: string }>();
  return results.map((r) => ({ source_id: r.source_id, doc: JSON.parse(r.doc_json) as Advisory }));
}

async function pendingKeys(): Promise<string[]> {
  return (await env.CURSORS.list({ prefix: PY_PENDING_PREFIX })).keys.map((k) => k.name).sort();
}

let fetchSpy: MockInstance;
beforeAll(() => {
  // Any read that does not go through ctx.fetch fails the test instead of reaching the network.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`real network call in a python-runtime test: ${String(input)}`);
  });
});
afterAll(() => {
  fetchSpy.mockRestore();
});

// Each test starts with no python-runtime rows, no pending keys, no ETag, and the cursor at PSF-2026-41.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'python-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'python-runtime'").run();
  for (const k of await pendingKeys()) await env.CURSORS.delete(k);
  await env.CURSORS.delete(PY_ETAG_KEY);
  await env.CURSORS.put(PY_CURSOR_KEY, START);
});

describe("python parsers (text)", () => {
  it("the recorded listing yields the 5 PSF ids in (year, number) order", () => {
    expect(parsePsfListing(JSON.parse(listingJson))).toEqual(["PSF-2025-16", "PSF-2026-41", "PSF-2026-42", "PSF-2026-43", "PSF-2026-44"]);
  });

  it("the releases list has the final versions and no pre-release or install-manager entry", () => {
    for (const v of ["3.10.22", "3.11.17", "3.12.15", "3.13.16", "3.14.8", "3.14.9"]) expect(RELEASED.has(v)).toBe(true);
    expect(RELEASED.has("3.15.0rc3")).toBe(false);
    expect([...RELEASED].every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
  });
});

describe("normalizePythonAdvisory (normalize)", () => {
  it.each([0, 1, 2])("advisory %i has the right release lines, fixed versions, severity and action", (i) => {
    const e = EXPECTED[i];
    const d = normalizeOk(i);
    expect(d.ecosystem).toBe("python");
    expect(d.component).toBe("python");
    expect(d.cve_ids).toEqual([e.cve]);
    expect(d.affected).toEqual(e.affected);
    expect(d.fixed_versions).toEqual(e.affected.map((a) => a.fixed));
    expect(d.action).toBe(e.action);
    expect(d.severity).toEqual(e.severity);
    expect(d.published_at).toBe(e.published);
    expect(d.sources).toEqual([{ source: "python-runtime", source_id: e.psf, url: `${HTML_BASE}/${e.psf}.json` }]);
    expect(d.references[0]).toBe(`${HTML_BASE}/${e.psf}.json`);
    // The CVE record's 3.15.0a1 < 3.15.0rc3 range is a pre-release fix: no line for it.
    expect(d.affected.some((a) => a.fixed?.startsWith("3.15"))).toBe(false);
    const v = validateAdvisory({ ...d });
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("a withdrawn PSF record is terminal, not a doc and not an error", () => {
    const g = JSON.parse(psf44);
    g.withdrawn = "2026-10-01T00:00:00Z";
    const r = normalizePythonAdvisory("PSF-2026-44", g, JSON.parse(cve19553), { minLine: "3.9", htmlBase: HTML_BASE });
    expect(r).toMatchObject({ ok: false, error: false });
  });

  it("a min_line of 3.12 drops the 3.10 and 3.11 lines (source: assumed, config edit)", () => {
    const r = normalizePythonAdvisory("PSF-2026-44", JSON.parse(psf44), JSON.parse(cve19553), { minLine: "3.12", htmlBase: HTML_BASE });
    if (!r.ok) throw new Error(r.reason);
    expect(r.doc.affected).toEqual(FIVE_LINES.slice(2));
  });
});

describe("python-runtime seam (seam)", () => {
  it("the listing request carries Accept, User-Agent and the API version, and no Authorization without a token", async () => {
    const fake = createPyFake(routes());
    const res = await fetchListing(fake.fetch, LISTING, undefined, undefined);
    expect(res.notModified).toBe(false);
    const h = fake.calls[0].headers;
    expect(h["accept"]).toBe("application/vnd.github+json");
    expect(h["user-agent"]).toBe("tocsin.sh");
    expect(h["x-github-api-version"]).toBe("2022-11-28");
    expect(h["authorization"]).toBeUndefined();
    expect(h["if-none-match"]).toBeUndefined();
  });

  it("a 403 on the listing throws PythonHttpError and leaves the cursor", async () => {
    const fake = createPyFake(routes({ [LISTING]: { status: 403, body: '{"message":"API rate limit exceeded"}' } }));
    const err = await pythonRuntime.run(ctxFor(fake.fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonHttpError);
    expect((err as PythonHttpError).status).toBe(403);
    expect(await env.CURSORS.get(PY_CURSOR_KEY)).toBe(START);
  });

  it("GITHUB_TOKEN reaches only the GitHub API listing as a bearer token", async () => {
    const fake = createPyFake(routes());
    await pythonRuntime.run(ctxFor(fake.fetch, {}, { GITHUB_TOKEN: "tok-fixture-39" }));
    expect(fake.calls.find((c) => c.url === LISTING)!.headers["authorization"]).toBe("Bearer tok-fixture-39");
    for (const c of fake.calls.filter((c) => c.url !== LISTING)) expect(c.headers["authorization"]).toBeUndefined();
  });
});

describe("pythonRuntime.run (run)", () => {
  it("a recorded page of 3 new advisories stores 3 with the right lines: 1 listing + 3 PSF + 3 CVE + 1 releases read", async () => {
    const fake = createPyFake(routes());
    const res = await pythonRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(3);
    expect(fake.count(LISTING)).toBe(1);
    expect(recordCalls(fake).sort()).toEqual([...EXPECTED.flatMap((e) => [REC(e.psf), CVE(e.cve)]), RELEASES].sort());
    expect(await env.CURSORS.get(PY_CURSOR_KEY)).toBe("PSF-2026-44");
    expect(await env.CURSORS.get(PY_ETAG_KEY)).toBe(ETAG);
    const rows = await pyRows();
    expect(rows.map((r) => r.source_id)).toEqual(EXPECTED.map((e) => e.psf));
    for (const [i, r] of rows.entries()) {
      expect(r.doc.affected).toEqual(EXPECTED[i].affected);
      expect(r.doc.fixed_versions).toEqual(EXPECTED[i].affected.map((a) => a.fixed));
    }
  });

  it("a second run sends If-None-Match, gets 304 and makes 0 record, CVE or releases reads", async () => {
    await pythonRuntime.run(ctxFor(createPyFake(routes()).fetch));
    const fake = createPyFake(routes());
    const res = await pythonRuntime.run(ctxFor(fake.fetch));
    expect(fake.calls).toEqual([expect.objectContaining({ url: LISTING, status: 304 })]);
    expect(fake.calls[0].headers["if-none-match"]).toBe(ETAG);
    expect(res).toMatchObject({ fetched: 0, upserted: 0, errors: [] });
    expect((await pyRows()).length).toBe(3);
  });

  it("a re-run over stored records (cursor reset, no ETag) yields unchanged for all 3 with 0 PSF or CVE reads", async () => {
    await pythonRuntime.run(ctxFor(createPyFake(routes()).fetch));
    await env.CURSORS.put(PY_CURSOR_KEY, START);
    await env.CURSORS.delete(PY_ETAG_KEY);
    const fake = createPyFake(routes());
    const res = await pythonRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.unchanged).toBe(3);
    expect(res.upserted).toBe(0);
    expect(recordCalls(fake)).toEqual([]);
    expect((await pyRows()).length).toBe(3);
  });

  it("the dedup read seeks the advisory_sources primary key at 2000 seeded rows (EXPLAIN QUERY PLAN)", async () => {
    const stmts = [];
    for (let i = 0; i < 2000; i++) {
      stmts.push(env.DB.prepare("INSERT INTO advisory_sources (source, source_id, advisory_id) VALUES (?, ?, ?)").bind("tcs39-explain", `PSF-2099-${i}`, `tcs39-explain-${i}`));
    }
    await env.DB.batch(stmts);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${PY_DEDUP_SQL}`).bind("python-runtime", "PSF-2026-44").all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/SEARCH advisory_sources USING (COVERING )?INDEX sqlite_autoindex_advisory_sources_1 \(source=\? AND source_id=\?\)/);
    expect(detail).not.toMatch(/SCAN/);
    await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'tcs39-explain'").run();
  });

  it("with no cursor, the backfill window skips PSF-2025-16 and reads the 2026 records", async () => {
    await env.CURSORS.delete(PY_CURSOR_KEY);
    const fake = createPyFake(routes());
    const res = await pythonRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(4);
    expect(fake.count(REC("PSF-2025-16"))).toBe(0);
    expect(await env.CURSORS.get(PY_CURSOR_KEY)).toBe("PSF-2026-44");
  });

  it("max_records 2 handles 2 records, keeps no ETag, and the next run handles the third", async () => {
    const first = createPyFake(routes());
    const res = await pythonRuntime.run(ctxFor(first.fetch, { max_records: 2 }));
    expect(res.upserted).toBe(2);
    expect(res.incomplete).toBe(true);
    expect(await env.CURSORS.get(PY_CURSOR_KEY)).toBe("PSF-2026-43");
    expect(await env.CURSORS.get(PY_ETAG_KEY)).toBeNull();
    const second = createPyFake(routes());
    const res2 = await pythonRuntime.run(ctxFor(second.fetch, { max_records: 2 }));
    expect(second.calls[0].headers["if-none-match"]).toBeUndefined();
    expect(res2.upserted).toBe(1);
    expect(await env.CURSORS.get(PY_CURSOR_KEY)).toBe("PSF-2026-44");
  });
});

describe("unreleased fix (pending)", () => {
  const noFix = JSON.stringify(JSON.parse(releasesJson).filter((r: { name: string }) => r.name !== "Python 3.14.9"));

  it("a fix missing from python.org is a pending KV record, not an error; the cursor moves past it", async () => {
    expect(noFix).not.toBe(releasesJson);
    const fake = createPyFake(routes({ [RELEASES]: noFix }));
    const res = await pythonRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(2);
    expect(res.deferred).toBe(1);
    expect(res.incomplete).toBe(true);
    expect(await env.CURSORS.get(PY_CURSOR_KEY)).toBe("PSF-2026-44");
    expect(await pendingKeys()).toEqual([`${PY_PENDING_PREFIX}PSF-2026-42`]);
    const pending = JSON.parse((await env.CURSORS.get(`${PY_PENDING_PREFIX}PSF-2026-42`))!);
    expect(pending).toMatchObject({ psf: "PSF-2026-42", cve: "CVE-2026-12345", unreleased: ["3.14.9"] });
    expect((await pyRows()).map((r) => r.source_id)).toEqual(["PSF-2026-43", "PSF-2026-44"]);
  });

  it("the next run re-checks only the pending record: 304 listing + 1 releases read, then stores it and clears the key", async () => {
    await pythonRuntime.run(ctxFor(createPyFake(routes({ [RELEASES]: noFix })).fetch));
    const fake = createPyFake(routes());
    const res = await pythonRuntime.run(ctxFor(fake.fetch));
    expect(fake.urls()).toEqual([LISTING, RELEASES]);
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(1);
    expect(res.deferred ?? 0).toBe(0);
    expect(await pendingKeys()).toEqual([]);
    expect((await pyRows()).map((r) => r.source_id)).toEqual(["PSF-2026-42", "PSF-2026-43", "PSF-2026-44"]);
  });

  it("through runIngesters, a run with a pending record marks python-runtime ok with last_error NULL", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id != 'python-runtime'").run();
    const fake = createPyFake(routes({ [RELEASES]: noFix }));
    fetchSpy.mockImplementation(fake.fetch as never);
    try {
      const outcomes = await runIngesters(env, defaultRegistry, () => new Date(NOW));
      expect(outcomes).toEqual([expect.objectContaining({ source: "python-runtime", status: "ok" })]);
      const o = outcomes[0] as { result: { deferred?: number } };
      expect(o.result.deferred).toBe(1);
      const row = await env.DB.prepare("SELECT last_ok_at, last_error FROM sources WHERE id = 'python-runtime'").first<{ last_ok_at: string; last_error: string | null }>();
      expect(row).toEqual({ last_ok_at: new Date(NOW).toISOString(), last_error: null });
    } finally {
      fetchSpy.mockImplementation(async (input) => {
        throw new Error(`real network call in a python-runtime test: ${String(input)}`);
      });
      await env.DB.prepare("UPDATE sources SET enabled = 1").run();
    }
  });
});

describe("GET /v1/check?python= (check)", () => {
  it("python=3.12.4 returns the 3 stored advisories, each fixed in 3.12.15", async () => {
    await pythonRuntime.run(ctxFor(createPyFake(routes()).fetch));
    const res = await get("/v1/check?python=3.12.4", "192.0.2.139");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checked: number; affected: { cve_ids: string[]; fixed_in: string | null; url: string }[] };
    expect(body.checked).toBe(1);
    const mine = body.affected.filter((a) => EXPECTED.some((e) => a.cve_ids.includes(e.cve)));
    expect(mine.map((a) => a.cve_ids[0]).sort()).toEqual(EXPECTED.map((e) => e.cve).sort());
    for (const a of mine) expect(a.fixed_in).toBe("3.12.15");
  });

  it("python=3.13.16 is affected by none of the 3", async () => {
    await pythonRuntime.run(ctxFor(createPyFake(routes()).fetch));
    const res = await get("/v1/check?python=3.13.16", "192.0.2.140");
    const body = (await res.json()) as { affected: { cve_ids: string[] }[] };
    expect(body.affected.filter((a) => EXPECTED.some((e) => a.cve_ids.includes(e.cve)))).toEqual([]);
  });
});
