-- Knobs for the landing page's Latest table (CLAUDE.md rule 5). Additive only:
-- two settings rows, no new table. Retention: docs/RETENTION.md. INSERT OR
-- IGNORE keeps a re-run safe and never overwrites an edited value.
-- Rows in the Latest table (1..100).
INSERT OR IGNORE INTO settings (key, value) VALUES ('site.latest_rows', '10');
-- Seconds the Latest rows stay cached in KV (KV accepts 60 or more).
INSERT OR IGNORE INTO settings (key, value) VALUES ('site.latest_cache_seconds', '60');
