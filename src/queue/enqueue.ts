import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";
import type { WatchlistFilter } from "../watchlists/filter";
import { watchlistWhere } from "../watchlists/query";

// Code fallbacks only. The live values are the settings rows
// webhooks.enqueue_max_lists, webhooks.max_event_age_days,
// webhooks.sweep_grace_seconds, webhooks.sweep_batch
// (migrations/0021_deliveries.sql), webhooks.enqueue_per_list,
// webhooks.enqueue_scan_rows and webhooks.lag_alert_rows
// (migrations/0025_webhooks_enqueue_catchup.sql).
export const FALLBACK_ENQUEUE_MAX_LISTS = 1000;
export const FALLBACK_ENQUEUE_PER_LIST = 1000;
export const FALLBACK_ENQUEUE_SCAN_ROWS = 100_000;
export const FALLBACK_LAG_ALERT_ROWS = 5000;
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

// The three statements one list runs in one transaction (env.DB.batch), in
// this order. A fresh advisory has no deliveries row for this list. An aged
// advisory was published before ageCutoff and has no KEV flag after it
// (exploited_at): backfill history (docs/BACKFILL.md). It gets a 'skipped' row
// and no message. A KEV flag on an old CVE is news, so that advisory is not
// aged, and an exploited_only list sees it first at that flag. Only fresh,
// not-aged advisories (to send) count against perList.
// 1. Move the list cursor. The window is the first scanRows advisories above
//    the cursor that match the filter; `end` is its last cursor. `stop` is the
//    cursor of the perList-th advisory to send in the window, or NULL when the
//    window holds fewer. The cursor moves to `stop`, else to `end`. So it
//    passes, in SQL, every advisory that already has a row and every aged
//    advisory (a backfill or re-cursor of 50,000 rows costs one run), and
//    never passes an advisory that statement 2 or 3 does not take. It runs
//    first, so it sees the deliveries rows from before this run.
// 2. Insert a 'skipped' row for each fresh aged advisory in the window up to
//    `stop` (else `end`). No RETURNING: the run reads the count from
//    meta.changes, so a big backfill sends no rows back to the Worker.
// 3. Insert a 'pending' row for each fresh advisory to send in the window,
//    oldest first, at most perList: exactly the ones up to `stop`. RETURNING
//    gives only the new rows.
// since is a bound parameter, so the cursor move of statement 1 does not
// change what statements 2 and 3 scan. Statement 2 writes only aged rows, so
// it does not change which rows statement 3 counts. The pair (watchlist_id,
// advisory_id) is the key whatever the cursor: a backfill that moves an
// advisory to a new cursor finds its row (NOT EXISTS) and is not queued
// again. INSERT OR IGNORE on the primary key is the backstop.
// Each statement reads at most scanRows index entries of advisories, plus one
// primary-key probe of deliveries per entry.
export function buildEnqueueStatements(
  f: WatchlistFilter,
  listId: string,
  since: number,
  perList: number,
  ageCutoff: string,
  nowIso: string,
  scanRows: number = FALLBACK_ENQUEUE_SCAN_ROWS,
): {
  insertSql: string;
  insertParams: unknown[];
  skippedSql: string;
  skippedParams: unknown[];
  cursorSql: string;
  cursorParams: unknown[];
} {
  const { where, params } = watchlistWhere(f, since);
  const filter = `FROM advisories WHERE ${where.join(" AND ")}`;
  const end = `(SELECT MAX(cursor) FROM (SELECT cursor ${filter} ORDER BY cursor LIMIT ?))`;
  const endParams = [...params, scanRows];
  const fresh = `${filter} AND cursor <= ${end} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.watchlist_id = ? AND d.advisory_id = advisories.id)`;
  const freshParams = [...params, ...endParams, listId];
  // A NULL published_at is not aged (it is sent), as before.
  const aged = "COALESCE(published_at < ? AND (exploited_at IS NULL OR exploited_at < ?), 0)";
  const toSend = `${fresh} AND NOT ${aged}`;
  const toSendParams = [...freshParams, ageCutoff, ageCutoff];
  const stop = `(SELECT cursor ${toSend} ORDER BY cursor LIMIT 1 OFFSET ?)`;
  const stopParams = [...toSendParams, perList - 1];
  return {
    skippedSql: `INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at)
      SELECT ?, id, cursor, 0, 'skipped', ? ${fresh} AND ${aged} AND cursor <= COALESCE(${stop}, ${end})`,
    skippedParams: [listId, nowIso, ...freshParams, ageCutoff, ageCutoff, ...stopParams, ...endParams],
    insertSql: `INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at)
      SELECT ?, id, cursor, 0, 'pending', ? ${toSend} ORDER BY cursor LIMIT ?
      RETURNING advisory_id, status`,
    insertParams: [listId, nowIso, ...toSendParams, perList],
    cursorSql: `UPDATE watchlists SET cursor = MAX(cursor, COALESCE(${stop}, ${end}, cursor))
      WHERE id = ? AND delivery = 'webhook' RETURNING cursor`,
    cursorParams: [...stopParams, ...endParams, listId],
  };
}

// The lag of a list: the matching advisories above its cursor, counted up to
// cap (a bounded read, served by the same cursor index as the feed).
export function buildLagCountStatement(f: WatchlistFilter, cursor: number, cap: number): { sql: string; params: unknown[] } {
  const { where, params } = watchlistWhere(f, cursor);
  return { sql: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM advisories WHERE ${where.join(" AND ")} LIMIT ?)`, params: [...params, cap] };
}

export interface EnqueueResult {
  lists: number;
  inserted: number;
  skipped: number;
  sent: number;
  send_errors: number;
  list_errors: number;
  // Lists still more than webhooks.lag_alert_rows rows behind after this run.
  lagging_lists: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Runs after each ingest run. Finds webhook lists, inserts their new deliveries
// rows, sends one queue message per new pending row and moves each list cursor.
// The row commits BEFORE the send; a lost send leaves the row pending, and
// sweepDeliveries sends it after webhooks.sweep_grace_seconds.
export async function enqueueDeliveries(env: Env, now: Date): Promise<EnqueueResult> {
  const [maxLists, perList, scanRowsRaw, lagAlert, maxAgeDays, after] = await Promise.all([
    getSettingInt(env.DB, "webhooks.enqueue_max_lists", FALLBACK_ENQUEUE_MAX_LISTS),
    getSettingInt(env.DB, "webhooks.enqueue_per_list", FALLBACK_ENQUEUE_PER_LIST),
    getSettingInt(env.DB, "webhooks.enqueue_scan_rows", FALLBACK_ENQUEUE_SCAN_ROWS),
    getSettingInt(env.DB, "webhooks.lag_alert_rows", FALLBACK_LAG_ALERT_ROWS),
    getSettingInt(env.DB, "webhooks.max_event_age_days", FALLBACK_MAX_EVENT_AGE_DAYS),
    env.CURSORS.get(ENQUEUE_AFTER_KEY),
  ]);
  const res: EnqueueResult = { lists: 0, inserted: 0, skipped: 0, sent: 0, send_errors: 0, list_errors: 0, lagging_lists: 0 };
  if (maxLists < 1 || perList < 1) {
    console.error(JSON.stringify({ lane: "enqueue", err: `knobs out of range: enqueue_max_lists=${maxLists}, enqueue_per_list=${perList}` }));
    return res;
  }
  // A window smaller than the per-run cap could never fill the cap.
  let scanRows = scanRowsRaw;
  if (scanRows < perList) {
    console.error(JSON.stringify({ lane: "enqueue", err: `webhooks.enqueue_scan_rows=${scanRows} is under webhooks.enqueue_per_list=${perList}, using ${perList}` }));
    scanRows = perList;
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
    let filter: WatchlistFilter;
    let cursor: number;
    try {
      filter = JSON.parse(list.filter_json) as WatchlistFilter;
      const created = Date.parse(list.created_at);
      const ageCutoff = new Date((Number.isNaN(created) ? now.getTime() : created) - maxAgeDays * 86_400_000).toISOString();
      const s = buildEnqueueStatements(filter, list.id, list.cursor, perList, ageCutoff, nowIso, scanRows);
      const [moved, skip, ins] = await env.DB.batch([
        env.DB.prepare(s.cursorSql).bind(...s.cursorParams),
        env.DB.prepare(s.skippedSql).bind(...s.skippedParams),
        env.DB.prepare(s.insertSql).bind(...s.insertParams),
      ]);
      cursor = (moved.results[0] as { cursor: number } | undefined)?.cursor ?? list.cursor;
      const rows = ins.results as Array<{ advisory_id: string; status: string }>;
      const skipped = skip.meta.changes ?? 0;
      res.inserted += rows.length + skipped;
      res.skipped += skipped;
      fresh = rows.map((r) => ({ watchlist_id: list.id, advisory_id: r.advisory_id }));
    } catch (err) {
      res.list_errors += 1;
      console.error(JSON.stringify({ lane: "enqueue", watchlist_id: list.id, err: errText(err) }));
      continue;
    }
    // Cloudflare Queues takes at most 100 messages per sendBatch call. A
    // failed chunk leaves its rows pending; the sweep sends them.
    for (let i = 0; i < fresh.length; i += QUEUE_SEND_BATCH_MAX) {
      const chunk = fresh.slice(i, i + QUEUE_SEND_BATCH_MAX);
      try {
        await env.DELIVERIES.sendBatch(chunk.map((body) => ({ body })));
        res.sent += chunk.length;
      } catch (err) {
        res.send_errors += 1;
        console.error(JSON.stringify({ lane: "enqueue", watchlist_id: list.id, rows: chunk.length, err: `send failed, the sweep re-sends: ${errText(err)}` }));
      }
    }
    if (lagAlert > 0) {
      try {
        const lag = buildLagCountStatement(filter, cursor, lagAlert + 1);
        const r = await env.DB.prepare(lag.sql).bind(...lag.params).first<{ n: number }>();
        if (r && r.n > lagAlert) {
          res.lagging_lists += 1;
          // The count stops at lag_alert_rows + 1, so the lag is at least n.
          console.error(JSON.stringify({ lane: "enqueue", alert: "lag", watchlist_id: list.id, lag_rows_at_least: r.n, lag_alert_rows: lagAlert }));
        }
      } catch (err) {
        console.error(JSON.stringify({ lane: "enqueue", watchlist_id: list.id, err: `lag count failed: ${errText(err)}` }));
      }
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
