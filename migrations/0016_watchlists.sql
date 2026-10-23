-- API keys, plans and watch lists. Additive only. Retention: docs/RETENTION.md.
-- INSERT OR IGNORE keeps a re-run safe and never overwrites an edited value.

-- Plan limits (CLAUDE.md rule 5). One row at launch; a second plan is a row.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  max_watchlists INTEGER NOT NULL,
  webhooks INTEGER NOT NULL,
  max_components INTEGER NOT NULL
);
INSERT OR IGNORE INTO plans (id, max_watchlists, webhooks, max_components) VALUES ('free', 25, 1, 2000);

-- One key per email. Only the sha256 of the key is stored. A new key gets its
-- plan from this column default.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
-- Auth lookup: WHERE key_hash = ?.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
-- One key per email: INSERT ... ON CONFLICT(email) DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys (email);
-- Retention: WHERE last_used_at < ? ORDER BY last_used_at, id LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_api_keys_last_used_at ON api_keys (last_used_at, id);

-- One row per watch list. cursor is the newest feed cursor the list has
-- answered. delivery/webhook_url/webhook_secret are for webhook delivery (#11).
CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  delivery TEXT NOT NULL DEFAULT 'poll',
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at TEXT NOT NULL
);
-- List, count and delete by key: WHERE key_id = ? [ORDER BY created_at, id].
CREATE INDEX IF NOT EXISTS idx_watchlists_key_id ON watchlists (key_id, created_at, id);

-- Anonymous POST /v1/keys per IP per minute.
INSERT OR IGNORE INTO settings (key, value) VALUES ('keys.anon_rate_per_minute', '5');
-- auth moves api_keys.last_used_at forward at most once per this many seconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('auth.last_used_resolution_seconds', '86400');
-- POST /v1/watchlists body cap in bytes.
INSERT OR IGNORE INTO settings (key, value) VALUES ('watchlists.max_body_bytes', '1048576');
-- Monthly retention: a key unused for this many days is deleted with its lists.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.api_key_unused_days', '365');
-- Monthly retention: most keys deleted in one run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.api_keys_batch', '5000');
-- Monthly retention: 0 deletes; any other value counts and deletes nothing.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.api_keys_dry_run', '0');
