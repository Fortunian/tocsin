import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live values are settings.badge.retention_days,
// settings.badge.retention_batch and settings.badge.retention_dry_run.
export const FALLBACK_BADGE_RETENTION_DAYS = 90;
export const FALLBACK_BADGE_RETENTION_BATCH = 5000;
export const FALLBACK_BADGE_RETENTION_DRY_RUN = 0;

// One JSON object, overwritten by each run: the operator's audit record.
export const ACTION_REPORT_RETENTION_AUDIT_KEY = "retention:action_reports:last";

// ?1 cutoff, ?2 batch. idx_action_reports_retention. The latest row per ref is never a candidate.
export const ACTION_REPORT_RETENTION_SQL =
  "DELETE FROM action_reports WHERE rowid IN (SELECT rowid FROM action_reports WHERE is_latest = 0 AND reported_at < ?1 LIMIT ?2)";
// ?1 cutoff. idx_action_reports_retention.
export const ACTION_REPORT_DRY_RUN_SQL = "SELECT COUNT(*) AS n FROM action_reports WHERE is_latest = 0 AND reported_at < ?1";

export interface ActionReportRetentionAudit {
  ran_at: string;
  cutoff: string;
  dry_run: boolean;
  deleted: number;
  has_more: boolean;
}

// Deletes action_reports rows that are not the latest of their owner+repo+ref
// and were reported more than badge.retention_days ago, at most
// badge.retention_batch per run. A row is a CI status snapshot that the next
// run regenerates, not money or advisory history, so it is deleted, not
// archived. The audit record is written only after the delete commits.
export async function runActionReportRetention(env: Env, now: Date): Promise<ActionReportRetentionAudit> {
  const [days, batch, dryRun] = await Promise.all([
    getSettingInt(env.DB, "badge.retention_days", FALLBACK_BADGE_RETENTION_DAYS),
    getSettingInt(env.DB, "badge.retention_batch", FALLBACK_BADGE_RETENTION_BATCH),
    getSettingInt(env.DB, "badge.retention_dry_run", FALLBACK_BADGE_RETENTION_DRY_RUN),
  ]);
  if (days < 1 || batch < 1) {
    const msg = `retention knobs out of range: badge.retention_days=${days}, badge.retention_batch=${batch}`;
    console.error(JSON.stringify({ lane: "retention", table: "action_reports", err: msg }));
    throw new Error(msg);
  }
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  let audit: ActionReportRetentionAudit;
  // Any value but 0 is a dry run, so a mistyped row never deletes.
  if (dryRun !== 0) {
    const r = await env.DB.prepare(ACTION_REPORT_DRY_RUN_SQL).bind(cutoff).first<{ n: number }>();
    if (!r) throw new Error("action_reports retention dry-run count returned no row");
    audit = { ran_at: now.toISOString(), cutoff, dry_run: true, deleted: r.n, has_more: r.n > batch };
  } else {
    const res = await env.DB.prepare(ACTION_REPORT_RETENTION_SQL).bind(cutoff, batch).run();
    const deleted = res.meta.changes;
    audit = { ran_at: now.toISOString(), cutoff, dry_run: false, deleted, has_more: deleted === batch };
  }

  await env.CURSORS.put(ACTION_REPORT_RETENTION_AUDIT_KEY, JSON.stringify(audit));
  console.log(JSON.stringify({ lane: "retention", table: "action_reports", ...audit }));
  return audit;
}
