import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTION_REPORT_DRY_RUN_SQL, ACTION_REPORT_RETENTION_SQL } from "../../src/cron/action-reports-retention";
import { DEMOTE_SQL, INSERT_SQL } from "../../src/routes/action-report";
import { BADGE_BY_REF_SQL, BADGE_DEFAULT_SQL } from "../../src/routes/badge-repo";

// TCS-101: every statement on action_reports, on 5,000 seeded rows over 200
// repos, reads by a named index, with no bare scan and no temp B-tree.

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

const BARE_SCAN = /SCAN action_reports(?! USING)/;
const TEMP = /USE TEMP B-TREE/;
const by = (index: string) => new RegExp(`(SEARCH|SCAN) action_reports USING (COVERING )?INDEX ${index}\\b`);
const NOW = "2026-10-25T00:00:00.000Z";

beforeAll(async () => {
  // Multi-row INSERTs: 10 rows per statement (9 columns, under D1's 100 bound
  // parameters), 500 statements.
  const stmts: D1PreparedStatement[] = [];
  const cols = "(owner, repo, ref, is_default, is_latest, affected, min_severity, run_id, reported_at)";
  for (let s = 0; s < 500; s++) {
    const vals: unknown[] = [];
    for (let j = 0; j < 10; j++) {
      const i = s * 10 + j;
      const ref = i % 5 === 0 ? `refs/pull/${i}/merge` : "refs/heads/main";
      vals.push(`plan-owner-${i % 200}`, "widget", ref, ref === "refs/heads/main" ? 1 : 0, i >= 4800 ? 1 : 0, i % 4, "low", `run-${i}`, new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString());
    }
    stmts.push(env.DB.prepare(`INSERT INTO action_reports ${cols} VALUES ${Array(10).fill("(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`).bind(...vals));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await env.DB.exec("ANALYZE");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM action_reports").first<{ n: number }>();
  expect(n?.n).toBe(5000);
});

describe("action_reports statements", () => {
  it("P1: the ?ref= read uses idx_action_reports_ref with no temp B-tree", async () => {
    const p = await plan(BADGE_BY_REF_SQL, "plan-owner-7", "widget", "refs/heads/main");
    expect(p).toMatch(by("idx_action_reports_ref"));
    expect(p).not.toMatch(BARE_SCAN);
    expect(p).not.toMatch(TEMP);
  });

  it("P2: the default-branch read uses idx_action_reports_default with no temp B-tree", async () => {
    const p = await plan(BADGE_DEFAULT_SQL, "plan-owner-7", "widget");
    expect(p).toMatch(by("idx_action_reports_default"));
    expect(p).not.toMatch(BARE_SCAN);
    expect(p).not.toMatch(TEMP);
  });

  it("P3: the demote UPDATE uses idx_action_reports_ref and probes ux_action_reports_run", async () => {
    const p = await plan(DEMOTE_SQL, "plan-owner-7", "widget", "refs/heads/main", "run-new");
    expect(p).toMatch(by("idx_action_reports_ref"));
    expect(p).toMatch(by("ux_action_reports_run"));
    expect(p).not.toMatch(BARE_SCAN);
  });

  it("P4: the insert scans nothing", async () => {
    const p = await plan(INSERT_SQL, "plan-owner-7", "widget", "refs/heads/main", 1, 0, "low", "run-new", NOW);
    expect(p).not.toMatch(BARE_SCAN);
  });

  it("P5: the retention delete and the dry-run count use idx_action_reports_retention", async () => {
    const del = await plan(ACTION_REPORT_RETENTION_SQL, NOW, 5000);
    expect(del).toMatch(by("idx_action_reports_retention"));
    expect(del).not.toMatch(BARE_SCAN);
    const count = await plan(ACTION_REPORT_DRY_RUN_SQL, NOW);
    expect(count).toMatch(by("idx_action_reports_retention"));
    expect(count).not.toMatch(BARE_SCAN);
  });

  it("P6: the table has the ticket's columns and the 7 settings rows exist with their seed values", async () => {
    const { results: cols } = await env.DB.prepare("SELECT name FROM pragma_table_info('action_reports')").all<{ name: string }>();
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["owner", "repo", "ref", "affected", "min_severity", "reported_at", "run_id"]));
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'badge.%' OR key LIKE 'action.oidc_%'").all<{ key: string; value: string }>();
    expect(Object.fromEntries(results.map((r) => [r.key, r.value]))).toMatchObject({
      "badge.retention_days": "90",
      "badge.retention_batch": "5000",
      "badge.retention_dry_run": "0",
      "badge.cache_seconds": "300",
      "action.oidc_jwks_cache_seconds": "3600",
      "action.oidc_jwks_refetch_seconds": "300",
      "action.oidc_clock_skew_seconds": "60",
    });
  });
});
