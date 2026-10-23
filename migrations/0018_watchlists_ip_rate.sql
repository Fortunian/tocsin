-- TCS-66: per-IP limit before API-key auth. One settings row. Additive only.
-- INSERT OR IGNORE keeps a re-run safe and never overwrites an edited value.

-- Calls per client IP per minute, shared by /v1/watchlists/* and /v1/keys,
-- counted before requireApiKey (KV rl:v1:auth:<ip>:<minute>, TTL 120 s).
INSERT OR IGNORE INTO settings (key, value) VALUES ('watchlists.ip_rate_per_minute', '300');

-- Seconds one isolate keeps the limit above in memory, so a refused request
-- makes no D1 read. 0 turns the memo off; an edit to the limit applies within
-- this many seconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('watchlists.ip_rate_cache_seconds', '60');
