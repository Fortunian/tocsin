import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../../src/index";
import { BARE_KEY_SQL, DEFAULT_ECOSYSTEMS, normalizeOsv, osv, type OsvVuln } from "../../src/ingest/osv";
import type { IngestContext } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import { createOsvFake, FAKE_API_BASE, FAKE_CSV_BASE, type FakeRecord } from "./osv-fake";

// TCS-38 review fix: the bare OSV id is the source key of the first enabled
// package of a record. Enabling Maven (and the other new ecosystems) can put a
// new package before a stored one. The stored advisory must keep its id,
// ecosystem and component, and its package must not be stored a second time.
// The record is assumed (hand-written): a Maven webjar listed before its npm package.
// Each test uses its own record id (suffix -tcs38sk<tag>) and CVE, so tests never share rows.

const TOKEN = "tok-fixture-import-38sk";
const CURSOR_KEY = "cursor:osv";
const MAVEN_FIRST = [...DEFAULT_ECOSYSTEMS, "Maven", "NuGet", "Hex", "Pub", "Alpine", "Debian"];

function mixed(tag: string, cve: string, modified: string): OsvVuln {
  const pkg = `foo-38sk-${tag}`;
  return {
    id: `GHSA-r7xq-38sk-${tag}`,
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

function ctxFor(records: OsvVuln[], ecosystems: string[]): IngestContext {
  return {
    env,
    source: { id: "osv", kind: "osv", config: { csv_base: FAKE_CSV_BASE, api_base: FAKE_API_BASE, ecosystems } },
    now: () => new Date("2026-10-22T00:00:00Z"),
    fetch: createOsvFake(records as unknown as FakeRecord[]).fetch,
  };
}

async function importPost(body: unknown): Promise<Response> {
  const e = { ...env, IMPORT_TOKEN: TOKEN } as typeof env & { IMPORT_TOKEN: string };
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://tocsin.test/v1/internal/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

type Row = { source_id: string; id: string; ecosystem: string; component: string; creator: string };
async function rowsOf(id: string): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.source_id, a.id, a.ecosystem, a.component, json_extract(a.doc_json, '$.sources[0].source_id') AS creator
     FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id LIKE ? ORDER BY s.source_id`,
  )
    .bind(`${id}%`)
    .all<Row>();
  return results;
}

async function npmCount(tag: string): Promise<number> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories WHERE ecosystem = 'npm' AND component = ?")
    .bind(`foo-38sk-${tag}`)
    .first<{ n: number }>();
  return n!.n;
}

describe("the bare OSV id stays on the stored package when a new ecosystem comes first", () => {
  it("normalizeOsv alone gives the bare id to the Maven package (the case the ingest must correct)", () => {
    const r = normalizeOsv(mixed("aaaa", "CVE-2026-3800001", "2026-10-02T00:00:00Z"), MAVEN_FIRST);
    expect(r.ok && r.docs.map((d) => [d.source_id, d.doc.ecosystem])).toEqual([
      ["GHSA-r7xq-38sk-aaaa", "Maven"],
      ["GHSA-r7xq-38sk-aaaa#npm/foo-38sk-aaaa", "npm"],
    ]);
  });

  it("cron: npm stored under the bare id keeps its advisory; Maven is a new advisory; a re-run writes nothing", async () => {
    const before = mixed("cron", "CVE-2026-3800002", "2026-10-02T00:00:00Z");
    expect((await osv.run(ctxFor([before], DEFAULT_ECOSYSTEMS))).errors).toEqual([]);
    const [npmRow] = await rowsOf(before.id);
    expect(npmRow).toMatchObject({ source_id: before.id, ecosystem: "npm", component: "foo-38sk-cron" });
    expect(await npmCount("cron")).toBe(1);

    const after = mixed("cron", "CVE-2026-3800002", "2026-10-03T00:00:00Z");
    const res = await osv.run(ctxFor([after], MAVEN_FIRST));
    expect(res.errors).toEqual([]);
    const rows = await rowsOf(after.id);
    expect(rows).toEqual([
      { source_id: after.id, id: npmRow.id, ecosystem: "npm", component: "foo-38sk-cron", creator: after.id },
      { source_id: `${after.id}#Maven/org.webjars.npm:foo-38sk-cron`, id: expect.not.stringMatching(npmRow.id), ecosystem: "Maven", component: "org.webjars.npm:foo-38sk-cron", creator: `${after.id}#Maven/org.webjars.npm:foo-38sk-cron` },
    ]);
    expect(await npmCount("cron")).toBe(1);

    await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
    const again = await osv.run(ctxFor([after], MAVEN_FIRST));
    expect(again).toMatchObject({ upserted: 0, unchanged: 2, errors: [] });
    expect(await rowsOf(after.id)).toEqual(rows);
  });

  it("import route (backfill): the stored npm advisory keeps its id; 0 new npm advisories", async () => {
    const v = mixed("impt", "CVE-2026-3800003", "2026-10-02T00:00:00Z");
    // The state before TCS-38: only the npm package, under the bare id.
    const old = normalizeOsv(v, DEFAULT_ECOSYSTEMS);
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    expect(old.docs.map((d) => d.source_id)).toEqual([v.id]);
    await upsertAdvisory(env.DB, old.doc, { source: "osv", source_id: v.id });
    const [npmRow] = await rowsOf(v.id);

    const res = await importPost({ ecosystem: "Maven", records: [v], skipped: 0, last_id: v.id, start: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 1, errors: [] });
    const rows = await rowsOf(v.id);
    expect(rows.map((r) => [r.source_id, r.id === npmRow.id, r.ecosystem])).toEqual([
      [v.id, true, "npm"],
      [`${v.id}#Maven/org.webjars.npm:foo-38sk-impt`, false, "Maven"],
    ]);
    expect(await npmCount("impt")).toBe(1);
  });

  it("a new record (nothing stored) keeps the normalizeOsv keys", async () => {
    const v = mixed("new0", "CVE-2026-3800004", "2026-10-02T00:00:00Z");
    expect((await osv.run(ctxFor([v], MAVEN_FIRST))).errors).toEqual([]);
    expect((await rowsOf(v.id)).map((r) => [r.source_id, r.ecosystem])).toEqual([
      [v.id, "Maven"],
      [`${v.id}#npm/foo-38sk-new0`, "npm"],
    ]);
  });

  it("a stored package that is no longer in the record is not rewritten: no doc takes the bare id", async () => {
    const v = mixed("gone", "CVE-2026-3800005", "2026-10-02T00:00:00Z");
    expect((await osv.run(ctxFor([v], DEFAULT_ECOSYSTEMS))).errors).toEqual([]);
    const [npmRow] = await rowsOf(v.id);
    const later = mixed("gone", "CVE-2026-3800005", "2026-10-03T00:00:00Z");
    later.affected = later.affected!.slice(0, 1);
    expect((await osv.run(ctxFor([later], MAVEN_FIRST))).errors).toEqual([]);
    const rows = await rowsOf(v.id);
    expect(rows.map((r) => [r.source_id, r.ecosystem])).toEqual([
      [v.id, "npm"],
      [`${v.id}#Maven/org.webjars.npm:foo-38sk-gone`, "Maven"],
    ]);
    expect(rows[0].id).toBe(npmRow.id);
  });

  it("EXPLAIN: BARE_KEY_SQL seeks both tables by primary key on 1000 seeded rows", async () => {
    const insA = env.DB.prepare(
      `INSERT INTO advisories (id, ecosystem, component, published_at, modified_at, doc_json)
       VALUES (?, 'npm', ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}')`,
    );
    const insS = env.DB.prepare("INSERT INTO advisory_sources (source, source_id, advisory_id) VALUES ('osv', ?, ?)");
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `tcs_explain38sk_${i}`;
      stmts.push(insA.bind(id, `pkg38sk-${i % 40}`), insS.bind(`EX38SK-${i}`, id));
    }
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${BARE_KEY_SQL}`)
      .bind(JSON.stringify(["EX38SK-5", "EX38SK-6"]))
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("sqlite_autoindex_advisory_sources_1");
    expect(plan).toMatch(/SEARCH a USING INDEX sqlite_autoindex_advisories_1/);
    expect(plan).not.toMatch(/SCAN (a|s)\b/);
  });
});
