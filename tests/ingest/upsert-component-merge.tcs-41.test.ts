import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AdvisoryInput } from "../../src/ingest/types";
import { UPSERT_SQL, upsertAdvisory } from "../../src/ingest/upsert";

// A CVE merge across sources happens only into a stored row with the same
// ecosystem AND component. OSV already holds the deno CVEs as crates.io/deno.

let seq = 0;
const uniq = (p: string) => `${p}-tcs41-${Date.now().toString(36)}-${++seq}`;
const newCve = () => `CVE-2099-${String(Date.now() % 1_000_000).padStart(6, "0")}${++seq}`;

function doc(source: string, sourceId: string, ecosystem: string, component: string, cve: string): AdvisoryInput {
  return {
    cve_ids: [cve],
    ecosystem,
    component,
    affected: [{ introduced: "0", fixed: "2.1.7" }],
    fixed_versions: ["2.1.7"],
    severity: { label: "high" },
    exploited: false,
    published_at: "2026-10-20T00:00:00Z",
    modified_at: "2026-10-20T00:00:00Z",
    summary: "Synthetic merge test advisory.",
    action: `Upgrade ${component} to 2.1.7 or later.`,
    references: [`https://example.com/${source}/${sourceId}`],
    sources: [{ source, source_id: sourceId, url: `https://example.com/${source}/${sourceId}` }],
  };
}

async function rowsFor(cve: string): Promise<{ ecosystem: string; component: string; sources: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.ecosystem, a.component, (SELECT group_concat(s.source, ',') FROM (SELECT source FROM advisory_sources WHERE advisory_id = a.id ORDER BY source) s) AS sources
     FROM advisories a WHERE a.cve_primary = ? ORDER BY a.ecosystem`,
  )
    .bind(cve)
    .all<{ ecosystem: string; component: string; sources: string }>();
  return results;
}

describe("upsertAdvisory: CVE merge only within the same ecosystem and component", () => {
  it("A: OSV crates.io/deno first, then deno-runtime deno/deno: two rows", async () => {
    const cve = newCve();
    expect(await upsertAdvisory(env.DB, doc("osv", uniq("osv"), "crates.io", "deno", cve), { source: "osv", source_id: uniq("osv-a") })).toBe("inserted");
    const g = uniq("ghsa");
    expect(await upsertAdvisory(env.DB, doc("deno-runtime", g, "deno", "deno", cve), { source: "deno-runtime", source_id: g })).toBe("inserted");
    expect(await rowsFor(cve)).toEqual([
      { ecosystem: "crates.io", component: "deno", sources: "osv" },
      { ecosystem: "deno", component: "deno", sources: "deno-runtime" },
    ]);
  });

  it("B: deno-runtime first, then OSV crates.io/deno: the same two rows", async () => {
    const cve = newCve();
    const g = uniq("ghsa");
    await upsertAdvisory(env.DB, doc("deno-runtime", g, "deno", "deno", cve), { source: "deno-runtime", source_id: g });
    const o = uniq("osv");
    expect(await upsertAdvisory(env.DB, doc("osv", o, "crates.io", "deno", cve), { source: "osv", source_id: o })).toBe("inserted");
    expect(await rowsFor(cve)).toEqual([
      { ecosystem: "crates.io", component: "deno", sources: "osv" },
      { ecosystem: "deno", component: "deno", sources: "deno-runtime" },
    ]);
  });

  it("C: the same ecosystem and component from two sources still merge into one row", async () => {
    const cve = newCve();
    const o = uniq("osv");
    await upsertAdvisory(env.DB, doc("osv", o, "deno", "deno", cve), { source: "osv", source_id: o });
    const g = uniq("ghsa");
    expect(await upsertAdvisory(env.DB, doc("deno-runtime", g, "deno", "deno", cve), { source: "deno-runtime", source_id: g })).toBe("updated");
    expect(await rowsFor(cve)).toEqual([{ ecosystem: "deno", component: "deno", sources: "deno-runtime,osv" }]);
  });

  it("an npm/x row and a node/node doc with the same CVE do not merge", async () => {
    const cve = newCve();
    const o = uniq("osv");
    await upsertAdvisory(env.DB, doc("osv", o, "npm", "undici", cve), { source: "osv", source_id: o });
    const n = uniq("node");
    expect(await upsertAdvisory(env.DB, doc("node-runtime", n, "node", "node", cve), { source: "node-runtime", source_id: n })).toBe("inserted");
    expect((await rowsFor(cve)).map((r) => `${r.ecosystem}/${r.component}:${r.sources}`)).toEqual(["node/node:node-runtime", "npm/undici:osv"]);
  });

  it("the same ecosystem but another component does not merge", async () => {
    const cve = newCve();
    const o = uniq("osv");
    await upsertAdvisory(env.DB, doc("osv", o, "crates.io", "deno_fetch", cve), { source: "osv", source_id: o });
    const p = uniq("osv2");
    expect(await upsertAdvisory(env.DB, doc("other", p, "crates.io", "deno", cve), { source: "other", source_id: p })).toBe("inserted");
    expect((await rowsFor(cve)).length).toBe(2);
  });

  it("D: EXPLAIN of findByCve on 2,000 seeded rows seeks idx_advisories_cve_primary and scans no advisories", async () => {
    const stmts = [];
    const ins = env.DB.prepare(
      "INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor) VALUES (?, ?, ?, ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)",
    );
    for (let i = 0; i < 2000; i++) {
      const id = "tcs_41EXPLA" + String(i).padStart(19, "0");
      stmts.push(ins.bind(id, `CVE-2098-${String(100000 + (i % 700))}`, i % 3 === 0 ? "crates.io" : i % 3 === 1 ? "deno" : "npm", i % 2 ? "deno" : "left-pad", 9_400_000 + i));
    }
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("ANALYZE").run();
    try {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${UPSERT_SQL.findByCve}`).bind("CVE-2098-100005", "osv", "deno", "deno").all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join("\n");
      expect(plan).toContain("idx_advisories_cve_primary");
      expect(plan).not.toMatch(/SCAN (a|advisories)\b(?! USING)/);
    } finally {
      await env.DB.prepare("DELETE FROM advisories WHERE id LIKE 'tcs_41EXPLA%'").run();
    }
  });
});
