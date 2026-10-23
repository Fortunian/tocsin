import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live values are settings.retention.deliveries_days,
// settings.retention.deliveries_batch and settings.retention.deliveries_dry_run.
export const FALLBACK_DELIVERIES_DAYS = 90;
export const FALLBACK_DELIVERIES_BATCH = 5000;
export const FALLBACK_DELIVERIES_DRY_RUN = 0;

// One JSON object, overwritten by each run: the operator's audit record.
export const DELIVERY_RETENTION_AUDIT_KEY = "retention:deliveries:last";

// ?1 cutoff, ?2 batch. idx_deliveries_status_delivered_at.
export const DELIVERED_RETENTION_SQL =
  "DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE status = 'delivered' AND delivered_at < ?1 LIMIT ?2)";
// ?1 cutoff, ?2 batch. idx_deliveries_status_next_at (next_at is the time of the last write).
export const FAILED_RETENTION_SQL =
  "DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE status = 'failed' AND next_at < ?1 LIMIT ?2)";
export const SKIPPED_RETENTION_SQL =
  "DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE status = 'skipped' AND next_at < ?1 LIMIT ?2)";

export interface DeliveryRetentionAudit {
  ran_at: string;
  cutoff: string;
  dry_run: boolean;
  delivered: number;
  failed: number;
  skipped: number;
  has_more: boolean;
}

// Deletes delivered, failed and skipped deliveries rows older than
// retention.deliveries_days, at most retention.deliveries_batch of each status
// per run, in one transaction. Pending and sending rows are never deleted.
// Rows are delivery receipts, not money, so they are deleted, not archived.
// The audit record is written only after the delete commits.
export async function runDeliveryRetention(env: Env, now: Date): Promise<DeliveryRetentionAudit> {
  const [days, batch, dryRun] = await Promise.all([
    getSettingInt(env.DB, "retention.deliveries_days", FALLBACK_DELIVERIES_DAYS),
    getSettingInt(env.DB, "retention.deliveries_batch", FALLBACK_DELIVERIES_BATCH),
    getSettingInt(env.DB, "retention.deliveries_dry_run", FALLBACK_DELIVERIES_DRY_RUN),
  ]);
  if (days < 1 || batch < 1) {
    const msg = `retention knobs out of range: deliveries_days=${days}, deliveries_batch=${batch}`;
    console.error(JSON.stringify({ lane: "retention", table: "deliveries", err: msg }));
    throw new Error(msg);
  }
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  let audit: DeliveryRetentionAudit;
  // Any value but 0 is a dry run, so a mistyped row never deletes.
  if (dryRun !== 0) {
    const r = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM deliveries WHERE status = 'delivered' AND delivered_at < ?1) AS delivered,
              (SELECT COUNT(*) FROM deliveries WHERE status = 'failed' AND next_at < ?1) AS failed,
              (SELECT COUNT(*) FROM deliveries WHERE status = 'skipped' AND next_at < ?1) AS skipped`,
    )
      .bind(cutoff)
      .first<{ delivered: number; failed: number; skipped: number }>();
    if (!r) throw new Error("deliveries retention dry-run count returned no row");
    audit = { ran_at: now.toISOString(), cutoff, dry_run: true, ...r, has_more: Math.max(r.delivered, r.failed, r.skipped) > batch };
  } else {
    const [d, f, s] = await env.DB.batch([
      env.DB.prepare(DELIVERED_RETENTION_SQL).bind(cutoff, batch),
      env.DB.prepare(FAILED_RETENTION_SQL).bind(cutoff, batch),
      env.DB.prepare(SKIPPED_RETENTION_SQL).bind(cutoff, batch),
    ]);
    const delivered = d.meta.changes;
    const failed = f.meta.changes;
    const skipped = s.meta.changes;
    audit = { ran_at: now.toISOString(), cutoff, dry_run: false, delivered, failed, skipped, has_more: delivered === batch || failed === batch || skipped === batch };
  }

  await env.CURSORS.put(DELIVERY_RETENTION_AUDIT_KEY, JSON.stringify(audit));
  console.log(JSON.stringify({ lane: "retention", table: "deliveries", ...audit }));
  return audit;
}
