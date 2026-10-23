import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BARE_KEY_SQL, DEFAULT_ECOSYSTEMS, normalizeOsv, osv, type OsvVuln } from "../../src/ingest/osv";
import type { IngestContext } from "../../src/ingest/types";
import { createOsvFake, FAKE_API_BASE, FAKE_CSV_BASE, type CsvRow, type FakeRecord } from "./osv-fake";

// TCS-85: the OSV cron reads the stored bare keys (BARE_KEY_SQL) once per page,
// not once per record. Each test uses its own record ids (suffix -tcs85<tag>) and
// CVEs, so tests never share rows.

const CURSOR_KEY = "cursor:osv";
const MAVEN_FIRST = [...DEFAULT_ECOSYSTEMS, "Maven", "NuGet", "Hex", "Pub", "Alpine", "Debian"];

function countingDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const real = env.DB;
  const db = {
    prepare(q: string) {
      sql.push(q);
      return real.prepare(q);
    },
    batch(stmts: D1PreparedStatement[]) {
      sql.push("<batch>");
      return real.batch(stmts);
    },
    exec(q: string) {
      sql.push(q);
      return real.exec(q);
    },
    dump() {
      return real.dump();
    },
    withSession(...args: Parameters<D1Database["withSession"]>) {
      return real.withSession(...args);
    },
  } as unknown as D1Database;
  return { db, sql };
}

const bareReads = (sql: string[]) => sql.filter((q) => q === BARE_KEY_SQL).length;

// One npm record per index, with a distinct modified second so page order is fixed.
function npmRecords(tag: string, n: number, cveBase: number): OsvVuln[] {
  return Array.from({ length: n }, (_, i) => {
    const pkg = `pkg-tcs85${tag}-${i}`;
    const sec = String(i % 60).padStart(2, "0");
    const min = String(Math.floor(i / 60)).padStart(2, "0");
    return {
      id: `GHSA-tcs85${tag}-${String(i).padStart(4, "0")}`,
      modified: `2026-10-02T00:${min}:${sec}Z`,
      published: "2026-10-01T00:00:00Z",
      aliases: [`CVE-2026-${cveBase + i}`],
      summary: `Issue in ${pkg}`,
      affected: [{ package: { ecosystem: "npm", name: pkg }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }],
      references: [{ type: "WEB", url: `https://example.com/${pkg}` }],
    };
  });
}

function mixed(tag: string, cve: string, modified: string): OsvVuln {
  const pkg = `foo-tcs85${tag}`;
  return {
    id: `GHSA-r7xq-tcs85-${tag}`,
    modified,
    published: "2026-10-01T00:00:00Z",
    aliases: [cve],
    summary: `Prototype pollution in ${pkg}`,
    affected: [
      { package: { ecosystem: "Maven", name: `org.webjars.npm:${pkg}` }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.1" }] }] },
      { package: { ecosystem: "npm", name: pkg }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.1" }] }] },
    ],
    references: [{ type: "WEB", url: `https://example.com/${pkg}` }],
  };
}

function ctxFor(
  records: OsvVuln[],
  db: D1Database,
  config: Record<string, unknown>,
  extraRows: CsvRow[] = [],
): IngestContext {
  return {
    env: { ...env, DB: db },
    source: { id: "osv", kind: "osv", config: { csv_base: FAKE_CSV_BASE, api_base: FAKE_API_BASE, ...config } },
    now: () => new Date("2026-10-22T00:00:00Z"),
    fetch: createOsvFake(records as unknown as FakeRecord[], { extraRows }).fetch,
  };
}

type Row = { source_id: string; id: string; ecosystem: string; component: string };
async function rowsOf(id: string): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.source_id, a.id, a.ecosystem, a.component
     FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id LIKE ? ORDER BY s.source_id`,
  )
    .bind(`${id}%`)
    .all<Row>();
  return results;
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Every OSV read goes through the fake: 0 real network calls.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});
beforeEach(async () => {
  await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
});

describe("OSV cron reads stored bare keys once per page (TCS-85)", () => {
  it("one BARE_KEY_SQL read per page at page_size 100", async () => {
    const records = npmRecords("p100", 100, 8500000);
    const { db, sql } = countingDb();
    const res = await osv.run(ctxFor(records, db, { page_size: 100 }));
    expect(res).toMatchObject({ fetched: 100, upserted: 100, errors: [] });
    expect(bareReads(sql)).toBe(1);
    expect((await rowsOf(records[42].id)).map((r) => r.component)).toEqual(["pkg-tcs85p100-42"]);
  });

  it("250 records at page_size 100 make 3 reads", async () => {
    const records = npmRecords("p250", 250, 8501000);
    const { db, sql } = countingDb();
    const res = await osv.run(ctxFor(records, db, { page_size: 100 }));
    expect(res).toMatchObject({ fetched: 250, upserted: 250, errors: [] });
    expect(bareReads(sql)).toBe(3);
    expect(await env.CURSORS.get(CURSOR_KEY)).toBe(records[249].modified);
  });

  it("a page with one bad record still makes one read and keeps error order", async () => {
    const [a, , c] = npmRecords("bad", 3, 8502000);
    // B is listed in the npm CSV, but its only package is Maven (not enabled).
    const b: OsvVuln = { ...npmRecords("bad", 2, 8502100)[1], id: "GHSA-tcs85bad-bbbb" };
    b.affected = [{ package: { ecosystem: "Maven", name: "org.example:tcs85bad" } }] as OsvVuln["affected"];
    const reason = normalizeOsv(b, DEFAULT_ECOSYSTEMS);
    expect(reason.ok).toBe(false);
    if (reason.ok) return;
    const { db, sql } = countingDb();
    const res = await osv.run(ctxFor([a, b, c], db, { page_size: 3 }, [{ ecosystem: "npm", modified: b.modified, id: b.id }]));
    expect(res).toMatchObject({ fetched: 3, upserted: 2, errors: [`${b.id}: ${reason.reason}`] });
    expect(bareReads(sql)).toBe(1);
    expect((await rowsOf(a.id)).length).toBe(1);
    expect((await rowsOf(c.id)).length).toBe(1);
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("stored bare key holds across a batched page", async () => {
    const before = mixed("keep", "CVE-2026-8503001", "2026-10-02T00:00:00Z");
    const seed = countingDb();
    expect((await osv.run(ctxFor([before], seed.db, {}))).errors).toEqual([]);
    const [npmRow] = await rowsOf(before.id);
    expect(npmRow).toMatchObject({ source_id: before.id, ecosystem: "npm", component: "foo-tcs85keep" });

    await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
    const after = mixed("keep", "CVE-2026-8503001", "2026-10-03T00:00:00Z");
    const others = npmRecords("keep", 2, 8503100);
    const { db, sql } = countingDb();
    const res = await osv.run(ctxFor([after, ...others], db, { ecosystems: MAVEN_FIRST, page_size: 3 }));
    expect(res.errors).toEqual([]);
    expect(bareReads(sql)).toBe(1);
    expect((await rowsOf(after.id)).map((r) => [r.source_id, r.id === npmRow.id, r.ecosystem])).toEqual([
      [after.id, true, "npm"],
      [`${after.id}#Maven/org.webjars.npm:foo-tcs85keep`, false, "Maven"],
    ]);
  });

  it("re-run is idempotent", async () => {
    const records = npmRecords("rerun", 100, 8504000);
    expect((await osv.run(ctxFor(records, countingDb().db, { page_size: 100 }))).upserted).toBe(100);
    await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
    const { db, sql } = countingDb();
    const again = await osv.run(ctxFor(records, db, { page_size: 100 }));
    expect(again).toMatchObject({ fetched: 100, upserted: 0, unchanged: 100, errors: [] });
    expect(bareReads(sql)).toBe(1);
  });

  it("EXPLAIN on a 100-id array uses primary-key seeks", async () => {
    const insA = env.DB.prepare(
      `INSERT INTO advisories (id, ecosystem, component, published_at, modified_at, doc_json)
       VALUES (?, 'npm', ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}')`,
    );
    const insS = env.DB.prepare("INSERT INTO advisory_sources (source, source_id, advisory_id) VALUES ('osv', ?, ?)");
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `tcs_explain85_${i}`;
      stmts.push(insA.bind(id, `pkg85-${i % 40}`), insS.bind(`EX85-${i}`, id));
    }
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    const ids = Array.from({ length: 100 }, (_, i) => `EX85-${i * 7}`);
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${BARE_KEY_SQL}`).bind(JSON.stringify(ids)).all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("sqlite_autoindex_advisory_sources_1");
    expect(plan).toMatch(/SEARCH a USING INDEX sqlite_autoindex_advisories_1/);
    expect(plan).not.toMatch(/SCAN (a|s|advisory_sources|advisories)\b/);
    // The bound array has 100 ids; the read returns each stored one.
    const { results: hits } = await env.DB.prepare(BARE_KEY_SQL).bind(JSON.stringify(ids)).all();
    expect(hits.length).toBe(100);
  });
});
