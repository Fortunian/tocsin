-- Limits for /v1/check (CLAUDE.md rule 5). Additive only: two settings rows,
-- no new table. Retention: docs/RETENTION.md. INSERT OR IGNORE keeps a re-run
-- safe and never overwrites an edited value.
-- Anonymous checks per IP per minute.
INSERT OR IGNORE INTO settings (key, value) VALUES ('check.anon_rate_per_minute', '20');
-- POST body cap in bytes (2 MB).
INSERT OR IGNORE INTO settings (key, value) VALUES ('check.max_body_bytes', '2097152');
