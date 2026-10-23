-- Webhook delivery health (TCS-11 round 2). Additive only. Retention: docs/RETENTION.md.

-- Per watch list. consecutive_failures counts failed webhook attempts in a
-- row; a 2xx resets it to 0. When it reaches settings.webhooks.pause_after_failures
-- the consumer sets paused_at: enqueue, the sweep and the consumer's claim then
-- skip the list until POST /v1/watchlists/:id/resume (or a PATCH to a new URL)
-- clears it. last_delivery_at and last_delivery_code describe the last attempt
-- (code NULL when there was no HTTP answer).
ALTER TABLE watchlists ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlists ADD COLUMN paused_at TEXT;
ALTER TABLE watchlists ADD COLUMN last_delivery_at TEXT;
ALTER TABLE watchlists ADD COLUMN last_delivery_code INTEGER;

-- Per delivery: why the last attempt failed without an HTTP status
-- (blocked_host, dns_failed, network). NULL after a 2xx or an HTTP answer.
ALTER TABLE deliveries ADD COLUMN last_error TEXT;

-- Failed attempts in a row that pause a webhook list.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.pause_after_failures', '10');
-- Seconds a DNS over HTTPS answer for a webhook host is cached in KV.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.dns_cache_seconds', '600');
