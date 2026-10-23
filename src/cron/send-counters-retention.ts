import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live values are settings.retention.send_counters_days,
// settings.retention.send_counters_batch and settings.retention.send_counters_dry_run.
export const FALLBACK_SEND_COUNTERS_DAYS = 2;
export const FALLBACK_SEND_COUNTERS_BATCH = 5000;
export const FALLBACK_SEND_COUNTERS_DRY_RUN = 0;

// One JSON object, overwritten by each run: the operator's audit record.
export const SEND_COUNTER_RETENTION_AUDIT_KEY = "retention:send_counters:last";

// ?1 cutoff, ?2 batch. idx_send_counters_created_at.
export const SEND_COUNTER_RETENTION_SQL =
  "DELETE FROM send_counters WHERE rowid IN (SELECT rowid FROM send_counters WHERE created_at < ?1 LIMIT ?2)";
// ?1 cutoff. idx_send_counters_created_at.
export const SEND_COUNTER_DRY_RUN_SQL = "SELECT COUNT(*) AS n FROM send_counters WHERE created_at < ?1";

export interface SendCounterRetentionAudit {
  ran_at: string;
  cutoff: string;
  dry_run: boolean;
  deleted: number;
  has_more: boolean;
}

// Deletes send_counters rows created more than retention.send_counters_days
// ago, at most retention.send_counters_batch per run. The longest send window
// is one UTC day and the window knob is at least 1 day, so a live window is
// never deleted. A row is a rate counter, not money or history, so it is
// deleted, not archived. The audit record is written only after the delete commits.
export async function runSendCounterRetention(env: Env, now: Date): Promise<SendCounterRetentionAudit> {
  const [days, batch, dryRun] = await Promise.all([
    getSettingInt(env.DB, "retention.send_counters_days", FALLBACK_SEND_COUNTERS_DAYS),
    getSettingInt(env.DB, "retention.send_counters_batch", FALLBACK_SEND_COUNTERS_BATCH),
    getSettingInt(env.DB, "retention.send_counters_dry_run", FALLBACK_SEND_COUNTERS_DRY_RUN),
  ]);
  if (days < 1 || batch < 1) {
    const msg = `retention knobs out of range: send_counters_days=${days}, send_counters_batch=${batch}`;
    console.error(JSON.stringify({ lane: "retention", table: "send_counters", err: msg }));
    throw new Error(msg);
  }
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  let audit: SendCounterRetentionAudit;
  // Any value but 0 is a dry run, so a mistyped row never deletes.
  if (dryRun !== 0) {
    const r = await env.DB.prepare(SEND_COUNTER_DRY_RUN_SQL).bind(cutoff).first<{ n: number }>();
    if (!r) throw new Error("send_counters retention dry-run count returned no row");
    audit = { ran_at: now.toISOString(), cutoff, dry_run: true, deleted: r.n, has_more: r.n > batch };
  } else {
    const res = await env.DB.prepare(SEND_COUNTER_RETENTION_SQL).bind(cutoff, batch).run();
    const deleted = res.meta.changes;
    audit = { ran_at: now.toISOString(), cutoff, dry_run: false, deleted, has_more: deleted === batch };
  }

  await env.CURSORS.put(SEND_COUNTER_RETENTION_AUDIT_KEY, JSON.stringify(audit));
  console.log(JSON.stringify({ lane: "retention", table: "send_counters", ...audit }));
  return audit;
}
