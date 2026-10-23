-- TCS-8 review round 2: two settings rows. Additive only.
-- INSERT OR IGNORE keeps a re-run safe and never overwrites an edited value.

-- Calls per API key per minute, shared by every /v1/watchlists route.
INSERT OR IGNORE INTO settings (key, value) VALUES ('watchlists.key_rate_per_minute', '120');
-- POST /v1/keys body cap in bytes.
INSERT OR IGNORE INTO settings (key, value) VALUES ('keys.max_body_bytes', '4096');
