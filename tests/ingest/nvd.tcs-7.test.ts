import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { NVD_SCAN_KEY, NVD_SQL, nvd, nvdQueriedKey } from "../../src/ingest/nvd";
import type { AdvisoryInput, IngestContext } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import { createNvdFake, FAKE_NVD_BASE, type NvdAnswer, type NvdFake } from "./enrich-fake.tcs-7";

// Every NVD read goes through the fake. The global fetch is refused, so a
// call that escapes the seam is counted here and fails the file.
let refused = 0;
let routed: typeof fetch | undefined;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (routed) return routed(input, init);
    refused += 1;
    throw new Error(`real network call refused: ${String(input)}`);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  expect(refused).toBe(0);
  vi.restoreAllMocks();
});

// The NVD candidate scan reads every pending row, so each test starts from an
// empty advisories table and no scan position, then seeds its own rows.
beforeEach(async () => {
  routed = undefined;
  await env.DB.batch([env.DB.prepare("DELETE FROM advisories"), env.DB.prepare("DELETE FROM advisory_sources")]);
  await env.CURSORS.delete(NVD_SCAN_KEY);
});

let seq = 0;
let cveSeq = 810000;
function newCve(): string {
  cveSeq += 1;
  return `CVE-2026-${cveSeq}`;
}

function osvDoc(sourceId: string, cves: string[], over: Partial<AdvisoryInput> = {}): AdvisoryInput {
  return {
    cve_ids: cves,
    ecosystem: "npm",
    component: "fixture-pkg",
    affected: [{ introduced: "0", fixed: "1.0.1" }],
    fixed_versions: ["1.0.1"],
    severity: { label: "unknown" },
    exploited: false,
    published_at: "2026-10-20T00:00:00Z",
    modified_at: "2026-10-20T00:00:00Z",
    summary: "Fixture advisory.",
    action: "Upgrade fixture-pkg to 1.0.1 or later.",
    references: [`https://osv.dev/vulnerability/${sourceId}`],
    sources: [{ source: "osv", source_id: sourceId, url: `https://osv.dev/vulnerability/${sourceId}` }],
    ...over,
  };
}

interface Row {
  id: string;
  cve_primary: string | null;
  severity_label: string;
  severity_score: number | null;
  doc_json: string;
  cursor: number;
}

// Seeds one advisory through the production upsert (an OSV creator) and returns its row.
async function seed(cves: string[], over: Partial<AdvisoryInput> = {}): Promise<Row> {
  seq += 1;
  const sourceId = `GHSA-fixture-tcs7-nvd-${seq}`;
  await upsertAdvisory(env.DB, osvDoc(sourceId, cves, over), { source: "osv", source_id: sourceId });
  const row = await env.DB.prepare(
    "SELECT a.id, a.cve_primary, a.severity_label, a.severity_score, a.doc_json, a.cursor FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
  )
    .bind(sourceId)
    .first<Row>();
  if (!row) throw new Error("seed failed");
  return row;
}

async function reread(id: string): Promise<Row> {
  const row = await env.DB.prepare("SELECT id, cve_primary, severity_label, severity_score, doc_json, cursor FROM advisories WHERE id = ?")
    .bind(id)
    .first<Row>();
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

function ctx(fake: NvdFake, config: Record<string, unknown> = {}, extraEnv: Partial<Env> = {}): IngestContext {
  return {
    env: { ...env, ...extraEnv } as Env,
    source: { id: "nvd", kind: "nvd", config: { api_base: FAKE_NVD_BASE, ...config } },
    now: () => new Date("2026-10-22T14:00:00Z"),
    fetch: fake.fetch,
  };
}

async function runWith(answers: Record<string, NvdAnswer> = {}, config: Record<string, unknown> = {}, extraEnv: Partial<Env> = {}) {
  const fake = createNvdFake(answers);
  const result = await nvd.run(ctx(fake, config, extraEnv));
  return { fake, result };
}

describe("nvd ingester", () => {
  it("a scoreless advisory gets score 9.2 and label critical, with an nvd source entry and a new cursor", async () => {
    const cve = newCve();
    const before = await seed([cve]);
    const { fake, result } = await runWith();
    expect(fake.calls.map((c) => c.cve)).toEqual([cve]);
    expect(fake.calls[0].url).toBe(`${FAKE_NVD_BASE}?cveId=${cve}`);
    expect(result).toMatchObject({ fetched: 1, upserted: 1, errors: [] });

    const after = await reread(before.id);
    expect(after.severity_score).toBe(9.2);
    expect(after.severity_label).toBe("critical");
    expect(after.cursor).toBeGreaterThan(before.cursor);
    const doc = JSON.parse(after.doc_json) as Advisory;
    expect(doc.severity).toEqual({ score: 9.2, label: "critical" });
    const prev = JSON.parse(before.doc_json) as Advisory;
    expect(doc.sources[0]).toEqual(prev.sources[0]);
    expect(doc.sources[doc.sources.length - 1]).toEqual({ source: "nvd", source_id: cve, url: `https://nvd.nist.gov/vuln/detail/${cve}` });
    expect(validateAdvisory(doc).ok).toBe(true);
  });

  it("a second run makes zero HTTP calls", async () => {
    const cve = newCve();
    await seed([cve]);
    await runWith();
    const { fake, result } = await runWith();
    expect(fake.calls.length).toBe(0);
    expect(result.fetched).toBe(0);
  });

  it("a no-metrics answer writes nothing, marks the CVE in KV, and the next run makes 0 calls", async () => {
    const cve = newCve();
    const before = await seed([cve]);
    const first = await runWith({ [cve]: "no-metrics" });
    expect(first.fake.calls.length).toBe(1);
    expect(first.result).toMatchObject({ fetched: 1, upserted: 0, errors: [] });
    expect(await reread(before.id)).toEqual(before);
    expect(await env.CURSORS.get(nvdQueriedKey(cve))).toBe("2026-10-22T14:00:00.000Z");
    const second = await runWith({ [cve]: "no-metrics" });
    expect(second.fake.calls.length).toBe(0);
  });

  it("totalResults 0 is an answer: nothing written, KV marked", async () => {
    const cve = newCve();
    const before = await seed([cve]);
    const { fake } = await runWith({ [cve]: "no-results" });
    expect(fake.calls.length).toBe(1);
    expect(await reread(before.id)).toEqual(before);
    expect(await env.CURSORS.get(nvdQueriedKey(cve))).not.toBeNull();
  });

  it("a CVE already marked in KV is not queried and its row is unchanged", async () => {
    const cve = newCve();
    const before = await seed([cve]);
    await env.CURSORS.put(nvdQueriedKey(cve), "2026-10-22T13:00:00.000Z");
    const { fake } = await runWith();
    expect(fake.calls.length).toBe(0);
    expect(await reread(before.id)).toEqual(before);
  });

  it("an advisory that already has a score is not queried", async () => {
    const cve = newCve();
    await seed([cve], { severity: { score: 5.3, label: "medium" } });
    const { fake } = await runWith();
    expect(fake.calls.length).toBe(0);
  });

  it("an advisory with no CVE is not queried", async () => {
    await seed([]);
    const { fake } = await runWith();
    expect(fake.calls.length).toBe(0);
  });

  it("two advisories with one CVE: 1 HTTP call, both rows scored", async () => {
    const cve = newCve();
    const a = await seed([cve]);
    const b = await seed([cve], { ecosystem: "PyPI", component: "fixture-py" });
    expect(a.id).not.toBe(b.id);
    const { fake, result } = await runWith();
    expect(fake.calls.length).toBe(1);
    expect(result.upserted).toBe(2);
    expect((await reread(a.id)).severity_score).toBe(9.2);
    expect((await reread(b.id)).severity_score).toBe(9.2);
  });

  it("max_requests_per_run 2 with 3 pending CVEs: 2 calls, the third on the next run", async () => {
    const cves = [newCve(), newCve(), newCve()];
    const rows = [];
    for (const c of cves) rows.push(await seed([c]));
    const first = await runWith({}, { max_requests_per_run: 2 });
    expect(first.fake.calls.map((c) => c.cve)).toEqual(cves.slice(0, 2));
    expect(first.result.deferred).toBe(1);
    expect((await reread(rows[2].id)).severity_score).toBeNull();
    const second = await runWith({}, { max_requests_per_run: 2 });
    expect(second.fake.calls.map((c) => c.cve)).toEqual([cves[2]]);
    expect((await reread(rows[2].id)).severity_score).toBe(9.2);
  });

  it("a KV-marked CVE does not starve the CVEs after it (scan position moves past it)", async () => {
    const marked = [newCve(), newCve()];
    const open = newCve();
    for (const c of marked) {
      await seed([c]);
      await env.CURSORS.put(nvdQueriedKey(c), "2026-10-22T13:00:00.000Z");
    }
    await seed([open]);
    // scan_limit 3 reads [marked, marked, open]; the full page holds back its last CVE.
    const { fake } = await runWith({}, { max_requests_per_run: 1, scan_limit: 3 });
    expect(fake.calls.length).toBe(0);
    const next = await runWith({}, { max_requests_per_run: 1, scan_limit: 3 });
    expect(next.fake.calls.map((c) => c.cve)).toEqual([open]);
  });

  it("a full scan page never splits the rows of one CVE", async () => {
    const first = newCve();
    const second = newCve();
    const a = await seed([first]);
    const b1 = await seed([second]);
    const b2 = await seed([second], { ecosystem: "PyPI", component: "fixture-py" });
    // scan_limit 2 reads [first, second(b1)]: the split CVE waits for the next page.
    const run1 = await runWith({}, { scan_limit: 2 });
    expect(run1.fake.calls.map((c) => c.cve)).toEqual([first]);
    expect((await reread(a.id)).severity_score).toBe(9.2);
    const run2 = await runWith({}, { scan_limit: 2 });
    expect(run2.fake.calls.map((c) => c.cve)).toEqual([second]);
    expect((await reread(b1.id)).severity_score).toBe(9.2);
    expect((await reread(b2.id)).severity_score).toBe(9.2);
  });

  it("without NVD_API_KEY: default cap 5, no apiKey header", async () => {
    for (let i = 0; i < 7; i++) await seed([newCve()]);
    const { fake, result } = await runWith();
    expect(fake.calls.length).toBe(5);
    expect(result.deferred).toBe(2);
    expect(fake.calls.every((c) => c.apiKey === null)).toBe(true);
  });

  it("with NVD_API_KEY: default cap 50 and the apiKey header on every call", async () => {
    for (let i = 0; i < 7; i++) await seed([newCve()]);
    const { fake } = await runWith({}, {}, { NVD_API_KEY: "nvd-key-fixture-1" });
    expect(fake.calls.length).toBe(7);
    expect(fake.calls.every((c) => c.apiKey === "nvd-key-fixture-1")).toBe(true);
  });

  it("HTTP 503: an error, the CVE is not marked, the row is unchanged, the loop stops", async () => {
    const bad = newCve();
    const next = newCve();
    const row = await seed([bad]);
    const nextRow = await seed([next]);
    const { fake, result } = await runWith({ [bad]: 503 });
    expect(fake.calls.map((c) => c.cve)).toEqual([bad]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("503");
    expect(await env.CURSORS.get(nvdQueriedKey(bad))).toBeNull();
    expect(await reread(row.id)).toEqual(row);
    expect(await reread(nextRow.id)).toEqual(nextRow);
    // The scan does not move past the failed CVE: the next run tries it again.
    const retry = await runWith();
    expect(retry.fake.calls.map((c) => c.cve)).toEqual([bad, next]);
  });

  it("HTTP 429 and 403 stop the loop and mark nothing", async () => {
    for (const status of [429, 403]) {
      const cve = newCve();
      await seed([cve]);
      const { result } = await runWith({ [cve]: status });
      expect(result.errors[0]).toContain(String(status));
      expect(await env.CURSORS.get(nvdQueriedKey(cve))).toBeNull();
      await env.DB.prepare("DELETE FROM advisories").run();
    }
  });

  it("HTTP 404 is an answer with no score: KV marked, row unchanged", async () => {
    const cve = newCve();
    const row = await seed([cve]);
    const { result } = await runWith({ [cve]: 404 });
    expect(result.errors).toEqual([]);
    expect(await env.CURSORS.get(nvdQueriedKey(cve))).not.toBeNull();
    expect(await reread(row.id)).toEqual(row);
  });

  it("a bad config value throws before any call", async () => {
    await seed([newCve()]);
    const fake = createNvdFake();
    await expect(nvd.run(ctx(fake, { max_requests_per_run: 0 }))).rejects.toThrow(/max_requests_per_run/);
    await expect(nvd.run(ctx(fake, { api_base: "ftp://x" }))).rejects.toThrow(/api_base/);
    expect(fake.calls.length).toBe(0);
  });

  it("EXPLAIN: the candidate query uses idx_advisories_nvd_pending on 2,000 seeded rows, no table scan", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_score, published_at, modified_at, doc_json, cursor) VALUES (?, ?, 'npm', 'pkg-fixture', ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)",
    );
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 2000; i++) stmts.push(insert.bind(`tcs_explain_nvd_${i}`, i % 7 === 0 ? null : `CVE-2025-${20000 + i}`, i % 2 === 0 ? 7.5 : null, 900000 + i));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("ANALYZE").run();
    for (const [sql, params] of [
      [NVD_SQL.page, ["", 500]],
      [NVD_SQL.group, ["CVE-2025-20001"]],
    ] as const) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join("\n");
      expect(plan).toContain("idx_advisories_nvd_pending");
      expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
    }
  });
});

describe("nvd from the production cron", () => {
  it("worker.scheduled runs the nvd source through the default registry (scheduled)", async () => {
    const cve = newCve();
    const row = await seed([cve]);
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    await env.DB.prepare("UPDATE sources SET enabled = 1, last_error = NULL, config_json = ? WHERE id = 'nvd'")
      .bind(JSON.stringify({ api_base: FAKE_NVD_BASE }))
      .run();
    const fake = createNvdFake();
    routed = fake.fetch;
    const ec = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ec);
    await waitOnExecutionContext(ec);
    routed = undefined;
    expect(fake.calls.map((c) => c.cve)).toEqual([cve]);
    expect((await reread(row.id)).severity_score).toBe(9.2);
    const s = await env.DB.prepare("SELECT last_ok_at, last_error FROM sources WHERE id = 'nvd'").first<{ last_ok_at: string | null; last_error: string | null }>();
    expect(s?.last_error).toBeNull();
    expect(s?.last_ok_at).not.toBeNull();
  });
});
