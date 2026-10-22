import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fetchListing, PythonHttpError } from "../../src/ingest/python-runtime-client";
import {
  normalizePythonAdvisory,
  parsePsfListing,
  parsePythonReleases,
  PY_ETAG_KEY,
  pythonRuntime,
  RECORD_SQL,
} from "../../src/ingest/python-runtime";
import { defaultRegistry, runIngesters } from "../../src/ingest/registry";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import cve12084 from "../fixtures/python-runtime/CVE-2025-12084.json?raw";
import cve12345 from "../fixtures/python-runtime/CVE-2026-12345.json?raw";
import cve19445 from "../fixtures/python-runtime/CVE-2026-19445.json?raw";
import cve19553 from "../fixtures/python-runtime/CVE-2026-19553.json?raw";
import cve82049 from "../fixtures/python-runtime/CVE-2026-82049.json?raw";
import listingJson from "../fixtures/python-runtime/listing.json?raw";
import psf2516 from "../fixtures/python-runtime/PSF-2025-16.json?raw";
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
const NOW = new Date("2026-10-22T22:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Rows seeded as already handled, so the recorded page has 3 new advisories.
const DONE = ["PSF-2025-16", "PSF-2026-41"];

const REC = (id: string) => `${RECORD_BASE}/${id}.json`;
const CVE = (id: string) => `${CVE_BASE}/${id}`;
const later = (ms: number) => new Date(NOW.getTime() + ms);

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
    [REC("PSF-2025-16")]: psf2516,
    [CVE("CVE-2025-12084")]: cve12084,
    [REC("PSF-2026-41")]: psf41,
    [CVE("CVE-2026-82049")]: cve82049,
    ...Object.fromEntries(EXPECTED.flatMap((e) => [[REC(e.psf), e.psfJson], [CVE(e.cve), e.cveJson]])),
    [RELEASES]: releasesJson,
    ...over,
  };
}

function ctxFor(fetchFn: typeof fetch, opts: { config?: Record<string, unknown>; env?: Partial<typeof env>; now?: Date } = {}): IngestContext {
  const now = opts.now ?? NOW;
  return { env: { ...env, ...opts.env }, source: { id: "python-runtime", kind: "python-runtime", config: opts.config ?? {} }, now: () => now, fetch: fetchFn };
}

const runAt = (fake: PyFake, now: Date, config: Record<string, unknown> = {}) => pythonRuntime.run(ctxFor(fake.fetch, { now, config }));
// Calls that are not the one GitHub listing call: PSF record, CVE record and releases reads.
const recordCalls = (fake: PyFake) => fake.urls().filter((u) => u !== LISTING);
const readsOf = (fake: PyFake, psf: string, cve: string) => fake.count(REC(psf)) + fake.count(CVE(cve));

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

interface LedgerRow {
  psf_id: string;
  state: string;
  attempts: number;
  last_error: string | null;
  unreleased: string | null;
  next_check_at: string | null;
}

async function ledger(psf: string): Promise<LedgerRow | null> {
  return env.DB.prepare("SELECT psf_id, state, attempts, last_error, unreleased, next_check_at FROM python_runtime_records WHERE psf_id = ?").bind(psf).first<LedgerRow>();
}

function listingWith(edit: (entries: { name: string }[]) => { name: string }[]): string {
  return JSON.stringify(edit(JSON.parse(listingJson)));
}

// Synthetic PSF-2026-45 (source: assumed, in-test edit of the recorded PSF-2026-44 and its CVE record).
const PSF45 = JSON.stringify({ ...JSON.parse(psf44), id: "PSF-2026-45", aliases: ["CVE-2026-99001"] });
const CVE45 = (() => {
  const c = JSON.parse(cve19553);
  c.cveMetadata.cveId = "CVE-2026-99001";
  return JSON.stringify(c);
})();
function entry45(entries: { name: string }[]) {
  const e = structuredClone(entries.find((x) => x.name === "PSF-2026-44.json")!);
  e.name = "PSF-2026-45.json";
  return e;
}

const throwing = async (input: unknown) => {
  throw new Error(`real network call in a python-runtime test: ${String(input)}`);
};
let fetchSpy: MockInstance;
beforeAll(() => {
  // Any read that does not go through ctx.fetch fails the test instead of reaching the network.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(throwing as never);
});
afterAll(() => {
  fetchSpy.mockRestore();
});

// Each test starts with no python-runtime advisories, no ETag, and PSF-2025-16 and PSF-2026-41 handled.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'python-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'python-runtime'").run();
  await env.DB.prepare("DELETE FROM python_runtime_records").run();
  for (const id of DONE) {
    await env.DB.prepare("INSERT INTO python_runtime_records (psf_id, state, attempts, updated_at) VALUES (?, 'ok', 0, ?)").bind(id, NOW.toISOString()).run();
  }
  await env.CURSORS.delete(PY_ETAG_KEY);
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

  it("a 403 on the listing throws PythonHttpError and writes no ledger row", async () => {
    const fake = createPyFake(routes({ [LISTING]: { status: 403, body: '{"message":"API rate limit exceeded"}' } }));
    const err = await runAt(fake, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonHttpError);
    expect((err as PythonHttpError).status).toBe(403);
    expect(await ledger("PSF-2026-44")).toBeNull();
  });

  it("GITHUB_TOKEN reaches only the GitHub API listing as a bearer token", async () => {
    const fake = createPyFake(routes());
    await pythonRuntime.run(ctxFor(fake.fetch, { env: { GITHUB_TOKEN: "tok-fixture-39" } }));
    expect(fake.calls.find((c) => c.url === LISTING)!.headers["authorization"]).toBe("Bearer tok-fixture-39");
    for (const c of fake.calls.filter((c) => c.url !== LISTING)) expect(c.headers["authorization"]).toBeUndefined();
  });
});

describe("pythonRuntime.run (run)", () => {
  it("a recorded page of 3 new advisories stores 3 with the right lines: 1 listing + 3 PSF + 3 CVE + 1 releases read", async () => {
    const fake = createPyFake(routes());
    const res = await runAt(fake, NOW);
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(3);
    expect(fake.count(LISTING)).toBe(1);
    expect(recordCalls(fake).sort()).toEqual([...EXPECTED.flatMap((e) => [REC(e.psf), CVE(e.cve)]), RELEASES].sort());
    expect(await env.CURSORS.get(PY_ETAG_KEY)).toBe(ETAG);
    const rows = await pyRows();
    expect(rows.map((r) => r.source_id)).toEqual(EXPECTED.map((e) => e.psf));
    for (const [i, r] of rows.entries()) {
      expect(r.doc.affected).toEqual(EXPECTED[i].affected);
      expect(r.doc.fixed_versions).toEqual(EXPECTED[i].affected.map((a) => a.fixed));
      expect(r.doc.action).toBe(EXPECTED[i].action);
    }
    for (const e of EXPECTED) expect(await ledger(e.psf)).toMatchObject({ state: "ok", attempts: 0, next_check_at: null });
  });

  it("a second run sends If-None-Match, gets 304 and makes 0 record, CVE or releases reads", async () => {
    await runAt(createPyFake(routes()), NOW);
    const fake = createPyFake(routes());
    const res = await runAt(fake, later(HOUR));
    expect(fake.calls).toEqual([expect.objectContaining({ url: LISTING, status: 304 })]);
    expect(fake.calls[0].headers["if-none-match"]).toBe(ETAG);
    expect(res).toMatchObject({ fetched: 0, upserted: 0, errors: [] });
    expect((await pyRows()).length).toBe(3);
  });

  it("a second run with a full listing (no ETag) finds every id in the ledger and makes 0 PSF, CVE or releases reads", async () => {
    await runAt(createPyFake(routes()), NOW);
    await env.CURSORS.delete(PY_ETAG_KEY);
    const fake = createPyFake(routes());
    const res = await runAt(fake, later(HOUR));
    expect(res).toMatchObject({ fetched: 0, upserted: 0, errors: [] });
    expect(recordCalls(fake)).toEqual([]);
    expect((await pyRows()).length).toBe(3);
  });

  it("with an empty ledger, every listed id is read, newest first, and all 5 are stored", async () => {
    await env.DB.prepare("DELETE FROM python_runtime_records").run();
    const fake = createPyFake(routes());
    const res = await runAt(fake, NOW);
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(5);
    expect(fake.urls().filter((u) => u.startsWith(RECORD_BASE))).toEqual(["PSF-2026-44", "PSF-2026-43", "PSF-2026-42", "PSF-2026-41", "PSF-2025-16"].map(REC));
  });

  it("max_records 2 reads the 2 newest, keeps no ETag, and the next run reads the third", async () => {
    const first = createPyFake(routes());
    const res = await runAt(first, NOW, { max_records: 2 });
    expect(res.upserted).toBe(2);
    expect(res.incomplete).toBe(true);
    expect((await pyRows()).map((r) => r.source_id)).toEqual(["PSF-2026-43", "PSF-2026-44"]);
    expect(await env.CURSORS.get(PY_ETAG_KEY)).toBeNull();
    const second = createPyFake(routes());
    const res2 = await runAt(second, later(HOUR), { max_records: 2 });
    expect(second.calls[0].headers["if-none-match"]).toBeUndefined();
    expect(res2.upserted).toBe(1);
    expect((await pyRows()).map((r) => r.source_id)).toEqual(EXPECTED.map((e) => e.psf));
  });

  it("an out-of-order listing: 45 is listed before 44 appears, and a later run still reads 44 (source: assumed, in-test edit)", async () => {
    const without44 = listingWith((es) => [...es.filter((e) => e.name !== "PSF-2026-44.json"), entry45(es)]);
    const first = createPyFake(routes({ [LISTING]: { body: without44, etag: '"w1"' }, [REC("PSF-2026-45")]: PSF45, [CVE("CVE-2026-99001")]: CVE45 }));
    await runAt(first, NOW);
    expect(await ledger("PSF-2026-45")).toMatchObject({ state: "ok" });
    expect(await ledger("PSF-2026-44")).toBeNull();
    // 45 before 44 in the listing order; the ledger, not a cursor, decides what is new.
    const both = listingWith((es) => [...es.filter((e) => e.name !== "PSF-2026-44.json"), entry45(es), es.find((e) => e.name === "PSF-2026-44.json")!]);
    const second = createPyFake(routes({ [LISTING]: { body: both, etag: '"w2"' }, [REC("PSF-2026-45")]: PSF45, [CVE("CVE-2026-99001")]: CVE45 }));
    const res = await runAt(second, later(HOUR));
    expect(res.upserted).toBe(1);
    expect(readsOf(second, "PSF-2026-44", "CVE-2026-19553")).toBe(2);
    expect(readsOf(second, "PSF-2026-45", "CVE-2026-99001")).toBe(0);
    expect(await ledger("PSF-2026-44")).toMatchObject({ state: "ok" });
  });

  it("a listing of 1000 entries records a 'listing truncated' warning and still handles the records", async () => {
    const big = listingWith((es) => [...es, ...Array.from({ length: 1000 - es.length }, (_, i) => ({ ...es[0], name: `README-${i}.md` }))]);
    expect(JSON.parse(big)).toHaveLength(1000);
    const res = await runAt(createPyFake(routes({ [LISTING]: { body: big, etag: ETAG } })), NOW);
    expect(res.errors).toEqual(["listing truncated at 1000 entries"]);
    expect(res.upserted).toBe(3);
  });
});

describe("failed and empty records (ledger)", () => {
  const cve404 = { [CVE("CVE-2026-19445")]: { status: 404, body: '{"error":"CVE_RECORD_DNE"}' } };

  it("a 404 CVE record marks the record failed with attempts 1, and the run continues to the next id", async () => {
    const fake = createPyFake(routes(cve404));
    const res = await runAt(fake, NOW);
    expect(res.upserted).toBe(2);
    expect(res.errors).toEqual([]);
    const row = await ledger("PSF-2026-43");
    expect(row).toMatchObject({ state: "failed", attempts: 1, next_check_at: later(30 * 60_000).toISOString() });
    expect(row!.last_error).toContain("404");
    expect((await pyRows()).map((r) => r.source_id)).toEqual(["PSF-2026-42", "PSF-2026-44"]);
  });

  it("the third 404 makes the record terminal; a fourth run makes no read for it and last_error names it", async () => {
    await runAt(createPyFake(routes(cve404)), NOW);
    const second = createPyFake(routes(cve404));
    await runAt(second, later(HOUR));
    expect(readsOf(second, "PSF-2026-43", "CVE-2026-19445")).toBe(2);
    expect(await ledger("PSF-2026-43")).toMatchObject({ state: "failed", attempts: 2 });
    const third = createPyFake(routes(cve404));
    const res3 = await runAt(third, later(3 * HOUR));
    expect(readsOf(third, "PSF-2026-43", "CVE-2026-19445")).toBe(2);
    expect(await ledger("PSF-2026-43")).toMatchObject({ state: "failed", attempts: 3, next_check_at: null });
    expect(res3.errors).toEqual(["1 records failed terminally: PSF-2026-43"]);
    await env.CURSORS.delete(PY_ETAG_KEY);
    const fourth = createPyFake(routes(cve404));
    const res4 = await runAt(fourth, later(30 * DAY));
    expect(readsOf(fourth, "PSF-2026-43", "CVE-2026-19445")).toBe(0);
    expect(recordCalls(fourth)).toEqual([]);
    expect(res4.errors).toEqual(["1 records failed terminally: PSF-2026-43"]);
  });

  it("a record with no release line is terminal empty and never read again (source: assumed, in-test edit)", async () => {
    const c = JSON.parse(cve19553);
    c.containers.cna.affected[0].versions = c.containers.cna.affected[0].versions.filter((v: { lessThan?: string }) => v.lessThan?.startsWith("3.15"));
    const over = { [CVE("CVE-2026-19553")]: JSON.stringify(c) };
    const res = await runAt(createPyFake(routes(over)), NOW);
    expect(res.errors).toEqual([]);
    const row = await ledger("PSF-2026-44");
    expect(row).toMatchObject({ state: "empty", next_check_at: null });
    expect(row!.last_error).toContain("no release line");
    await env.CURSORS.delete(PY_ETAG_KEY);
    const again = createPyFake(routes(over));
    await runAt(again, later(30 * DAY));
    expect(readsOf(again, "PSF-2026-44", "CVE-2026-19553")).toBe(0);
  });

  it("a CVE record for another id is terminal empty, reported once", async () => {
    const res = await runAt(createPyFake(routes({ [CVE("CVE-2026-19553")]: cve19445 })), NOW);
    expect(res.errors).toEqual(["PSF-2026-44: CVE record is not for CVE-2026-19553"]);
    expect(await ledger("PSF-2026-44")).toMatchObject({ state: "empty" });
  });

  it("the ledger reads use the primary key and idx_python_runtime_records_state_next at 2000 rows (EXPLAIN QUERY PLAN)", async () => {
    const stmts = [];
    for (let i = 0; i < 2000; i++) {
      const state = ["ok", "empty", "pending", "failed"][i % 4];
      stmts.push(
        env.DB.prepare("INSERT INTO python_runtime_records (psf_id, state, attempts, next_check_at, updated_at) VALUES (?, ?, 0, ?, ?)").bind(
          `PSF-2099-${i}`,
          state,
          state === "ok" || state === "empty" ? null : NOW.toISOString(),
          NOW.toISOString(),
        ),
      );
    }
    await env.DB.batch(stmts);
    const plan = async (sql: string, ...params: unknown[]) =>
      (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");
    const known = await plan(RECORD_SQL.known, JSON.stringify(["PSF-2026-44", "PSF-2099-7"]));
    expect(known).toMatch(/SEARCH python_runtime_records USING (COVERING )?INDEX sqlite_autoindex_python_runtime_records_1 \(psf_id=\?\)/);
    expect(known).not.toMatch(/SCAN python_runtime_records/);
    const due = await plan(RECORD_SQL.due, "failed", NOW.toISOString(), 51);
    expect(due).toMatch(/SEARCH python_runtime_records USING INDEX idx_python_runtime_records_state_next \(state=\? AND next_check_at<\?\)/);
    const terminal = await plan(RECORD_SQL.terminalFailed);
    expect(terminal).toMatch(/SEARCH python_runtime_records USING (COVERING )?INDEX idx_python_runtime_records_state_next \(state=\? AND next_check_at=\?\)/);
    expect(due + terminal).not.toMatch(/SCAN/);
  });
});

describe("unreleased fix (pending)", () => {
  const noFix = JSON.stringify(JSON.parse(releasesJson).filter((r: { name: string }) => r.name !== "Python 3.14.9"));
  const NO_FIX_ACTION = "Upgrade python to 3.12.15 or later. The 3.14.x (3.14.9) fix is not released yet.";

  it("a fix missing from python.org publishes the released line at once and keeps the other line pending, with no error", async () => {
    expect(noFix).not.toBe(releasesJson);
    const res = await runAt(createPyFake(routes({ [RELEASES]: noFix })), NOW);
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(3);
    expect(res.deferred).toBe(1);
    expect(res.incomplete).toBe(true);
    const doc = (await pyRows()).find((r) => r.source_id === "PSF-2026-42")!.doc;
    expect(doc.affected).toEqual([{ introduced: "0", fixed: "3.12.15" }]);
    expect(doc.fixed_versions).toEqual(["3.12.15"]);
    expect(doc.action).toBe(NO_FIX_ACTION);
    const row = await ledger("PSF-2026-42");
    expect(row).toMatchObject({ state: "pending", next_check_at: later(HOUR).toISOString() });
    expect(JSON.parse(row!.unreleased!).lines).toEqual([{ fixed: "3.14.9", since: NOW.toISOString() }]);
  });

  it("the next due run re-checks only python.org (304 listing + 1 releases read) and adds the released line", async () => {
    await runAt(createPyFake(routes({ [RELEASES]: noFix })), NOW);
    const fake = createPyFake(routes());
    const res = await runAt(fake, later(2 * HOUR));
    expect(fake.urls()).toEqual([LISTING, RELEASES]);
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(1);
    expect(res.deferred ?? 0).toBe(0);
    const doc = (await pyRows()).find((r) => r.source_id === "PSF-2026-42")!.doc;
    expect(doc.affected).toEqual(EXPECTED[0].affected);
    expect(doc.action).toBe(EXPECTED[0].action);
    expect(await ledger("PSF-2026-42")).toMatchObject({ state: "ok", unreleased: null, next_check_at: null });
  });

  it("a run before next_check_at makes no releases read for the pending record", async () => {
    await runAt(createPyFake(routes({ [RELEASES]: noFix })), NOW);
    const fake = createPyFake(routes({ [RELEASES]: noFix }));
    await runAt(fake, later(10 * 60_000));
    expect(fake.urls()).toEqual([LISTING]);
  });

  it("a line unreleased for 90 days is dropped: the record ends ok with a last_error note", async () => {
    await runAt(createPyFake(routes({ [RELEASES]: noFix })), NOW);
    const fake = createPyFake(routes({ [RELEASES]: noFix }));
    await runAt(fake, later(91 * DAY));
    expect(fake.urls()).toEqual([LISTING, RELEASES]);
    const row = await ledger("PSF-2026-42");
    expect(row).toMatchObject({ state: "ok", next_check_at: null });
    expect(row!.last_error).toBe("no python.org release after 90 days: 3.14.9");
    const doc = (await pyRows()).find((r) => r.source_id === "PSF-2026-42")!.doc;
    expect(doc.affected).toEqual([{ introduced: "0", fixed: "3.12.15" }]);
    expect(doc.action).toBe("Upgrade python to 3.12.15 or later.");
  });

  it("through runIngesters, a run with a pending record marks python-runtime ok with last_error NULL", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id != 'python-runtime'").run();
    const fake = createPyFake(routes({ [RELEASES]: noFix }));
    fetchSpy.mockImplementation(fake.fetch as never);
    try {
      const outcomes = await runIngesters(env, defaultRegistry, () => NOW);
      expect(outcomes).toEqual([expect.objectContaining({ source: "python-runtime", status: "ok" })]);
      const o = outcomes[0] as { result: { deferred?: number } };
      expect(o.result.deferred).toBe(1);
      const row = await env.DB.prepare("SELECT last_ok_at, last_error FROM sources WHERE id = 'python-runtime'").first<{ last_ok_at: string; last_error: string | null }>();
      expect(row).toEqual({ last_ok_at: NOW.toISOString(), last_error: null });
    } finally {
      fetchSpy.mockImplementation(throwing as never);
      await env.DB.prepare("UPDATE sources SET enabled = 1").run();
    }
  });
});

describe("GET /v1/check?python= (check)", () => {
  it("python=3.12.4 returns the 3 stored advisories, each fixed in 3.12.15", async () => {
    await runAt(createPyFake(routes()), NOW);
    const res = await get("/v1/check?python=3.12.4", "192.0.2.139");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checked: number; affected: { cve_ids: string[]; fixed_in: string | null; url: string }[] };
    expect(body.checked).toBe(1);
    const mine = body.affected.filter((a) => EXPECTED.some((e) => a.cve_ids.includes(e.cve)));
    expect(mine.map((a) => a.cve_ids[0]).sort()).toEqual(EXPECTED.map((e) => e.cve).sort());
    for (const a of mine) expect(a.fixed_in).toBe("3.12.15");
  });

  it("python=3.13.16 is affected by none of the 3", async () => {
    await runAt(createPyFake(routes()), NOW);
    const res = await get("/v1/check?python=3.13.16", "192.0.2.140");
    const body = (await res.json()) as { affected: { cve_ids: string[] }[] };
    expect(body.affected.filter((a) => EXPECTED.some((e) => a.cve_ids.includes(e.cve)))).toEqual([]);
  });
});
