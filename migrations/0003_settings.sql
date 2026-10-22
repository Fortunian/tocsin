-- Key/value settings: limits and knobs the app reads at run time (CLAUDE.md rule 5).
-- Additive only. Retention: docs/RETENTION.md.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- Anonymous feed reads per IP per minute. INSERT OR IGNORE keeps a re-run safe
-- and never overwrites an edited value.
INSERT OR IGNORE INTO settings (key, value) VALUES ('feed.anon_rate_per_minute', '60');

-- Feed filtered by exploited: WHERE exploited = 1 AND cursor > ? ORDER BY cursor.
CREATE INDEX IF NOT EXISTS idx_advisories_exploited_cursor ON advisories (exploited, cursor);
-- Feed filtered by min_severity: WHERE severity_label IN (...) AND cursor > ? ORDER BY cursor.
CREATE INDEX IF NOT EXISTS idx_advisories_severity_cursor ON advisories (severity_label, cursor);
