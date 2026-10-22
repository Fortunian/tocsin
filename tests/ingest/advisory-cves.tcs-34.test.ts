import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AdvisoryInput } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";

// advisory_cves (migration 0010): one row per (cve, advisory), written by
// upsertAdvisory on insert and update, and backfilled by the migration.

function doc(sourceId: string, cves: string[]): AdvisoryInput {
  return {
    cve_ids: cves,
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
    references: [`https://example.com/osv/${sourceId}`],
    sources: [{ source: "osv", source_id: sourceId, url: `https://example.com/osv/${sourceId}` }],
  };
}

async function cvesOf(source: string, sourceId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.cve FROM advisory_sources s JOIN advisory_cves c ON c.advisory_id = s.advisory_id
     WHERE s.source = ? AND s.source_id = ? ORDER BY c.cve`,
  )
    .bind(source, sourceId)
    .all<{ cve: string }>();
  return results.map((r) => r.cve);
}

describe("advisory_cves", () => {
  it("upsertAdvisory writes one row per CVE on insert", async () => {
    expect(await upsertAdvisory(env.DB, doc("GHSA-c34-1", ["CVE-2026-342002", "CVE-2026-342001"]), { source: "osv", source_id: "GHSA-c34-1" })).toBe("inserted");
    expect(await cvesOf("osv", "GHSA-c34-1")).toEqual(["CVE-2026-342001", "CVE-2026-342002"]);
  });

  it("adds a new CVE on update and keeps the old rows, with no duplicate", async () => {
    await upsertAdvisory(env.DB, doc("GHSA-c34-2", ["CVE-2026-342011"]), { source: "osv", source_id: "GHSA-c34-2" });
    expect(await upsertAdvisory(env.DB, doc("GHSA-c34-2", ["CVE-2026-342012"]), { source: "osv", source_id: "GHSA-c34-2" })).toBe("updated");
    expect(await cvesOf("osv", "GHSA-c34-2")).toEqual(["CVE-2026-342011", "CVE-2026-342012"]);
  });

  it("adds the CVE rows when a second source merges by CVE", async () => {
    await upsertAdvisory(env.DB, doc("GHSA-c34-3", ["CVE-2026-342021"]), { source: "osv", source_id: "GHSA-c34-3" });
    const other = doc("NODE-c34-3", ["CVE-2026-342021", "CVE-2026-342022"]);
    other.sources = [{ source: "node-runtime", source_id: "NODE-c34-3", url: "https://example.com/node/c34-3" }];
    expect(await upsertAdvisory(env.DB, other, { source: "node-runtime", source_id: "NODE-c34-3" })).toBe("updated");
    expect(await cvesOf("osv", "GHSA-c34-3")).toEqual(["CVE-2026-342021", "CVE-2026-342022"]);
  });

  it("the migration backfills rows from doc_json and a re-run adds none", async () => {
    await env.DB.prepare(
      "INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor) VALUES ('tcs_backfill_34', 'CVE-2026-342031', 'npm', 'x', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', ?, 934001)",
    )
      .bind(JSON.stringify({ cve_ids: ["CVE-2026-342031", "CVE-2026-342032"] }))
      .run();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0010_advisory_cves.sql");
    expect(migration).toBeDefined();
    const rows = () =>
      env.DB.prepare("SELECT cve FROM advisory_cves WHERE advisory_id = 'tcs_backfill_34' ORDER BY cve").all<{ cve: string }>();
    for (const q of migration!.queries) await env.DB.prepare(q).run();
    expect((await rows()).results.map((r) => r.cve)).toEqual(["CVE-2026-342031", "CVE-2026-342032"]);
    for (const q of migration!.queries) await env.DB.prepare(q).run();
    expect((await rows()).results.length).toBe(2);
  });
});
