// POST /v1/internal/social/replay (TCS-106): post one advisory to X by hand.
// Bearer IMPORT_TOKEN (the import route's guard). An ok row, live or
// archived, answers 200 changed:false and writes nothing. Every refusal
// (404, 409, 503, 429) writes nothing. Otherwise the row is reset to pending
// with fresh text and sent once, inside the daily cap.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { roomToday, sendClaimed, SOCIAL_CHANNEL, SOCIAL_SQL, type ClaimedRow } from "../cron/social";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";
import type { Advisory } from "../schema/advisory";
import { readSocialConfig } from "../social/config";
import { isWithdrawn } from "../social/select";
import { renderPostText } from "../social/text";
import { getXClient } from "../social/x";
import { auth, FALLBACK_MAX_BODY_BYTES } from "./internal-import";

const NO_STORE = { "Cache-Control": "no-store" };
const ID_RE = /^tcs_[0-9A-HJKMNP-TV-Z]{26}$/;

export const REPLAY_SQL = {
  // ?1 advisory_id, ?2 channel. ux_social_posts_archive_advisory_channel.
  archived: "SELECT status FROM social_posts_archive WHERE advisory_id = ?1 AND channel = ?2",
  // PK of advisories.
  advisory: "SELECT doc_json FROM advisories WHERE id = ?1",
  // ?1 advisory_id, ?2 now, ?3 text. A sending row (in flight) and an ok row are never reset.
  reset: `INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, text, created_at, updated_at) VALUES (?1, '${SOCIAL_CHANNEL}', 'pending', 0, ?2, ?3, ?2, ?2)
ON CONFLICT(advisory_id, channel) DO UPDATE SET status = 'pending', attempts = 0, next_at = excluded.next_at, first_attempt_at = NULL, posted_id = NULL, posted_at = NULL,
  error = NULL, text = excluded.text, updated_at = excluded.updated_at WHERE social_posts.status IN ('pending', 'empty', 'failed')`,
  // ?1 advisory_id, ?2 now, ?3 lease end. ux_social_posts_advisory_channel.
  claimOne: `UPDATE social_posts SET status = 'sending', attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?2), next_at = ?3, updated_at = ?2
WHERE advisory_id = ?1 AND channel = '${SOCIAL_CHANNEL}' AND status = 'pending' RETURNING id, advisory_id, text, attempts`,
} as const;

const socialReplay = new Hono<{ Bindings: Env }>();

socialReplay.use("*", auth);

socialReplay.post(
  "/",
  async (c, next) => {
    // The import route's body limit row (import.max_body_bytes): this body is one id.
    const maxSize = await getSettingInt(c.env.DB, "import.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
    return bodyLimit({ maxSize, onError: (c) => jsonUtf8(c, { error: `body over ${maxSize} bytes` }, 413, NO_STORE) })(c, next);
  },
  async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return jsonUtf8(c, { error: "invalid JSON" }, 400, NO_STORE);
    }
    const id = (raw as { advisory_id?: unknown } | null)?.advisory_id;
    if (typeof id !== "string" || !ID_RE.test(id)) return jsonUtf8(c, { error: "advisory_id must be a tcs_ advisory id" }, 400, NO_STORE);

    const db = c.env.DB;
    const [live, archived, adv] = await db.batch([
      db.prepare(SOCIAL_SQL.lookup).bind(id, SOCIAL_CHANNEL),
      db.prepare(REPLAY_SQL.archived).bind(id, SOCIAL_CHANNEL),
      db.prepare(REPLAY_SQL.advisory).bind(id),
    ]);
    const liveRow = live.results[0] as { status: string } | undefined;
    const archivedRow = archived.results[0] as { status: string } | undefined;
    if (liveRow?.status === "ok" || (!liveRow && archivedRow?.status === "ok")) {
      return jsonUtf8(c, { advisory_id: id, status: "ok", changed: false }, 200, NO_STORE);
    }
    if (liveRow?.status === "sending") return jsonUtf8(c, { error: "a post for this advisory is in flight", status: "sending" }, 409, NO_STORE);
    const docRow = adv.results[0] as { doc_json: string } | undefined;
    if (!docRow) return jsonUtf8(c, { error: "advisory not found" }, 404, NO_STORE);
    const doc = JSON.parse(docRow.doc_json) as Advisory;
    if (isWithdrawn(doc)) return jsonUtf8(c, { error: "advisory is withdrawn" }, 409, NO_STORE);

    const cfg = await readSocialConfig(db);
    if (!cfg.enabled) return jsonUtf8(c, { error: "social.x.enabled is not 1" }, 409, NO_STORE);
    const client = getXClient(c.env, cfg.timeoutMs);
    if (!client) return jsonUtf8(c, { error: "not_configured: an X secret is missing" }, 503, NO_STORE);
    const now = new Date();
    if ((await roomToday(db, cfg, now)) <= 0) return jsonUtf8(c, { error: `daily cap reached (social.x.daily_cap ${cfg.dailyCap})` }, 429, NO_STORE);

    const nowIso = now.toISOString();
    const leaseEnd = new Date(now.getTime() + cfg.leaseSeconds * 1000).toISOString();
    const [, claimed] = await db.batch([
      db.prepare(REPLAY_SQL.reset).bind(id, nowIso, renderPostText(doc, cfg)),
      db.prepare(REPLAY_SQL.claimOne).bind(id, nowIso, leaseEnd),
    ]);
    const rows = claimed.results as unknown as ClaimedRow[];
    if (rows.length === 0) return jsonUtf8(c, { error: "a post for this advisory is in flight" }, 409, NO_STORE);
    const sent = await sendClaimed(db, client, cfg, rows, now);
    return jsonUtf8(c, { advisory_id: id, status: sent.statuses[id], changed: true, error: sent.lastError }, 200, NO_STORE);
  },
);

export default socialReplay;
