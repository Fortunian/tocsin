import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AdvisoryInput } from "../../src/ingest/types";
import { newAdvisoryId } from "../../src/ingest/ulid";
import { ENABLED_SOURCES_SQL } from "../../src/ingest/registry";
import { canonicalJson, InvalidAdvisoryError, UPSERT_SQL, upsertAdvisory } from "../../src/ingest/upsert";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";

// Each test uses its own source ids and CVE numbers, so the tests share no rows.
let seq = 0;
function uniq(tag: string): string {
  seq += 1;
  return `${tag}-${Date.now().toString(36)}-${seq}`;
}
let cveSeq = 700000;
function newCve(): string {
  cveSeq += 1;
  return `CVE-2026-${cveSeq}`;
}

function doc(source: string, sourceId: string, over: Partial<AdvisoryInput> = {}): AdvisoryInput {
  return {
    cve_ids: [],
    ecosystem: "npm",
    component: "left-pad",
    affected: [{ introduced: "0", fixed: "1.3.1" }],
    fixed_versions: ["1.3.1"],
    severity: { score: 7.5, label: "high" },
    exploited: false,
    published_at: "2026-10-20T00:00:00Z",
    modified_at: "2026-10-20T00:00:00Z",
    summary: "Test advisory.",
    action: "Upgrade left-pad to 1.3.1 or later.",
    references: [`https://example.com/${source}/${sourceId}`],
    sources: [{ source, source_id: sourceId, url: `https://example.com/${source}/${sourceId}` }],
    ...over,
  };
}

interface Row {
  id: string;
  cve_primary: string | null;
  ecosystem: string;
  component: string;
  severity_label: string;
  severity_score: number | null;
  exploited: number;
  doc_json: string;
  cursor: number;
}

async function advisoryFor(source: string, sourceId: string): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT a.* FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = ? AND s.source_id = ?`,
  )
    .bind(source, sourceId)
    .first<Row>();
}

async function sourceRows(advisoryId: string): Promise<{ source: string; source_id: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT source, source_id FROM advisory_sources WHERE advisory_id = ? ORDER BY source",
  )
    .bind(advisoryId)
    .all<{ source: string; source_id: string }>();
  return results;
}

async function countAdvisoriesWithCve(cve: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories WHERE cve_primary = ?").bind(cve).first<{ n: number }>();
  return r?.n ?? -1;
}

describe("newAdvisoryId (id)", () => {
  it("matches the schema id pattern and 1000 ids are unique", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newAdvisoryId(now);
      expect(id).toMatch(/^tcs_[0-9A-HJKMNP-TV-Z]{26}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });

  it("encodes the time so a later id sorts after an earlier one (id)", () => {
    const a = newAdvisoryId(new Date("2026-10-22T00:00:00Z"));
    const b = newAdvisoryId(new Date("2026-10-22T00:00:01Z"));
    expect(a.slice(4, 14) < b.slice(4, 14)).toBe(true);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });
});

describe("upsertAdvisory", () => {
  it("inserts a new pair with a tcs_ id, a cursor and the indexed columns", async () => {
    const sid = uniq("ins");
    const cve = newCve();
    const r = await upsertAdvisory(env.DB, doc("osv", sid, { cve_ids: [cve] }), { source: "osv", source_id: sid });
    expect(r).toBe("inserted");
    const row = await advisoryFor("osv", sid);
    expect(row).not.toBeNull();
    expect(row!.id).toMatch(/^tcs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row!.cursor).toBeGreaterThan(0);
    expect(row!.cve_primary).toBe(cve);
    expect(row!.ecosystem).toBe("npm");
    expect(row!.component).toBe("left-pad");
    expect(row!.severity_label).toBe("high");
    expect(row!.severity_score).toBe(7.5);
    expect(row!.exploited).toBe(0);
    const stored = JSON.parse(row!.doc_json) as Advisory;
    expect(stored.id).toBe(row!.id);
    expect(validateAdvisory(stored).ok).toBe(true);
    expect(row!.doc_json).toBe(canonicalJson(stored));
  });

  it("same (source, source_id) twice: one advisory row, one advisory_sources row, second call unchanged", async () => {
    const sid = uniq("twice");
    const d = doc("osv", sid);
    expect(await upsertAdvisory(env.DB, d, { source: "osv", source_id: sid })).toBe("inserted");
    const before = await advisoryFor("osv", sid);
    expect(await upsertAdvisory(env.DB, structuredClone(d), { source: "osv", source_id: sid })).toBe("unchanged");
    const after = await advisoryFor("osv", sid);
    expect(after!.cursor).toBe(before!.cursor);
    expect(after!.doc_json).toBe(before!.doc_json);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'osv' AND source_id = ?")
      .bind(sid)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories WHERE id = ?").bind(before!.id).first<{ n: number }>();
    expect(a?.n).toBe(1);
  });

  it("a changed doc keeps its id and gets a higher cursor than before", async () => {
    const sid = uniq("chg");
    await upsertAdvisory(env.DB, doc("osv", sid), { source: "osv", source_id: sid });
    // Another advisory written in between, so "higher" means the global max moved on.
    const other = uniq("chg-other");
    await upsertAdvisory(env.DB, doc("osv", other), { source: "osv", source_id: other });
    const before = await advisoryFor("osv", sid);
    const r = await upsertAdvisory(
      env.DB,
      doc("osv", sid, { summary: "Changed summary.", severity: { score: 9.8, label: "critical" } }),
      { source: "osv", source_id: sid },
    );
    expect(r).toBe("updated");
    const after = await advisoryFor("osv", sid);
    expect(after!.id).toBe(before!.id);
    expect(after!.cursor).toBeGreaterThan(before!.cursor);
    const max = await env.DB.prepare("SELECT MAX(cursor) AS m FROM advisories").first<{ m: number }>();
    expect(after!.cursor).toBe(max!.m);
    expect(after!.severity_label).toBe("critical");
    expect((JSON.parse(after!.doc_json) as Advisory).summary).toBe("Changed summary.");
  });

  it("two sources with the same CVE: one advisory, two advisory_sources rows, merged references and sources", async () => {
    const cve = newCve();
    const osvId = uniq("GHSA");
    const nvdId = cve;
    const first = doc("osv", osvId, { cve_ids: [cve], references: ["https://osv.dev/vulnerability/x", "https://shared.example/a"] });
    expect(await upsertAdvisory(env.DB, first, { source: "osv", source_id: osvId })).toBe("inserted");
    const created = await advisoryFor("osv", osvId);

    const second = doc("nvd-fixture", nvdId, {
      cve_ids: [cve],
      summary: "NVD wording.",
      references: ["https://shared.example/a", "https://nvd.example/b"],
    });
    expect(await upsertAdvisory(env.DB, second, { source: "nvd-fixture", source_id: nvdId })).toBe("updated");

    expect(await countAdvisoriesWithCve(cve)).toBe(1);
    const merged = await advisoryFor("nvd-fixture", nvdId);
    expect(merged!.id).toBe(created!.id);
    expect(merged!.cursor).toBeGreaterThan(created!.cursor);
    expect(await sourceRows(created!.id)).toEqual([
      { source: "nvd-fixture", source_id: nvdId },
      { source: "osv", source_id: osvId },
    ]);
    const stored = JSON.parse(merged!.doc_json) as Advisory;
    expect(stored.sources.map((s) => s.source)).toEqual(["osv", "nvd-fixture"]);
    expect(stored.references).toEqual([
      "https://osv.dev/vulnerability/x",
      "https://shared.example/a",
      "https://nvd.example/b",
    ]);
    // The creator (osv) owns the base fields.
    expect(stored.summary).toBe("Test advisory.");

    // The attached source sending the same doc again changes nothing.
    expect(await upsertAdvisory(env.DB, structuredClone(second), { source: "nvd-fixture", source_id: nvdId })).toBe("unchanged");
    // The creator updating keeps the attached source and its references.
    const creatorUpdate = doc("osv", osvId, { cve_ids: [cve], summary: "OSV update.", references: ["https://osv.dev/vulnerability/x"] });
    expect(await upsertAdvisory(env.DB, creatorUpdate, { source: "osv", source_id: osvId })).toBe("updated");
    const updated = JSON.parse((await advisoryFor("osv", osvId))!.doc_json) as Advisory;
    expect(updated.summary).toBe("OSV update.");
    expect(updated.sources.map((s) => s.source)).toEqual(["osv", "nvd-fixture"]);
    expect(updated.references).toContain("https://nvd.example/b");
  });

  it("negative: two records of the same source with the same CVE stay two advisories", async () => {
    const cve = newCve();
    const a = uniq("GHSA-a");
    const b = uniq("PYSEC-b");
    await upsertAdvisory(env.DB, doc("osv", a, { cve_ids: [cve] }), { source: "osv", source_id: a });
    expect(await upsertAdvisory(env.DB, doc("osv", b, { cve_ids: [cve], ecosystem: "PyPI" }), { source: "osv", source_id: b })).toBe("inserted");
    expect(await countAdvisoriesWithCve(cve)).toBe(2);
    expect((await advisoryFor("osv", a))!.id).not.toBe((await advisoryFor("osv", b))!.id);
  });

  it("negative: records with no CVE never merge", async () => {
    const a = uniq("nocve-a");
    const b = uniq("nocve-b");
    await upsertAdvisory(env.DB, doc("osv", a), { source: "osv", source_id: a });
    expect(await upsertAdvisory(env.DB, doc("nvd-fixture", b), { source: "nvd-fixture", source_id: b })).toBe("inserted");
    expect((await advisoryFor("osv", a))!.id).not.toBe((await advisoryFor("nvd-fixture", b))!.id);
  });

  it("negative: a CVE that is only a non-primary cve_id of another advisory does not merge", async () => {
    const low = newCve();
    const high = newCve();
    const a = uniq("multi");
    await upsertAdvisory(env.DB, doc("osv", a, { cve_ids: [high, low] }), { source: "osv", source_id: a });
    // cve_ids are stored sorted, so the primary is the lower number.
    expect((await advisoryFor("osv", a))!.cve_primary).toBe(low);
    const b = uniq("nvd-high");
    expect(await upsertAdvisory(env.DB, doc("nvd-fixture", b, { cve_ids: [high] }), { source: "nvd-fixture", source_id: b })).toBe("inserted");
    expect((await advisoryFor("nvd-fixture", b))!.id).not.toBe((await advisoryFor("osv", a))!.id);
  });

  it("an invalid doc throws InvalidAdvisoryError and writes no row", async () => {
    const sid = uniq("bad");
    const bad = doc("osv", sid, { summary: "line one\nline two" });
    await expect(upsertAdvisory(env.DB, bad, { source: "osv", source_id: sid })).rejects.toBeInstanceOf(InvalidAdvisoryError);
    expect(await advisoryFor("osv", sid)).toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source_id = ?").bind(sid).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

describe("EXPLAIN: the upsert and registry queries use indexes on seeded data", () => {
  it("EXPLAIN on 2000 advisories + 2000 advisory_sources", async () => {
    const insA = env.DB.prepare(
      `INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor)
       VALUES (?, ?, 'npm', ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)`,
    );
    const insS = env.DB.prepare("INSERT INTO advisory_sources (source, source_id, advisory_id) VALUES ('explain', ?, ?)");
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 2000; i++) {
      const id = `tcs_explain_${i}`;
      stmts.push(insA.bind(id, `CVE-2025-${100000 + i}`, `pkg-${i % 40}`, 5_000_000 + i));
      stmts.push(insS.bind(`EX-${i}`, id));
    }
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));

    const read1 = await plan(UPSERT_SQL.findByPair, "explain", "EX-5");
    expect(read1).toContain("sqlite_autoindex_advisory_sources_1");
    expect(read1).not.toContain("SCAN");

    const read2 = await plan(UPSERT_SQL.findByCve, "CVE-2025-100005", "osv", "npm", "left-pad");
    expect(read2).toContain("idx_advisories_cve_primary");
    expect(read2).toContain("idx_advisory_sources_advisory_id");
    expect(read2).not.toMatch(/SCAN (a|advisories|s|advisory_sources)\b(?! USING)/);

    const maxCursor = await plan(`SELECT ${UPSERT_SQL.nextCursor}`);
    expect(maxCursor).toContain("idx_advisories_cursor");

    // sources is a fixed 6-row table (docs/RETENTION.md); a scan of it is expected and bounded.
    const enabled = await plan(ENABLED_SOURCES_SQL);
    expect(enabled).toMatch(/sources/);
  });
});
