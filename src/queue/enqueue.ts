import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";
import type { WatchlistFilter } from "../watchlists/filter";
import { watchlistWhere } from "../watchlists/query";

// Code fallbacks only. The live values are the settings rows
// webhooks.enqueue_max_lists, webhooks.enqueue_per_list,
// webhooks.max_event_age_days, webhooks.sweep_grace_seconds and
// webhooks.sweep_batch (migrations/0021_deliveries.sql).
export const FALLBACK_ENQUEUE_MAX_LISTS = 1000;
export const FALLBACK_ENQUEUE_PER_LIST = 100;
export const FALLBACK_MAX_EVENT_AGE_DAYS = 30;
export const FALLBACK_SWEEP_GRACE_SECONDS = 600;
export const FALLBACK_SWEEP_BATCH = 500;
// Cloudflare Queues accepts at most 100 messages per sendBatch call. This is
// a platform limit, not a knob.
export const QUEUE_SEND_BATCH_MAX = 100;

// KV key (CURSORS): the last list id one enqueue run reached. The next run
// starts after it, so no list starves behind the enqueue_max_lists cap. Only a
// rotation hint: losing it restarts at the first list.
export const ENQUEUE_AFTER_KEY = "webhooks:enqueue:after";

// idx_watchlists_delivery. A paused list (delivery health, migrations/0023)
// is skipped; its cursor does not move, so a resume catches up.
export const WEBHOOK_LISTS_SQL =
  "SELECT id, filter_json, cursor, created_at FROM watchlists WHERE delivery = 'webhook' AND paused_at IS NULL AND id > ? ORDER BY id LIMIT ?";

// idx_deliveries_status_next_at. Rows of a paused list are not re-sent; the
// sweep picks them up again after a resume.
export const SWEEP_SQL = `SELECT watchlist_id, advisory_id FROM deliveries WHERE status = ? AND next_at <= ?
  AND NOT EXISTS (SELECT 1 FROM watchlists w WHERE w.id = deliveries.watchlist_id AND w.paused_at IS NOT NULL)
  ORDER BY next_at LIMIT ?`;

export interface DeliveryMessage {
  watchlist_id: string;
  advisory_id: string;
}

// The two statements one list runs in one transaction (env.DB.batch):
// 1. Insert a deliveries row for each advisory above the list cursor that
//    matches the filter and has no row for this list yet, oldest first, at
//    most perList. The pair (watchlist_id, advisory_id) is the key whatever the
//    cursor: a backfill that moves an advisory to a new cursor finds its row
//    (NOT EXISTS) and is not queued again. INSERT OR IGNORE on the primary key
//    is the backstop; RETURNING gives only the new rows.
//    An advisory published before ageCutoff gets a 'skipped' row (backfill
//    history, docs/BACKFILL.md) and no message, unless KEV flagged it after
//    ageCutoff (exploited_at): a KEV flag on an old CVE is news, and an
//    exploited_only list sees the advisory first at that flag.
// 2. Move the list cursor to the highest cursor of the same scan. The scan is
//    run again inside the transaction, so it sees the same rows; it is not read
//    from deliveries.cursor, because a backfill can give an advisory that
//    already has a row a new, higher feed cursor. It has no NOT EXISTS, so it
//    never passes a new row the insert did not take (the insert's page of new
//    rows holds every new row in the cursor scan's page).
export function buildEnqueueStatements(
  f: WatchlistFilter,
  listId: string,
  since: number,
  perList: number,
  ageCutoff: string,
  nowIso: string,
): { insertSql: string; insertParams: unknown[]; cursorSql: string; cursorParams: unknown[] } {
  const { where, params } = watchlistWhere(f, since);
  const filter = `FROM advisories WHERE ${where.join(" AND ")}`;
  const scan = `${filter} ORDER BY cursor LIMIT ?`;
  const fresh = `${filter} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.watchlist_id = ? AND d.advisory_id = advisories.id) ORDER BY cursor LIMIT ?`;
  return {
    insertSql: `INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at)
      SELECT ?, id, cursor, 0, CASE WHEN published_at < ? AND (exploited_at IS NULL OR exploited_at < ?) THEN 'skipped' ELSE 'pending' END, ? ${fresh}
      RETURNING advisory_id, status`,
    insertParams: [listId, ageCutoff, ageCutoff, nowIso, ...params, listId, perList],
    cursorSql: `UPDATE watchlists SET cursor = MAX(cursor, COALESCE((SELECT MAX(cursor) FROM (SELECT cursor ${scan})), cursor))
      WHERE id = ? AND delivery = 'webhook'`,
    cursorParams: [...params, perList, listId],
  };
}

export interface EnqueueResult {
  lists: number;
  inserted: number;
  skipped: number;
  sent: number;
  send_errors: number;
  list_errors: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Runs after each ingest run. Finds webhook lists, inserts their new deliveries
// rows, sends one queue message per new pending row and moves each list cursor.
// The row commits BEFORE the send; a lost send leaves the row pending, and
// sweepDeliveries sends it after webhooks.sweep_grace_seconds.
export async function enqueueDeliveries(env: Env, now: Date): Promise<EnqueueResult> {
  const [maxLists, perListRaw, maxAgeDays, after] = await Promise.all([
    getSettingInt(env.DB, "webhooks.enqueue_max_lists", FALLBACK_ENQUEUE_MAX_LISTS),
    getSettingInt(env.DB, "webhooks.enqueue_per_list", FALLBACK_ENQUEUE_PER_LIST),
    getSettingInt(env.DB, "webhooks.max_event_age_days", FALLBACK_MAX_EVENT_AGE_DAYS),
    env.CURSORS.get(ENQUEUE_AFTER_KEY),
  ]);
  let perList = perListRaw;
  if (perList > QUEUE_SEND_BATCH_MAX) {
    console.error(JSON.stringify({ lane: "enqueue", err: `webhooks.enqueue_per_list=${perList} is over the sendBatch limit, using ${QUEUE_SEND_BATCH_MAX}` }));
    perList = QUEUE_SEND_BATCH_MAX;
  }
  const res: EnqueueResult = { lists: 0, inserted: 0, skipped: 0, sent: 0, send_errors: 0, list_errors: 0 };
  if (maxLists < 1 || perList < 1) {
    console.error(JSON.stringify({ lane: "enqueue", err: `knobs out of range: enqueue_max_lists=${maxLists}, enqueue_per_list=${perList}` }));
    return res;
  }

  const { results: lists } = await env.DB.prepare(WEBHOOK_LISTS_SQL)
    .bind(after ?? "", maxLists)
    .all<{ id: string; filter_json: string; cursor: number; created_at: string }>();
  const nowIso = now.toISOString();

  // Sequential on purpose: each list is one D1 transaction, and D1 runs one
  // statement at a time anyway. The loop is bounded by enqueue_max_lists.
  for (const list of lists) {
    res.lists += 1;
    let fresh: DeliveryMessage[];
    try {
      const filter = JSON.parse(list.filter_json) as WatchlistFilter;
      const created = Date.parse(list.created_at);
      const ageCutoff = new Date((Number.isNaN(created) ? now.getTime() : created) - maxAgeDays * 86_400_000).toISOString();
      const s = buildEnqueueStatements(filter, list.id, list.cursor, perList, ageCutoff, nowIso);
      const [ins] = await env.DB.batch([
        env.DB.prepare(s.insertSql).bind(...s.insertParams),
        env.DB.prepare(s.cursorSql).bind(...s.cursorParams),
      ]);
      const rows = ins.results as Array<{ advisory_id: string; status: string }>;
      res.inserted += rows.length;
      fresh = rows.filter((r) => r.status === "pending").map((r) => ({ watchlist_id: list.id, advisory_id: r.advisory_id }));
      res.skipped += rows.length - fresh.length;
    } catch (err) {
      res.list_errors += 1;
      console.error(JSON.stringify({ lane: "enqueue", watchlist_id: list.id, err: errText(err) }));
      continue;
    }
    if (fresh.length === 0) continue;
    try {
      await env.DELIVERIES.sendBatch(fresh.map((body) => ({ body })));
      res.sent += fresh.length;
    } catch (err) {
      res.send_errors += 1;
      console.error(JSON.stringify({ lane: "enqueue", watchlist_id: list.id, rows: fresh.length, err: `send failed, the sweep re-sends: ${errText(err)}` }));
    }
  }

  // A full page: the next run starts after the last list. A short page: the
  // rotation wraps to the first list.
  const nextAfter = lists.length === maxLists ? lists[lists.length - 1].id : "";
  if (nextAfter !== (after ?? "")) await env.CURSORS.put(ENQUEUE_AFTER_KEY, nextAfter);

  console.log(JSON.stringify({ lane: "enqueue", ...res }));
  return res;
}

export interface SweepResult {
  pending: number;
  sending: number;
  sent: number;
  send_errors: number;
}

// Re-sends the queue message of rows whose message was lost: a pending row
// due more than webhooks.sweep_grace_seconds ago, and a sending row whose lease
// ended (its consumer died). It never changes a row; the consumer's claim
// decides whether a message makes an HTTP call.
export async function sweepDeliveries(env: Env, now: Date): Promise<SweepResult> {
  const [grace, batch] = await Promise.all([
    getSettingInt(env.DB, "webhooks.sweep_grace_seconds", FALLBACK_SWEEP_GRACE_SECONDS),
    getSettingInt(env.DB, "webhooks.sweep_batch", FALLBACK_SWEEP_BATCH),
  ]);
  const res: SweepResult = { pending: 0, sending: 0, sent: 0, send_errors: 0 };
  if (batch < 1) {
    console.error(JSON.stringify({ lane: "sweep", err: `knob out of range: sweep_batch=${batch}` }));
    return res;
  }
  const pendingCutoff = new Date(now.getTime() - grace * 1000).toISOString();
  const [pending, sending] = await Promise.all([
    env.DB.prepare(SWEEP_SQL).bind("pending", pendingCutoff, batch).all<DeliveryMessage>(),
    env.DB.prepare(SWEEP_SQL).bind("sending", now.toISOString(), batch).all<DeliveryMessage>(),
  ]);
  res.pending = pending.results.length;
  res.sending = sending.results.length;
  const all = [...pending.results, ...sending.results].map((r) => ({ watchlist_id: r.watchlist_id, advisory_id: r.advisory_id }));
  for (let i = 0; i < all.length; i += QUEUE_SEND_BATCH_MAX) {
    const chunk = all.slice(i, i + QUEUE_SEND_BATCH_MAX);
    try {
      await env.DELIVERIES.sendBatch(chunk.map((body) => ({ body })));
      res.sent += chunk.length;
    } catch (err) {
      res.send_errors += 1;
      console.error(JSON.stringify({ lane: "sweep", rows: chunk.length, err: errText(err) }));
    }
  }
  if (all.length) console.log(JSON.stringify({ lane: "sweep", ...res }));
  return res;
}
