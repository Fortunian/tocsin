-- TCS-83: the mail send caps of POST /v1/keys (per IP per hour, per email per
-- hour, per UTC day) as one row per window, reserved atomically before the send.
CREATE TABLE IF NOT EXISTS send_counters (
  window_key TEXT PRIMARY KEY,   -- 'ip:<ip>:<hour>' | 'em:<sha256 of the email>:<hour>' | 'day:<YYYY-MM-DD>'
  n INTEGER NOT NULL DEFAULT 0,  -- mails reserved in this window
  created_at TEXT NOT NULL       -- ISO time of the first reserve; the retention clock
);
-- The daily retention delete and its dry-run count (src/cron/send-counters-retention.ts).
CREATE INDEX IF NOT EXISTS idx_send_counters_created_at ON send_counters (created_at);
-- Daily retention: send_counters rows created more than this many days ago are deleted.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.send_counters_days', '2');
-- Daily retention: most send_counters rows deleted in one run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.send_counters_batch', '5000');
-- Daily retention: 0 deletes; any other value counts and deletes nothing.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.send_counters_dry_run', '0');
