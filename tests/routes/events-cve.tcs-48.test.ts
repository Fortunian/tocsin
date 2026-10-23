import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ADVISORIES_BY_CVE_SQL } from "../../src/routes/advisory";
import type { Advisory } from "../../src/schema/advisory";
import { docFor, get, idFor } from "./seed.tcs-3";

// TCS-48: /v1/events/cve/<CVE> answers for every CVE id of an advisory (any
// entry of cve_ids, through advisory_cves), not only cve_primary = cve_ids[0].
// Rows are written as ingest writes them (src/ingest/upsert.ts): cve_primary is
// cve_ids[0] and there is one advisory_cves row per cve_ids entry. Each test
// uses its own id prefix, cursor band and client IP.

const CVE_A = "CVE-2026-48001";
const CVE_B = "CVE-2026-48002";
const CVE_C = "CVE-2026-48003";

async function seedMulti(rows: { id: string; cursor: number; cves: string[] }[]): Promise<Advisory[]> {
  const insert = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const link = env.DB.prepare("INSERT INTO advisory_cves (cve, advisory_id) VALUES (?, ?)");
  const docs: Advisory[] = [];
  const stmts = [];
  for (const r of rows) {
    const d = docFor({ id: r.id, cursor: r.cursor });
    d.cve_ids = r.cves;
    docs.push(d);
    stmts.push(
      insert.bind(
        d.id,
        r.cves[0] ?? null,
        d.ecosystem,
        d.component,
        d.severity.label,
        d.exploited ? 1 : 0,
        d.published_at,
        d.modified_at,
        JSON.stringify(d),
        r.cursor,
      ),
    );
    for (const cve of r.cves) stmts.push(link.bind(cve, d.id));
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return docs;
}

async function idAt(path: string, ip: string): Promise<string> {
  const res = await get(path, ip);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  return ((await res.json()) as Advisory).id;
}

describe("GET /v1/events/cve/:cve reads every CVE of an advisory", () => {
  it("an advisory with cve_ids [A, B] answers for A, for B and for lower-case b", async () => {
    const ip = "192.0.2.148";
    const [doc] = await seedMulti([{ id: idFor("ECV", 0), cursor: 4_800_001, cves: [CVE_A, CVE_B] }]);
    expect(await idAt(`/v1/events/cve/${CVE_A}`, ip)).toBe(doc.id);
    expect(await idAt(`/v1/events/cve/${CVE_B}`, ip)).toBe(doc.id);
    expect(await idAt(`/v1/events/cve/${CVE_B.toLowerCase()}`, ip)).toBe(doc.id);
  });

  it("when two advisories list the CVE, the one with the lower cursor answers", async () => {
    const ip = "192.0.2.149";
    const D = "CVE-2026-48004";
    const E = "CVE-2026-48005";
    const [late, early] = await seedMulti([
      { id: idFor("ECW", 0), cursor: 4_800_010, cves: [D, CVE_C] },
      { id: idFor("ECW", 1), cursor: 4_800_005, cves: [E, CVE_C] },
    ]);
    expect(await idAt(`/v1/events/cve/${CVE_C}`, ip)).toBe(early.id);
    expect(await idAt(`/v1/events/cve/${D}`, ip)).toBe(late.id);
  });

  it("an unknown well-formed CVE is 404 with a string error", async () => {
    const res = await get("/v1/events/cve/CVE-2026-48999", "192.0.2.150");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
  });
});

describe("the /v1/events/cve read plan on 2,000 advisories", () => {
  beforeAll(async () => {
    await seedMulti(
      Array.from({ length: 2000 }, (_, i) => ({
        id: idFor("ECQ", i),
        cursor: 4_810_001 + i,
        cves: [`CVE-2025-${60000 + (i % 1000)}`, `CVE-2025-${70000 + (i % 700)}`],
      })),
    );
    // No ANALYZE: the plan must hold on the default planner statistics.
  });

  it("searches the advisory_cves primary key, then advisories by id, with no SCAN", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${ADVISORIES_BY_CVE_SQL}`)
      .bind("CVE-2025-70007", 1)
      .all<{ detail: string }>();
    const p = results.map((r) => r.detail).join("\n");
    expect(p).toMatch(/SEARCH c USING (COVERING )?INDEX sqlite_autoindex_advisory_cves_1 \(cve=\?\)/);
    expect(p).toMatch(/SEARCH a USING INDEX sqlite_autoindex_advisories_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN/);
  });
});
