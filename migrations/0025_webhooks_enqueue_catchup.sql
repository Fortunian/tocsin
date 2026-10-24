-- TCS-82 item 1: enqueue catch-up after a cursor flood. Additive only.
-- Retention: docs/RETENTION.md (settings rows change in place; no growth).

-- Most new rows per list per enqueue run. The queue messages go out in
-- sendBatch calls of 100 (a platform limit), so a value over 100 is used as is
-- (0021 read it as at most 100). Only the shipped value changes, so an edited
-- row keeps its value.
UPDATE settings SET value = '1000' WHERE key = 'webhooks.enqueue_per_list' AND value = '100';
-- Most matching advisories one enqueue run reads above a list cursor. The
-- cursor passes rows that already have a deliveries row (a backfill
-- re-cursor) within this window in SQL; a longer flood drains over more runs.
-- A value under webhooks.enqueue_per_list is read as enqueue_per_list.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.enqueue_scan_rows', '100000');
-- A webhook list whose cursor is more than this many matching rows behind
-- after an enqueue run logs one alert line ({"lane":"enqueue","alert":"lag"}).
-- 0 turns the check off.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.lag_alert_rows', '5000');
