// The social lane (TCS-106): one short post to the Tocsin X account per
// critical runtime advisory, on first sight, at most social.x.daily_cap X
// calls per UTC day. Runs in the */10 cron after webhook work (src/cron/run.ts).
// Dedup before spend: the social_posts row is written pending, then claimed
// sending with attempts + 1, before the X call. A crash after the call leaves
// the row sending; the lease sweep ends it failed (unknown_outcome), never a
// second call.
import type { Env } from "../env";
import type { Advisory } from "../schema/advisory";
import { classifyXOutcome, ERROR_MAX_CHARS } from "../social/classify";
import { SOCIAL_CONFIG_SQL, parseSocialConfig, type SocialConfig } from "../social/config";
import { ecosystemsFor, qualifies } from "../social/select";
import { renderPostText } from "../social/text";
import { getXClient, type XClient, type XClientFactory } from "../social/x";

export const SOCIAL_CHANNEL = "x";
export const SOCIAL_LANE = "social:x"; // match_cursors row
export const SOCIAL_SOURCE_ID = "social-x"; // sources row

export const SOCIAL_SQL = {
  // PK seek on match_cursors.
  watermark: `SELECT cursor, updated_at FROM match_cursors WHERE lane = '${SOCIAL_LANE}'`,
  // ?1 cursor, ?2 scan time. The cursor never moves back (two overlapping ticks).
  advance: `INSERT INTO match_cursors (lane, cursor, updated_at) VALUES ('${SOCIAL_LANE}', ?1, ?2)
ON CONFLICT(lane) DO UPDATE SET cursor = MAX(match_cursors.cursor, excluded.cursor), updated_at = excluded.updated_at, version = match_cursors.version + 1`,
  // ?1 scan time. Disabled and not-configured runs: the watermark moves to the newest cursor (idx_advisories_cursor).
  advanceToMax: `INSERT INTO match_cursors (lane, cursor, updated_at) SELECT '${SOCIAL_LANE}', COALESCE(MAX(cursor), 0), ?1 FROM advisories WHERE 1
ON CONFLICT(lane) DO UPDATE SET cursor = MAX(match_cursors.cursor, excluded.cursor), updated_at = excluded.updated_at, version = match_cursors.version + 1`,
  // idx_advisories_cursor (max).
  maxCursor: "SELECT COALESCE(MAX(cursor), 0) AS m FROM advisories",
  // ?1 ecosystem, ?2 watermark cursor, ?3 scan_rows. idx_advisories_ecosystem_cursor.
  candidates: "SELECT id, cursor, doc_json FROM advisories WHERE ecosystem = ?1 AND cursor > ?2 ORDER BY cursor LIMIT ?3",
  // ?1 now, ?2 now. idx_social_posts_due. A lease that ran out is terminal: the post may have gone out.
  sweep: `UPDATE social_posts SET status = 'failed', error = 'unknown_outcome', updated_at = ?2 WHERE channel = '${SOCIAL_CHANNEL}' AND status = 'sending' AND next_at <= ?1`,
  // ?1 advisory_id, ?2 channel. ux_social_posts_advisory_channel.
  lookup: "SELECT id, status, updated_at FROM social_posts WHERE advisory_id = ?1 AND channel = ?2",
  // ?1 channel, ?2 start of the UTC day. idx_social_posts_attempted.
  attemptedSince: "SELECT COUNT(*) AS n FROM social_posts WHERE channel = ?1 AND first_attempt_at >= ?2",
  // ?1 channel, ?2 now, ?3 lease end, ?4 room. idx_social_posts_due. One atomic statement, so two ticks never claim one row.
  claim: `UPDATE social_posts SET status = 'sending', attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?2), next_at = ?3, updated_at = ?2
WHERE id IN (SELECT id FROM social_posts WHERE channel = ?1 AND status = 'pending' AND next_at <= ?2 ORDER BY next_at LIMIT ?4)
RETURNING id, advisory_id, text, attempts`,
  // ?1 id, ?2 status, ?3 next_at, ?4 posted_id, ?5 posted_at, ?6 error, ?7 now. PK.
  finish: "UPDATE social_posts SET status = ?2, next_at = ?3, posted_id = ?4, posted_at = ?5, error = ?6, updated_at = ?7 WHERE id = ?1 AND status = 'sending'",
  // ?1 now, ?2 last error or null. PK of sources.
  source: `UPDATE sources SET last_run_at = ?1, last_ok_at = CASE WHEN ?2 IS NULL THEN ?1 ELSE last_ok_at END, last_error = ?2 WHERE id = '${SOCIAL_SOURCE_ID}'`,
} as const;

// D1 allows 100 bound parameters per statement: ?1 is now, each row binds 2.
const INSERT_CHUNK = 40;
function insertSql(rows: number): string {
  const values = Array.from({ length: rows }, (_, i) => `(?${2 + i * 2}, '${SOCIAL_CHANNEL}', 'pending', 0, ?1, ?${3 + i * 2}, ?1, ?1)`).join(", ");
  return `INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, text, created_at, updated_at) VALUES ${values} ON CONFLICT(advisory_id, channel) DO NOTHING`;
}

export interface ClaimedRow {
  id: number;
  advisory_id: string;
  text: string;
  attempts: number;
}

export interface SendResult {
  posted: number;
  failed: number;
  lastError: string | null;
  statuses: Record<string, string>; // advisory_id -> final status
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Room under social.x.daily_cap for today (UTC), counted by first attempts. */
export async function roomToday(db: D1Database, cfg: SocialConfig, now: Date): Promise<number> {
  const r = await db.prepare(SOCIAL_SQL.attemptedSince).bind(SOCIAL_CHANNEL, startOfUtcDay(now)).first<{ n: number }>();
  // No count row is a failed read, never "0 used": it must not open the cap.
  if (!r) throw new Error("social_posts daily cap count returned no row");
  return cfg.dailyCap - r.n;
}

/** Sends claimed rows one at a time (each call costs money; no parallel spend) and records each outcome. */
export async function sendClaimed(db: D1Database, client: XClient, cfg: SocialConfig, rows: ClaimedRow[], now: Date): Promise<SendResult> {
  const out: SendResult = { posted: 0, failed: 0, lastError: null, statuses: {} };
  for (const row of rows) {
    const o = classifyXOutcome(await client.post(row.text), row.attempts, cfg.maxAttempts);
    const at = new Date().toISOString();
    const nextAt = o.retry ? new Date(now.getTime() + cfg.retrySeconds * 1000).toISOString() : at;
    await db
      .prepare(SOCIAL_SQL.finish)
      .bind(row.id, o.status, nextAt, o.postedId, o.status === "ok" ? at : null, o.error, at)
      .run();
    out.statuses[row.advisory_id] = o.status;
    if (o.status === "ok") out.posted += 1;
    else out.failed += 1;
    if (o.error !== null) out.lastError = o.error;
    console.log(JSON.stringify({ lane: "social", advisory_id: row.advisory_id, attempts: row.attempts, status: o.status, error: o.error }));
  }
  return out;
}

export interface SocialRunResult {
  state: "disabled" | "not_configured" | "no_watermark" | "ran";
  queued: number;
  posted: number;
  failed: number;
  deferred: boolean;
}

/**
 * One run of the social lane. Statements: 1 batch (config + watermark); a
 * disabled run adds 1 (watermark). An enabled run adds 1 batch (scans + max
 * cursor + lease sweep), 1 batch (inserts + watermark), 1 count, 1 claim, 1
 * per post and 1 sources write.
 */
export async function runSocialLane(env: Env, now: Date, clientFor: XClientFactory = getXClient): Promise<SocialRunResult> {
  const db = env.DB;
  const nowIso = now.toISOString();
  const empty = { queued: 0, posted: 0, failed: 0, deferred: false };
  const [cfgRes, wmRes] = await db.batch([db.prepare(SOCIAL_CONFIG_SQL), db.prepare(SOCIAL_SQL.watermark)]);
  const cfg = parseSocialConfig(cfgRes.results as { key: string; value: string }[]);
  const wm = wmRes.results[0] as { cursor: number; updated_at: string } | undefined;

  if (!wm) {
    // The migration seeds the row; without it, start from now and post nothing old.
    console.error(JSON.stringify({ lane: "social", err: `match_cursors row '${SOCIAL_LANE}' missing, starting from the newest cursor` }));
    await db.prepare(SOCIAL_SQL.advanceToMax).bind(nowIso).run();
    return { state: "no_watermark", ...empty };
  }
  if (!cfg.enabled) {
    // Turning the flag on later never posts a backlog.
    await db.prepare(SOCIAL_SQL.advanceToMax).bind(nowIso).run();
    return { state: "disabled", ...empty };
  }
  const client = clientFor(env, cfg.timeoutMs);
  if (!client) {
    console.error(JSON.stringify({ lane: "social", err: "not_configured: an X secret is missing, no post" }));
    await db.batch([db.prepare(SOCIAL_SQL.advanceToMax).bind(nowIso), db.prepare(SOCIAL_SQL.source).bind(nowIso, "not_configured")]);
    return { state: "not_configured", ...empty };
  }

  // Scan: one statement per ecosystem the configured sources need, the newest
  // cursor, and the stale-lease sweep, in one batch.
  const ecosystems = ecosystemsFor(cfg.sources);
  const res = await db.batch([
    ...ecosystems.map((e) => db.prepare(SOCIAL_SQL.candidates).bind(e, wm.cursor, cfg.scanRows)),
    db.prepare(SOCIAL_SQL.maxCursor),
    db.prepare(SOCIAL_SQL.sweep).bind(nowIso, nowIso),
  ]);
  const maxCursor = (res[ecosystems.length].results[0] as { m: number }).m;
  let nextCursor = maxCursor;
  let truncated = false;
  const queue: { id: string; text: string }[] = [];
  ecosystems.forEach((_, i) => {
    const rows = res[i].results as { id: string; cursor: number; doc_json: string }[];
    if (rows.length >= cfg.scanRows && rows.length > 0) {
      // Capped: the next tick reads on from the last cursor read here.
      truncated = true;
      nextCursor = Math.min(nextCursor, rows[rows.length - 1].cursor);
    }
    for (const r of rows) {
      const doc = JSON.parse(r.doc_json) as Advisory;
      if (qualifies(doc, cfg, wm.updated_at, now)) queue.push({ id: doc.id, text: renderPostText(doc, cfg) });
    }
  });

  // Rows first, then the watermark, in one transaction. A capped scan keeps
  // the previous scan time, so the rows past the cap still count as first sight.
  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < queue.length; i += INSERT_CHUNK) {
    const chunk = queue.slice(i, i + INSERT_CHUNK);
    writes.push(db.prepare(insertSql(chunk.length)).bind(nowIso, ...chunk.flatMap((q) => [q.id, q.text])));
  }
  writes.push(db.prepare(SOCIAL_SQL.advance).bind(nextCursor, truncated ? wm.updated_at : nowIso));
  await db.batch(writes);

  const room = await roomToday(db, cfg, now);
  let sent: SendResult = { posted: 0, failed: 0, lastError: null, statuses: {} };
  let runError: string | null = null;
  if (room > 0) {
    const leaseEnd = new Date(now.getTime() + cfg.leaseSeconds * 1000).toISOString();
    const claimed = await db.prepare(SOCIAL_SQL.claim).bind(SOCIAL_CHANNEL, nowIso, leaseEnd, room).all<ClaimedRow>();
    try {
      sent = await sendClaimed(db, client, cfg, claimed.results, now);
    } catch (err) {
      // A claimed row left sending ends failed/unknown_outcome at its lease end.
      runError = errText(err).slice(0, ERROR_MAX_CHARS);
      console.error(JSON.stringify({ lane: "social", err: runError }));
    }
  }
  await db.prepare(SOCIAL_SQL.source).bind(nowIso, runError ?? sent.lastError).run();
  return { state: "ran", queued: queue.length, posted: sent.posted, failed: sent.failed, deferred: room <= 0 };
}
