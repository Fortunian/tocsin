import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live values are settings.social.retention_days,
// settings.social.retention_batch and settings.social.retention_dry_run.
export const FALLBACK_SOCIAL_RETENTION_DAYS = 365;
export const FALLBACK_SOCIAL_RETENTION_BATCH = 5000;
export const FALLBACK_SOCIAL_RETENTION_DRY_RUN = 0;

// One JSON object, overwritten by each run: the operator's audit record.
export const SOCIAL_RETENTION_AUDIT_KEY = "retention:social_posts:last";

const COLS = "advisory_id, channel, status, attempts, next_at, first_attempt_at, posted_id, posted_at, error, text, created_at, updated_at";
// ?1 cutoff, ?2 batch. idx_social_posts_retention. Only terminal rows move.
const PICK = "SELECT id FROM social_posts WHERE created_at < ?1 AND status IN ('ok', 'empty', 'failed') ORDER BY created_at LIMIT ?2";

export const SOCIAL_RETENTION_SQL = {
  // ?1 cutoff, ?2 batch, ?3 now. The newest state per (advisory_id, channel) wins (a replay after an earlier archive).
  archive: `INSERT INTO social_posts_archive (${COLS}, archived_at) SELECT ${COLS}, ?3 FROM social_posts WHERE id IN (${PICK})
ON CONFLICT(advisory_id, channel) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, next_at = excluded.next_at,
  first_attempt_at = excluded.first_attempt_at, posted_id = excluded.posted_id, posted_at = excluded.posted_at, error = excluded.error,
  text = excluded.text, created_at = excluded.created_at, updated_at = excluded.updated_at, archived_at = excluded.archived_at`,
  // ?1 cutoff, ?2 batch. A row is deleted only when the archive holds its copy
  // (one seek on ux_social_posts_archive_advisory_channel per row, at most batch rows).
  delete: `DELETE FROM social_posts WHERE id IN (${PICK}) AND EXISTS (SELECT 1 FROM social_posts_archive a WHERE a.advisory_id = social_posts.advisory_id AND a.channel = social_posts.channel AND a.status = social_posts.status AND a.updated_at = social_posts.updated_at)`,
  // ?1 cutoff. idx_social_posts_retention.
  dryRun: "SELECT COUNT(*) AS n FROM social_posts WHERE created_at < ?1 AND status IN ('ok', 'empty', 'failed')",
} as const;

export interface SocialRetentionAudit {
  ran_at: string;
  cutoff: string;
  dry_run: boolean;
  archived: number;
  has_more: boolean;
}

// Moves terminal social_posts rows (ok, empty, failed) created more than
// social.retention_days ago to social_posts_archive, at most
// social.retention_batch per run, in one transaction. A row is post history,
// so it is archived, never silently deleted. pending and sending rows stay.
// The audit record is written only after the batch commits.
export async function runSocialRetention(env: Env, now: Date): Promise<SocialRetentionAudit> {
  const [days, batch, dryRun] = await Promise.all([
    getSettingInt(env.DB, "social.retention_days", FALLBACK_SOCIAL_RETENTION_DAYS),
    getSettingInt(env.DB, "social.retention_batch", FALLBACK_SOCIAL_RETENTION_BATCH),
    getSettingInt(env.DB, "social.retention_dry_run", FALLBACK_SOCIAL_RETENTION_DRY_RUN),
  ]);
  if (days < 1 || batch < 1) {
    const msg = `retention knobs out of range: social.retention_days=${days}, social.retention_batch=${batch}`;
    console.error(JSON.stringify({ lane: "retention", table: "social_posts", err: msg }));
    throw new Error(msg);
  }
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  let audit: SocialRetentionAudit;
  // Any value but 0 is a dry run, so a mistyped row never moves a row.
  if (dryRun !== 0) {
    const r = await env.DB.prepare(SOCIAL_RETENTION_SQL.dryRun).bind(cutoff).first<{ n: number }>();
    if (!r) throw new Error("social_posts retention dry-run count returned no row");
    audit = { ran_at: now.toISOString(), cutoff, dry_run: true, archived: r.n, has_more: r.n > batch };
  } else {
    const [, del] = await env.DB.batch([
      env.DB.prepare(SOCIAL_RETENTION_SQL.archive).bind(cutoff, batch, now.toISOString()),
      env.DB.prepare(SOCIAL_RETENTION_SQL.delete).bind(cutoff, batch),
    ]);
    const archived = del.meta.changes;
    audit = { ran_at: now.toISOString(), cutoff, dry_run: false, archived, has_more: archived === batch };
  }

  await env.CURSORS.put(SOCIAL_RETENTION_AUDIT_KEY, JSON.stringify(audit));
  console.log(JSON.stringify({ lane: "retention", table: "social_posts", ...audit }));
  return audit;
}
