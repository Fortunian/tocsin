import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live values are settings.retention.api_key_unused_days,
// settings.retention.api_keys_batch and settings.retention.api_keys_dry_run.
export const FALLBACK_UNUSED_DAYS = 365;
export const FALLBACK_BATCH = 5000;
export const FALLBACK_DRY_RUN = 0;

// One JSON object, overwritten by each run: the operator's audit record.
export const RETENTION_AUDIT_KEY = "retention:api_keys:last";

// The keys one run deletes: unused since before the cutoff, oldest first,
// at most batch (idx_api_keys_last_used_at).
export const KEY_RETENTION_SELECT_SQL = "SELECT id FROM api_keys WHERE last_used_at < ? ORDER BY last_used_at, id LIMIT ?";

export interface RetentionAudit {
  ran_at: string;
  cutoff: string;
  dry_run: boolean;
  keys: number;
  watchlists: number;
  has_more: boolean;
}

// Deletes API keys unused for retention.api_key_unused_days and their watch
// lists, in one transaction. The audit record is written only after the
// delete commits; a failed delete rethrows and writes no record.
export async function runKeyRetention(env: Env, now: Date): Promise<RetentionAudit> {
  const [days, batch, dryRun] = await Promise.all([
    getSettingInt(env.DB, "retention.api_key_unused_days", FALLBACK_UNUSED_DAYS),
    getSettingInt(env.DB, "retention.api_keys_batch", FALLBACK_BATCH),
    getSettingInt(env.DB, "retention.api_keys_dry_run", FALLBACK_DRY_RUN),
  ]);
  if (days < 1 || batch < 1) {
    const msg = `retention knobs out of range: api_key_unused_days=${days}, api_keys_batch=${batch}`;
    console.error(JSON.stringify({ lane: "retention", err: msg }));
    throw new Error(msg);
  }
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  let audit: RetentionAudit;
  // Any value but 0 is a dry run, so a mistyped row never deletes.
  if (dryRun !== 0) {
    const r = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM api_keys WHERE last_used_at < ?1) AS keys,
              (SELECT COUNT(*) FROM watchlists WHERE key_id IN (SELECT id FROM api_keys WHERE last_used_at < ?1)) AS watchlists`,
    )
      .bind(cutoff)
      .first<{ keys: number; watchlists: number }>();
    if (!r) throw new Error("retention dry-run count returned no row");
    audit = { ran_at: now.toISOString(), cutoff, dry_run: true, keys: r.keys, watchlists: r.watchlists, has_more: r.keys > batch };
  } else {
    const [lists, keys] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM watchlists WHERE key_id IN (${KEY_RETENTION_SELECT_SQL})`).bind(cutoff, batch),
      env.DB.prepare(`DELETE FROM api_keys WHERE id IN (${KEY_RETENTION_SELECT_SQL})`).bind(cutoff, batch),
    ]);
    const deleted = keys.meta.changes;
    audit = { ran_at: now.toISOString(), cutoff, dry_run: false, keys: deleted, watchlists: lists.meta.changes, has_more: deleted === batch };
  }

  await env.CURSORS.put(RETENTION_AUDIT_KEY, JSON.stringify(audit));
  console.log(JSON.stringify({ lane: "retention", table: "api_keys", ...audit }));
  return audit;
}
