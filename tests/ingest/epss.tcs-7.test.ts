import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { EPSS_SQL, EPSS_STATE_KEY, EpssFormatError, EpssHttpError, epss } from "../../src/ingest/epss";
import type { AdvisoryInput, IngestContext } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import { createEpssFake, EPSS_FIXTURE_TEXT, FAKE_EPSS_PLAIN_URL, FAKE_EPSS_URL, type SimpleFake } from "./enrich-fake.tcs-7";

// Every EPSS read goes through the fake: 0 real network calls in this file.
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

// The EPSS pass scans every advisory with a CVE, so each test starts from an
// empty advisories table and no EPSS state, then seeds its own rows.
beforeEach(async () => {
  routed = undefined;
  await env.DB.batch([env.DB.prepare("DELETE FROM advisories"), env.DB.prepare("DELETE FROM advisory_sources")]);
  await env.CURSORS.delete(EPSS_STATE_KEY);
});

const SCORE_DATE = "2026-10-22T12:55:00Z";
let seq = 0;

interface Row {
  id: string;
  cve_primary: string | null;
  epss: number | null;
  doc_json: string;
  cursor: number;
}

async function seed(cves: string[], over: Partial<AdvisoryInput> = {}): Promise<Row> {
  seq += 1;
  const sourceId = `GHSA-fixture-tcs7-epss-${seq}`;
  const doc: AdvisoryInput = {
    cve_ids: cves,
    ecosystem: "npm",
    component: `fixture-epss-${seq}`,
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
    ...over,
  };
  await upsertAdvisory(env.DB, doc, { source: "osv", source_id: sourceId });
  const row = await env.DB.prepare(
    "SELECT a.id, a.cve_primary, a.epss, a.doc_json, a.cursor FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
  )
    .bind(sourceId)
    .first<Row>();
  if (!row) throw new Error("seed failed");
  return row;
}

async function reread(id: string): Promise<Row> {
  const row = await env.DB.prepare("SELECT id, cve_primary, epss, doc_json, cursor FROM advisories WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

function ctx(fake: SimpleFake, config: Record<string, unknown> = {}): IngestContext {
  return {
    env,
    source: { id: "epss", kind: "epss", config: { csv_url: FAKE_EPSS_URL, ...config } },
    now: () => new Date("2026-10-22T14:00:00Z"),
    fetch: fake.fetch,
  };
}

const run = (text?: string, config: Record<string, unknown> = {}) => epss.run(ctx(createEpssFake(text), config));

describe("epss ingester", () => {
  it("the gzipped fixture CSV sets epss in 0..1 on matching advisories and does not change the cursor", async () => {
    const log4j = await seed(["CVE-2021-44228"]);
    const other = await seed(["CVE-2026-90022"]);
    const result = await run();
    expect(result.fetched).toBe(1);
    expect(result.upserted).toBe(2);

    const a = await reread(log4j.id);
    expect(a.epss).toBe(0.94358);
    expect(a.cursor).toBe(log4j.cursor);
    const doc = JSON.parse(a.doc_json) as Advisory;
    expect(doc.epss).toBe(0.94358);
    expect(validateAdvisory(doc).ok).toBe(true);
    const b = await reread(other.id);
    expect(b.epss).toBe(0.27511);
    expect(b.epss! >= 0 && b.epss! <= 1).toBe(true);
    expect(b.cursor).toBe(other.cursor);
    expect(JSON.parse(await env.CURSORS.get(EPSS_STATE_KEY) ?? "null")).toEqual({ score_date: SCORE_DATE, after: null });
  });

  it("the same score_date again is skipped: no D1 write", async () => {
    const row = await seed(["CVE-2026-90021"]);
    await run();
    // Change the stored value out of band; a skipped run must leave it.
    await env.DB.prepare("UPDATE advisories SET epss = 0.5 WHERE id = ?").bind(row.id).run();
    const result = await run();
    expect(result).toMatchObject({ fetched: 1, upserted: 0, errors: [] });
    expect((await reread(row.id)).epss).toBe(0.5);
  });

  it("a new score_date with a changed value updates epss and keeps the cursor", async () => {
    const row = await seed(["CVE-2026-90021"]);
    await run();
    const text = EPSS_FIXTURE_TEXT.replace(SCORE_DATE, "2026-10-23T12:55:00Z").replace("CVE-2026-90021,0.00043", "CVE-2026-90021,0.01234");
    const result = await run(text);
    expect(result.upserted).toBe(1);
    const after = await reread(row.id);
    expect(after.epss).toBe(0.01234);
    expect((JSON.parse(after.doc_json) as Advisory).epss).toBe(0.01234);
    expect(after.cursor).toBe(row.cursor);
  });

  it("a CVE absent from the CSV keeps its stored epss", async () => {
    const row = await seed(["CVE-2026-829999"], { epss: 0.33 });
    expect(row.epss).toBe(0.33);
    await run();
    expect(await reread(row.id)).toEqual(row);
  });

  it("a row with epss 1.7 is skipped with an error; the other rows are still written", async () => {
    const bad = await seed(["CVE-2026-90023"]);
    const good = await seed(["CVE-2026-90024"]);
    const result = await run();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toBe("EPSS row skipped: CVE-2026-90023,1.7,0.5");
    expect(await reread(bad.id)).toEqual(bad);
    expect((await reread(good.id)).epss).toBe(0.0021);
  });

  it("a CSV without score_date throws EpssFormatError and writes nothing", async () => {
    const row = await seed(["CVE-2026-90021"]);
    const text = EPSS_FIXTURE_TEXT.replace(/^#.*\n/, "#model_version:v2025.03.14\n");
    await expect(run(text)).rejects.toBeInstanceOf(EpssFormatError);
    await expect(run("cve,epss,percentile\nCVE-2026-90021,0.1,0.2\n")).rejects.toBeInstanceOf(EpssFormatError);
    expect(await reread(row.id)).toEqual(row);
    expect(await env.CURSORS.get(EPSS_STATE_KEY)).toBeNull();
  });

  it("HTTP 500 throws EpssHttpError", async () => {
    await expect(epss.run(ctx(createEpssFake(undefined, { status: 500 })))).rejects.toBeInstanceOf(EpssHttpError);
  });

  it("a plain (not gzipped) CSV URL also works", async () => {
    const row = await seed(["CVE-2026-90022"]);
    await epss.run(ctx(createEpssFake(), { csv_url: FAKE_EPSS_PLAIN_URL }));
    expect((await reread(row.id)).epss).toBe(0.27511);
  });

  it("page_size 1, max_pages 1 with 2 advisories: 1 written and state.after set; the next run finishes", async () => {
    const a = await seed(["CVE-2021-44228"]);
    const b = await seed(["CVE-2026-90022"]);
    const first = await run(undefined, { page_size: 1, max_pages: 1 });
    expect(first.upserted).toBe(1);
    expect(first.incomplete).toBe(true);
    expect((await reread(a.id)).epss).toBe(0.94358);
    expect((await reread(b.id)).epss).toBeNull();
    expect(JSON.parse(await env.CURSORS.get(EPSS_STATE_KEY) ?? "null")).toEqual({ score_date: SCORE_DATE, after: "CVE-2021-44228" });
    const second = await run(undefined, { page_size: 1, max_pages: 1 });
    expect(second.upserted).toBe(1);
    expect((await reread(b.id)).epss).toBe(0.27511);
    // [b] filled the page, so one more run sees the empty page and closes the day.
    const third = await run(undefined, { page_size: 1, max_pages: 1 });
    expect(third.incomplete).toBe(false);
    expect(JSON.parse(await env.CURSORS.get(EPSS_STATE_KEY) ?? "null")).toEqual({ score_date: SCORE_DATE, after: null });
  });

  it("a full page never splits the rows of one CVE", async () => {
    const a1 = await seed(["CVE-2021-44228"]);
    const a2 = await seed(["CVE-2021-44228"], { ecosystem: "PyPI" });
    const b = await seed(["CVE-2026-90022"]);
    await run(undefined, { page_size: 2, max_pages: 1 });
    expect((await reread(a1.id)).epss).toBe(0.94358);
    expect((await reread(a2.id)).epss).toBe(0.94358);
    await run(undefined, { page_size: 2, max_pages: 1 });
    expect((await reread(b.id)).epss).toBe(0.27511);
  });

  it("a 300,000-row gzipped CSV (the real file size) writes all 50 matching advisories and keeps the cursor", { timeout: 120_000 }, async () => {
    const ROWS = 300_000;
    const score = (i: number) => ((i * 7919) % 99_991) / 100_000;
    const cveOf = (i: number) => `CVE-2025-${100_000 + i}`;
    const parts = [`#model_version:v2025.03.14,score_date:${SCORE_DATE}`, "cve,epss,percentile"];
    for (let i = 0; i < ROWS; i++) parts.push(`${cveOf(i)},${score(i)},0.5`);
    const text = parts.join("\n") + "\n";

    const picks = Array.from({ length: 50 }, (_, k) => k * 6_000 + 17);
    const seeded = [];
    for (const i of picks) seeded.push({ i, row: await seed([cveOf(i)]) });

    const started = Date.now();
    const result = await run(text);
    const ms = Date.now() - started;
    console.info(`EPSS volume: 300,000 CSV rows, 50 matches, epss.run took ${ms} ms on this box`);

    expect(result).toMatchObject({ fetched: 1, upserted: 50, errors: [], incomplete: false });
    for (const { i, row } of seeded) {
      const after = await reread(row.id);
      expect(after.epss).toBe(score(i));
      expect((JSON.parse(after.doc_json) as Advisory).epss).toBe(score(i));
      expect(after.cursor).toBe(row.cursor);
    }
  });

  it("EXPLAIN: the scan and group queries use idx_advisories_cve_primary on 2,000 seeded rows", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor) VALUES (?, ?, 'npm', 'pkg-fixture', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)",
    );
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 2000; i++) stmts.push(insert.bind(`tcs_explain_epss_${i}`, i % 9 === 0 ? null : `CVE-2023-${40000 + i}`, 700000 + i));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("ANALYZE").run();
    for (const [sql, params] of [
      [EPSS_SQL.page, ["", 500]],
      [EPSS_SQL.group, ["CVE-2023-40001"]],
    ] as const) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join("\n");
      expect(plan).toContain("idx_advisories_cve_primary");
      expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
    }
  });
});

describe("epss from the production cron", () => {
  it("worker.scheduled runs the epss source through the default registry (scheduled)", async () => {
    const row = await seed(["CVE-2026-90022"]);
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    await env.DB.prepare("UPDATE sources SET enabled = 1, last_error = NULL, config_json = ? WHERE id = 'epss'")
      .bind(JSON.stringify({ csv_url: FAKE_EPSS_URL }))
      .run();
    const fake = createEpssFake();
    routed = fake.fetch;
    const ec = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ec);
    await waitOnExecutionContext(ec);
    routed = undefined;
    expect(fake.calls).toEqual([FAKE_EPSS_URL]);
    expect((await reread(row.id)).epss).toBe(0.27511);
  });
});
