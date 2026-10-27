// The social block of GET /v1/status (TCS-106): enabled, posted_24h, last_error.
import { SOCIAL_CHANNEL, SOCIAL_SOURCE_ID } from "../cron/social";

export interface SocialStatus {
  enabled: boolean;
  posted_24h: number;
  last_error: string | null;
}

export const SOCIAL_STATUS_SQL = {
  // PK seek on settings.
  enabled: "SELECT value FROM settings WHERE key = 'social.x.enabled'",
  // ?1 now - 24 h. idx_social_posts_posted.
  posted24h: `SELECT COUNT(*) AS n FROM social_posts WHERE channel = '${SOCIAL_CHANNEL}' AND status = 'ok' AND posted_at >= ?1`,
  // PK seek on sources.
  source: `SELECT last_error FROM sources WHERE id = '${SOCIAL_SOURCE_ID}'`,
} as const;

/** One batch of 3 seeks. */
export async function loadSocialStatus(db: D1Database, now: Date): Promise<SocialStatus> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const [enabled, posted, source] = await db.batch([
    db.prepare(SOCIAL_STATUS_SQL.enabled),
    db.prepare(SOCIAL_STATUS_SQL.posted24h).bind(since),
    db.prepare(SOCIAL_STATUS_SQL.source),
  ]);
  const value = (enabled.results[0] as { value: string } | undefined)?.value.trim();
  return {
    enabled: value === "1",
    posted_24h: (posted.results[0] as { n: number } | undefined)?.n ?? 0,
    last_error: (source.results[0] as { last_error: string | null } | undefined)?.last_error ?? null,
  };
}
