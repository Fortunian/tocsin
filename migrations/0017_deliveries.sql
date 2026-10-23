-- Webhook deliveries (TCS-11). Additive only. Retention: docs/RETENTION.md.
-- INSERT OR IGNORE keeps a re-run safe and never overwrites an edited value.

-- One row per (watch list, advisory). The primary key is the exactly-once
-- gate: enqueue inserts with INSERT OR IGNORE, so a pair is queued once.
-- status: pending | sending | delivered | failed | skipped.
-- next_at: pending = due time; sending = lease end; failed and skipped = time
-- of the last write (the retention clock of those rows).
CREATE TABLE IF NOT EXISTS deliveries (
  watchlist_id TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_code INTEGER,
  next_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (watchlist_id, advisory_id)
);
-- Sweep: WHERE status = ? AND next_at <= ? ORDER BY next_at LIMIT ?.
-- Failed and skipped retention: WHERE status = ? AND next_at < ? LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_deliveries_status_next_at ON deliveries (status, next_at);
-- Delivered retention: WHERE status = 'delivered' AND delivered_at < ? LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_deliveries_status_delivered_at ON deliveries (status, delivered_at);
-- GET /v1/watchlists/:id/deliveries: WHERE watchlist_id = ? ORDER BY cursor DESC LIMIT ?.
-- Enqueue cursor high-water mark: SELECT MAX(cursor) WHERE watchlist_id = ?.
CREATE INDEX IF NOT EXISTS idx_deliveries_watchlist_cursor ON deliveries (watchlist_id, cursor);
-- Enqueue: WHERE delivery = 'webhook' AND id > ? ORDER BY id LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_watchlists_delivery ON watchlists (delivery, id);

-- Retry delays in seconds after the 1st..5th failed attempt. The attempt after
-- the last delay that fails marks the row failed (6 attempts in total).
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.backoff_seconds', '60,300,1800,7200,43200');
-- One webhook POST times out after this many milliseconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.timeout_ms', '10000');
-- A claimed (sending) row is held for this many seconds, then any consumer may claim it again.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.lease_seconds', '60');
-- The sweep re-sends a pending row this many seconds after it was due.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.sweep_grace_seconds', '600');
-- Most rows the sweep re-sends per status per cron run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.sweep_batch', '500');
-- Most webhook lists one enqueue run reads; the rest wait for the next run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.enqueue_max_lists', '1000');
-- Most new rows per list per enqueue run. Values over 100 (the queue sendBatch limit) are read as 100.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.enqueue_per_list', '100');
-- An advisory published this many days before the list was made gets a skipped row, not a POST (backfill, docs/BACKFILL.md).
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.max_event_age_days', '30');
-- Longest webhook_url accepted, in characters.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.max_url_length', '2048');
-- Rows answered by GET /v1/watchlists/:id/deliveries (1..100).
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.deliveries_list_limit', '100');
-- Daily retention: delivered, failed and skipped rows older than this many days are deleted.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.deliveries_days', '90');
-- Daily retention: most rows of each status deleted in one run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.deliveries_batch', '5000');
-- Daily retention: 0 deletes; any other value counts and deletes nothing.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.deliveries_dry_run', '0');
