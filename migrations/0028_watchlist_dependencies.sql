-- TCS-37: watch a lockfile. Additive only. Retention: docs/RETENTION.md.
-- INSERT OR IGNORE keeps a re-run safe and never overwrites an edited value.

-- The stored dependency set of a watch list (POST /v1/watchlists/:id/lockfile).
-- ecosystem and name are the lookup key, as /v1/check groups advisories: the
-- base ecosystem (Debian:12 -> Debian) and the PEP 503 name for PyPI/python.
-- dep_ecosystem, dep_name and version are the dependency as parsed (the
-- matcher input). Rows are deleted with the list (DELETE route, key retention).
CREATE TABLE IF NOT EXISTS watchlist_dependencies (
  watchlist_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  dep_ecosystem TEXT NOT NULL,
  dep_name TEXT NOT NULL,
  version TEXT NOT NULL
);
-- Replace, count and delete by list: WHERE watchlist_id = ?. Also the natural
-- key, so a list never holds one dependency twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_dependencies_watchlist ON watchlist_dependencies (watchlist_id, dep_ecosystem, dep_name, version);
-- Match read: WHERE (ecosystem, name) IN (json_each(?)).
CREATE INDEX IF NOT EXISTS idx_watchlist_dependencies_ecosystem_name ON watchlist_dependencies (ecosystem, name);

-- One row per match lane: the last advisory cursor the dependency match pass
-- has read (src/queue/dependency-match.ts). One row; it does not grow.
CREATE TABLE IF NOT EXISTS match_cursors (
  lane TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO match_cursors (lane, cursor, updated_at)
  SELECT 'dependencies', COALESCE(MAX(cursor), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM advisories;

-- Per watch list: the stored dependency count, the feed cursor of the upload
-- check (advisories at or below it were in the upload answer and are never
-- sent) and the upload time (the age anchor of the match pass).
ALTER TABLE watchlists ADD COLUMN dependency_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlists ADD COLUMN dependencies_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlists ADD COLUMN dependencies_at TEXT;
-- Per delivery of a dependency list: the affected items sent with the advisory.
-- NULL for a filter list (the body is the advisory alone).
ALTER TABLE deliveries ADD COLUMN affected_json TEXT;
-- Plan limit (CLAUDE.md rule 5): most dependencies one watch list stores.
ALTER TABLE plans ADD COLUMN max_watch_dependencies INTEGER;
UPDATE plans SET max_watch_dependencies = 2000 WHERE id = 'free' AND max_watch_dependencies IS NULL;

-- Most advisories one dependency match pass reads above the lane cursor; a
-- longer flood drains over more cron runs.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.dependency_scan_rows', '2000');
-- Rows per INSERT statement (one JSON parameter) when a dependency set or the
-- deliveries rows of a pass are written.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.dependency_insert_chunk', '500');
